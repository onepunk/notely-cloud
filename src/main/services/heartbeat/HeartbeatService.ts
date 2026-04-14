import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { LicenseSnapshot } from '../../../shared/types/license';
import { logger } from '../../logger';
import type { ISettingsService } from '../../storage/interfaces/ISettingsService';

const HEARTBEAT_INTERVAL_MS = 300000; // 5 minutes
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const HEARTBEAT_TIMEOUT_MS = 10000; // 10 seconds
const CLIENT_ID_STORAGE_KEY = 'heartbeat.clientId';

interface HeartbeatRequest {
  clientId: string;
  sessionToken: string;
  clientVersion: string;
  platform: string;
  organizationId: string;
}

interface HeartbeatResponse {
  success: boolean;
  data?: {
    status: 'active' | 'limit_exceeded';
    activeSessions: number;
    sessionLimit: number;
    warnings: string[];
    license?: LicenseSnapshot;
  };
}

interface HeartbeatServiceDeps {
  settings: ISettingsService;
  getAccessToken: () => Promise<string | null>;
  getOrganizationId: () => Promise<string | null>;
  getApiUrl: () => Promise<string>;
  clientVersion: string;
}

/**
 * HeartbeatService
 *
 * Manages periodic heartbeat requests to the license server for concurrent usage tracking.
 *
 * Features:
 * - Sends heartbeat every 5 minutes while user is authenticated
 * - Generates unique clientId on first run (stored persistently)
 * - Generates new sessionToken on each app startup
 * - Includes retry logic with exponential backoff
 * - Handles concurrent limit exceeded scenarios
 * - Emits events for limit exceeded conditions
 * - Manages lifecycle (start/stop/pause/resume)
 *
 * Events:
 * - 'heartbeat:limit-exceeded': Emitted when concurrent session limit is reached
 * - 'heartbeat:success': Emitted on successful heartbeat
 * - 'heartbeat:error': Emitted on heartbeat failure (after all retries)
 * - 'heartbeat:offline': Emitted when going into offline mode
 * - 'heartbeat:online': Emitted when resuming from offline mode
 * - 'heartbeat:license-changed': Emitted when license state changes (new license, expired, etc.)
 */
export class HeartbeatService extends EventEmitter {
  private intervalHandle: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isPaused = false;
  private sessionToken: string;
  private retryCount = 0;
  private retryTimeout: NodeJS.Timeout | null = null;
  private lastKnownLicenseId: string | null = null;

  constructor(private deps: HeartbeatServiceDeps) {
    super();
    // Generate session token on instantiation (once per app startup)
    this.sessionToken = crypto.randomUUID();
    logger.info('HeartbeatService: Initialized with new session token', {
      sessionToken: this.maskToken(this.sessionToken),
    });
  }

  /**
   * Start the heartbeat service
   * Should be called after successful license validation and user authentication
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('HeartbeatService: Already running, ignoring start request');
      return;
    }

    logger.info('HeartbeatService: Starting heartbeat service');
    this.isRunning = true;
    this.isPaused = false;
    this.retryCount = 0;

    // Send initial heartbeat immediately
    await this.sendHeartbeat();

    // Schedule periodic heartbeats
    this.intervalHandle = setInterval(() => {
      if (!this.isPaused) {
        void this.sendHeartbeat();
      }
    }, HEARTBEAT_INTERVAL_MS);

    logger.info('HeartbeatService: Heartbeat service started', {
      intervalMs: HEARTBEAT_INTERVAL_MS,
    });
  }

  /**
   * Stop the heartbeat service
   * Should be called on app close
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    logger.info('HeartbeatService: Stopping heartbeat service');

    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }

    this.isRunning = false;
    this.isPaused = false;
    this.retryCount = 0;

    logger.info('HeartbeatService: Heartbeat service stopped');
  }

  /**
   * Pause heartbeat (e.g., when offline)
   * Keeps the service running but skips heartbeat attempts
   */
  pause(): void {
    if (!this.isRunning || this.isPaused) {
      return;
    }

    logger.info('HeartbeatService: Pausing heartbeat service');
    this.isPaused = true;
    this.emit('heartbeat:offline');
  }

  /**
   * Resume heartbeat (e.g., when back online)
   */
  resume(): void {
    if (!this.isRunning || !this.isPaused) {
      return;
    }

    logger.info('HeartbeatService: Resuming heartbeat service');
    this.isPaused = false;
    this.retryCount = 0;
    this.emit('heartbeat:online');

    // Send heartbeat immediately when resuming
    void this.sendHeartbeat();
  }

