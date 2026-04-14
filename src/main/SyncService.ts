import { type AuthContext, type IAuthService } from './auth';
import { getFeatureFlagService } from './config/FeatureFlagService';
import { logger } from './logger';
import { TransactionManager } from './storage/core/TransactionManager';
import { type IStorageService } from './storage/index';
import { SyncItemsService } from './storage/services/SyncItemsService';
import { CursorSyncEngine } from './sync/core/engines/CursorSyncEngine';
import type { CursorSyncConfiguration } from './sync/core/protocol/cursor-sync-types';
import { SyncVersionManager } from './sync/infrastructure/SyncVersionManager';

export class SyncService {
  [key: string]: unknown;
  private syncEngine: CursorSyncEngine | null = null;
  private syncVersionManager: SyncVersionManager;
  private syncItemsService: SyncItemsService | null = null;
  private currentAccessToken: string | null = null;
  private currentServerUrl: string | null = null;
  private featureFlagService = getFeatureFlagService();

  constructor(
    private storage: IStorageService,
    private authService: IAuthService
  ) {
    this.syncVersionManager = new SyncVersionManager(storage);

    logger.info('SyncService: Initialized (V3 Cursor-based Sync)');
  }

  private async initializeSync(authContext: AuthContext): Promise<CursorSyncEngine> {
    if (this.syncEngine) {
      return this.syncEngine;
    }

    // Load feature flags for user
    await this.featureFlagService.updateAuthContext(authContext);
    const flags = this.featureFlagService.getFlags();

    // Auth/sync decoupling: serverUrl comes ONLY from authContext, not sync config
    const serverUrl = authContext.serverUrl;
    if (!serverUrl) {
      throw new Error('Sync configuration requires server URL from auth context');
    }

    // Derive sync service URL from auth server URL (single source of truth)
    const syncServiceUrl = `${serverUrl.replace(/\/$/, '')}/api/sync`;

    logger.info('SyncService: Using V3 cursor-based sync', {
      syncServiceUrl,
      serverUrl,
    });

    const deviceId = await this.syncVersionManager.getOrCreateNodeId();
    // Phase 1: Trust canonical auth state over stale sync config
    // After logout, config.serverUserId may contain previous user - always prefer authContext
    const userId = authContext.userId || deviceId;

    // Use settings.syncEnabled as the single source of truth for sync enabled state
    const syncEnabledSetting = await this.storage.settings.get('syncEnabled');
    const syncEnabled = syncEnabledSetting === 'true';

    // Create SyncItemsService if not already created
    if (!this.syncItemsService) {
      const transactionManager = new TransactionManager(this.storage.database);
      this.syncItemsService = new SyncItemsService(this.storage.database, transactionManager);
    }

    const syncConfig: CursorSyncConfiguration = {
      serverUrl,
      userId,
      deviceId,
      deviceName: 'Desktop Client',
      accessToken: authContext.accessToken,
      enabled: syncEnabled,
      syncServiceUrl,
      maxPushBatchSize: 100,
      maxPullLimit: 500,
      timeoutMs: 30000,
    };

    logger.info('[Sync] Creating CursorSyncEngine with config', {
      serverUrl: syncConfig.serverUrl,
      syncServiceUrl: syncConfig.syncServiceUrl,
      userId: syncConfig.userId,
      deviceId: syncConfig.deviceId,
      hasAccessToken: !!syncConfig.accessToken,
      accessTokenLength: syncConfig.accessToken?.length || 0,
      accessTokenPreview: syncConfig.accessToken
        ? `${syncConfig.accessToken.substring(0, 30)}...`
        : 'MISSING',
    });

    this.syncEngine = new CursorSyncEngine(syncConfig, {
      storage: this.storage,
      syncItemsService: this.syncItemsService,
    });

    this.currentAccessToken = authContext.accessToken;
    this.currentServerUrl = serverUrl;

    logger.info('CursorSyncEngine initialized', {
      serverUrl: syncConfig.serverUrl,
      syncServiceUrl: syncConfig.syncServiceUrl,
      userId: syncConfig.userId,
      deviceId,
      featureFlags: {
        enableSyncTelemetry: flags.enableSyncTelemetry,
      },
    });

    return this.syncEngine;
  }

