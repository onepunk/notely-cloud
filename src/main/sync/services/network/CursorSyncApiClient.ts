/**
 * CursorSyncApiClient - HTTP client for cursor-based sync protocol
 *
 * Handles communication with POST /api/sync endpoint using cursor-based protocol.
 *
 * References:
 * - SYNC_JOPLIN.md#L262 (API shape)
 * - SYNC_JOPLIN_PHASE0_SPEC.md Section 9 (Idempotency)
 */

import { logger } from '../../../logger';
import { pinnedFetch } from '../../../services/security';
import type {
  CursorSyncRequest,
  CursorSyncResponse,
  CursorSyncConfiguration,
} from '../../core/protocol/cursor-sync-types';

/**
 * Configuration for CursorSyncApiClient
 */
export interface CursorApiClientConfig {
  /** Full sync endpoint URL (e.g., https://api.yourdomain.com/api/sync) */
  syncServiceUrl: string;
  /** Access token for Bearer authentication */
  accessToken: string;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Device ID for X-Device-Id header */
  deviceId: string;
}

/**
 * HTTP client for cursor-based sync API
 */
export class CursorSyncApiClient {
  private config: CursorApiClientConfig;

  constructor(config: CursorApiClientConfig) {
    this.config = config;

    logger.info('[CursorSync] API client initialized', {
      syncServiceUrl: this.config.syncServiceUrl,
      hasAccessToken: !!this.config.accessToken,
      deviceId: this.config.deviceId,
    });
  }

  /**
   * Update client configuration (e.g., after token refresh)
   */
  updateConfiguration(config: Partial<CursorApiClientConfig>): void {
    this.config = { ...this.config, ...config };

    logger.debug('[CursorSync] API client configuration updated', {
      syncServiceUrl: this.config.syncServiceUrl,
      hasAccessToken: !!this.config.accessToken,
    });
  }

  /**
   * Execute sync request
   *
   * POST /api/sync
   * Handles both push (sending local changes) and pull (receiving server changes)
   *
   * @param request - Sync request payload
   * @param runId - Optional request ID for tracing
   * @returns Sync response from server
   */
  async sync(request: CursorSyncRequest, runId?: string): Promise<CursorSyncResponse> {
    const url = this.config.syncServiceUrl;

    const headers = this.buildHeaders(runId);

    logger.info('[CursorSync] Sending sync request', {
      url,
      deviceId: request.device_id,
      cursor: request.cursor,
      pushCount: request.push.length,
      limit: request.limit,
      hasSnapshotToken: !!request.snapshot_token,
    });

    // Log push details for debugging
    if (request.push.length > 0) {
      const pushSummary = request.push.reduce(
        (acc, item) => {
          acc[item.entity_type] = (acc[item.entity_type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      logger.debug('[CursorSync] Push payload summary', {
        counts: pushSummary,
        operations: request.push.map((p) => ({
          type: p.entity_type,
          id: p.entity_id.slice(0, 8),
          op: p.op,
          baseVersion: p.base_version,
        })),
      });
    }

    let response: Response;
    try {
      response = await pinnedFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      // Extract network error details
      const networkError =
        error instanceof TypeError && 'cause' in error
          ? (error.cause as Record<string, unknown>)
          : null;

      logger.error('[CursorSync] Network error', {
        url,
        error: error instanceof Error ? error.message : String(error),
        cause: networkError,
        code: networkError?.code,
        errno: networkError?.errno,
      });

      throw new Error(
        `Sync request failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Handle HTTP errors
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');

      logger.error('[CursorSync] HTTP error', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });

      // Handle specific error codes
      if (response.status === 401) {
        throw new Error('SYNC_AUTH_REQUIRED: Authentication required for sync');
      }

      if (response.status === 403) {
        throw new Error('SYNC_FORBIDDEN: Access denied');
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        throw new Error(
          `SYNC_RATE_LIMITED: Rate limited${retryAfter ? `, retry after ${retryAfter}s` : ''}`
        );
      }

      throw new Error(`Sync request failed: ${response.status} ${response.statusText}`);
    }

    // Parse response
    let data: { success: boolean; data?: CursorSyncResponse; error?: string };
    try {
      data = await response.json();
    } catch (error) {
      logger.error('[CursorSync] Failed to parse response', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Sync response parse error');
    }

    if (!data.success || !data.data) {
      logger.error('[CursorSync] Server returned error', {
        error: data.error,
      });
      throw new Error(data.error || 'Sync failed');
    }

    const syncResponse = data.data;

    // Log response summary
    logger.info('[CursorSync] Sync response received', {
      cursor: syncResponse.cursor,
      hasMore: syncResponse.has_more,
      itemCount: syncResponse.items.length,
      resultCount: syncResponse.results.length,
      requiresSnapshot: syncResponse.requires_snapshot,
      clockSuspect: syncResponse.clock_suspect,
      deviceTimeSkewMs: syncResponse.device_time_skew_ms,
    });

    // Log push results
    if (syncResponse.results.length > 0) {
      const resultSummary = syncResponse.results.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      logger.debug('[CursorSync] Push results summary', {
        counts: resultSummary,
        conflicts: syncResponse.results
          .filter((r) => r.status === 'conflict')
          .map((r) => ({
            type: r.entity_type,
            id: r.entity_id.slice(0, 8),
            reason: r.reason,
          })),
      });
    }

    // Log pull items by type
    if (syncResponse.items.length > 0) {
      const itemSummary = syncResponse.items.reduce(
        (acc, item) => {
          acc[item.entity_type] = (acc[item.entity_type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      logger.debug('[CursorSync] Pull items summary', {
        counts: itemSummary,
        seqRange: {
          min: Math.min(...syncResponse.items.map((i) => i.seq)),
          max: Math.max(...syncResponse.items.map((i) => i.seq)),
        },
      });
    }

    // Warn about clock skew
    if (syncResponse.clock_suspect) {
      logger.warn('[CursorSync] Clock skew detected!', {
        skewMs: syncResponse.device_time_skew_ms,
        serverTimeMs: syncResponse.server_time_ms,
        clientTimeMs: request.client_time_ms,
      });
    }

    return syncResponse;
  }

  /**
   * Build HTTP headers for request
   */
  private buildHeaders(runId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
      'X-Device-Id': this.config.deviceId,
    };

    if (runId) {
      headers['X-Request-Id'] = runId;
    }

    return headers;
  }

  /**
   * Create client from CursorSyncConfiguration
   */
  static fromConfiguration(config: CursorSyncConfiguration): CursorSyncApiClient {
    return new CursorSyncApiClient({
      syncServiceUrl: config.syncServiceUrl,
      accessToken: config.accessToken,
      timeoutMs: config.timeoutMs,
      deviceId: config.deviceId,
    });
  }
}