  /**
   * Get current service status
   */
  getStatus(): {
    isRunning: boolean;
    isPaused: boolean;
    sessionToken: string;
  } {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      sessionToken: this.maskToken(this.sessionToken),
    };
  }

  /**
   * Send a heartbeat request to the server
   */
  private async sendHeartbeat(): Promise<void> {
    if (this.isPaused) {
      logger.debug('HeartbeatService: Skipping heartbeat (service paused)');
      return;
    }

    try {
      logger.debug('HeartbeatService: Sending heartbeat', {
        retryCount: this.retryCount,
        sessionToken: this.maskToken(this.sessionToken),
      });

      // Get required data
      const [clientId, accessToken, organizationId, apiUrl] = await Promise.all([
        this.getOrCreateClientId(),
        this.deps.getAccessToken(),
        this.deps.getOrganizationId(),
        this.deps.getApiUrl(),
      ]);

      // Validate prerequisites
      if (!accessToken) {
        logger.warn('HeartbeatService: No access token available, skipping heartbeat');
        return;
      }

      if (!organizationId) {
        logger.warn('HeartbeatService: No organization ID available, skipping heartbeat');
        return;
      }

      // Build request
      const request: HeartbeatRequest = {
        clientId,
        sessionToken: this.sessionToken,
        clientVersion: this.deps.clientVersion,
        platform: process.platform,
        organizationId,
      };

      const heartbeatUrl = `${apiUrl}/api/license/heartbeat`;

      logger.debug('HeartbeatService: Calling heartbeat endpoint', {
        url: heartbeatUrl,
        clientId: this.maskToken(clientId),
        sessionToken: this.maskToken(this.sessionToken),
        clientVersion: this.deps.clientVersion,
        platform: process.platform,
      });

      // Send heartbeat request
      const response = await fetch(heartbeatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
      });

      // Check HTTP status
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Rate limit exceeded');
        } else if (response.status >= 500) {
          throw new Error(`Server error (${response.status})`);
        } else if (response.status === 401) {
          throw new Error('Authentication failed');
        } else {
          throw new Error(`Heartbeat failed with status ${response.status}`);
        }
      }

      const data: HeartbeatResponse = await response.json();

      // Check response format
      if (!data.success || !data.data) {
        throw new Error('Invalid response format from heartbeat endpoint');
      }

      // Reset retry count on success
      this.retryCount = 0;

      // Check for license changes
      if (data.data.license) {
        const currentLicenseId = data.data.license.licenseId;
        if (currentLicenseId !== this.lastKnownLicenseId) {
          logger.info('HeartbeatService: License change detected', {
            previousLicenseId: this.lastKnownLicenseId,
            newLicenseId: currentLicenseId,
            hasLicense: data.data.license.hasLicense,
            status: data.data.license.status,
          });
          this.lastKnownLicenseId = currentLicenseId;
          this.emit('heartbeat:license-changed', data.data.license);
        }
      }

      // Check for concurrent limit exceeded
      if (data.data.status === 'limit_exceeded') {
        logger.warn('HeartbeatService: Concurrent session limit exceeded', {
          activeSessions: data.data.activeSessions,
          sessionLimit: data.data.sessionLimit,
          warnings: data.data.warnings,
        });

        this.emit('heartbeat:limit-exceeded', {
          activeSessions: data.data.activeSessions,
          sessionLimit: data.data.sessionLimit,
          warnings: data.data.warnings,
        });
      } else {
        logger.info('HeartbeatService: Heartbeat successful', {
          status: data.data.status,
          activeSessions: data.data.activeSessions,
          sessionLimit: data.data.sessionLimit,
        });
      }

      this.emit('heartbeat:success', {
        status: data.data.status,
        activeSessions: data.data.activeSessions,
        sessionLimit: data.data.sessionLimit,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('HeartbeatService: Heartbeat failed', {
        error: errorMessage,
        retryCount: this.retryCount,
      });

      // Handle retry logic
      if (this.retryCount < MAX_RETRY_ATTEMPTS) {
        this.retryCount++;
        const retryDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, this.retryCount - 1);

        logger.info('HeartbeatService: Scheduling retry', {
          attempt: this.retryCount,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          delayMs: retryDelay,
        });

        this.retryTimeout = setTimeout(() => {
          void this.sendHeartbeat();
        }, retryDelay);
      } else {
        // All retries exhausted - fall back to offline mode
        logger.warn('HeartbeatService: All retries exhausted, entering offline mode', {
          error: errorMessage,
        });

        this.retryCount = 0;
        this.pause();

        this.emit('heartbeat:error', {
          error: errorMessage,
          message: 'Heartbeat failed after all retry attempts',
        });
      }
    }
  }

  /**
   * Get or create a persistent client ID
   * The client ID is generated once and stored in settings
   */
  private async getOrCreateClientId(): Promise<string> {
    try {
      let clientId = await this.deps.settings.get(CLIENT_ID_STORAGE_KEY);

      if (!clientId) {
        // Generate new client ID
        clientId = `desktop-${crypto.randomUUID()}`;
        await this.deps.settings.set(CLIENT_ID_STORAGE_KEY, clientId);

        logger.info('HeartbeatService: Created new client ID', {
          clientId: this.maskToken(clientId),
        });
      }

      return clientId;
    } catch (error) {
      logger.error('HeartbeatService: Failed to get/create client ID', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to initialize client ID for heartbeat service');
    }
  }

  /**
   * Mask sensitive tokens for logging
   */
  private maskToken(token: string): string {
    if (token.length <= 8) {
      return '***';
    }
    return `${token.substring(0, 8)}...${token.substring(token.length - 4)}`;
  }
}