  private async resetSyncEngine(): Promise<void> {
    if (this.syncEngine) {
      try {
        await this.syncEngine.shutdown();
      } catch (error) {
        logger.warn('SyncService: Failed to shutdown sync engine during reset', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    this.syncEngine = null;
    this.currentAccessToken = null;
    this.currentServerUrl = null;
  }

  async sync(): Promise<{ success: boolean; error?: string; processed?: number }> {
    const logId = await this.storage.sync.logOperation('sync', 'started');
    const syncStartTime = Date.now();
    const flags = this.featureFlagService.getFlags();

    try {
      // Use settings.syncEnabled as the single source of truth for sync enabled state
      const syncEnabledSetting = await this.storage.settings.get('syncEnabled');
      if (syncEnabledSetting !== 'true') {
        await this.storage.sync.updateLogStatus(logId, 'failed', {
          errorMessage: 'Sync disabled',
        });
        return { success: false, error: 'Sync not available' };
      }

      const authContext = await this.authService.getAuthContext();
      if (!authContext) {
        await this.resetSyncEngine();
        await this.storage.sync.updateLogStatus(logId, 'failed', {
          errorMessage: 'Authentication required',
        });
        return { success: false, error: 'Authentication required for sync' };
      }

      if (
        (this.currentAccessToken && this.currentAccessToken !== authContext.accessToken) ||
        (this.currentServerUrl && this.currentServerUrl !== authContext.serverUrl)
      ) {
        logger.info('SyncService: Auth context changed, resetting sync engine');
        await this.resetSyncEngine();
      }

      const syncEngine = await this.initializeSync(authContext);

      // Log telemetry if enabled
      if (flags.enableSyncTelemetry) {
        logger.info('SyncService: Starting sync operation (V3 Microservice)', {
          userId: authContext.userId,
          serverUrl: this.currentServerUrl,
        });
      }

      const syncResult = await syncEngine.performSync();

      const syncDuration = Date.now() - syncStartTime;
      const totalEntities = syncResult.entities_pushed + syncResult.entities_pulled;

      if (syncResult.success) {
        await this.storage.sync.updateLogStatus(logId, 'completed', {
          entityCount: totalEntities,
        });

        // Note: CursorSyncEngine already updates lastPullAt/lastPushAt internally

        if (flags.enableSyncTelemetry) {
          logger.info('SyncService: Sync completed successfully (V3 Cursor-based)', {
            entitiesPushed: syncResult.entities_pushed,
            entitiesPulled: syncResult.entities_pulled,
            conflictsResolved: syncResult.conflicts_resolved,
            operation: syncResult.operation,
            newCursor: syncResult.new_cursor,
            snapshotTriggered: syncResult.snapshot_triggered,
            durationMs: syncDuration,
          });
        } else {
          logger.info('Sync: Sync completed successfully', {
            entitiesPushed: syncResult.entities_pushed,
            entitiesPulled: syncResult.entities_pulled,
            conflictsResolved: syncResult.conflicts_resolved,
          });
        }

        return {
          success: true,
          processed: totalEntities,
        };
      }

      await this.storage.sync.updateLogStatus(logId, 'failed', {
        errorMessage: syncResult.error || 'Unknown sync error',
      });

      if (flags.enableSyncTelemetry) {
        logger.error('SyncService: Sync failed', {
          error: syncResult.error,
          userMessage: syncResult.userMessage,
          durationMs: syncDuration,
        });
      }

      return {
        success: false,
        error: syncResult.error || 'Sync failed',
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const syncDuration = Date.now() - syncStartTime;

      if (flags.enableSyncTelemetry) {
        logger.error('SyncService: Sync operation failed with exception', {
          error: errorMessage,
          durationMs: syncDuration,
          stack: error instanceof Error ? error.stack : undefined,
        });
      } else {
        logger.error('Sync: Sync operation failed', {
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });
      }

      await this.storage.sync.updateLogStatus(logId, 'failed', {
        errorMessage,
      });

      return { success: false, error: errorMessage };
    }
  }

  async push(): Promise<{ success: boolean; error?: string; processed: number }> {
    const result = await this.sync();
    return {
      success: result.success,
      error: result.error,
      processed: result.processed ?? 0,
    };
  }

  async pull(): Promise<{ success: boolean; error?: string; changes: number }> {
    const result = await this.sync();
    return {
      success: result.success,
      error: result.error,
      changes: result.processed ?? 0,
    };
  }

  async getSyncStatus(): Promise<{
    isConfigured: boolean;
    isLinked: boolean;
    isEnabled: boolean;
    lastPush: number | null;
    lastPull: number | null;
    hasValidToken: boolean;
  }> {
    const [config, authStatus, syncEnabledSetting] = await Promise.all([
      this.storage.sync.getConfig(),
      this.authService.getAuthStatus(),
      this.storage.settings.get('syncEnabled'),
    ]);

    // Use canonical auth status for isLinked and hasValidToken
    // This ensures consistency with AuthService.getAuthStatus()
    // Use settings.syncEnabled as the single source of truth for sync enabled state
    return {
      isConfigured: authStatus.isConfigured,
      isLinked: authStatus.isLinked,
      isEnabled: syncEnabledSetting === 'true',
      lastPush: config?.lastPushAt || null,
      lastPull: config?.lastPullAt || null,
      hasValidToken: authStatus.hasValidAccessToken,
    };
  }
}
