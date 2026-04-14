/**
 * Cursor-based Sync IPC Handlers
 * Handles communication between renderer and main process for cursor-based sync
 */

import { ipcMain, BrowserWindow } from 'electron';

import { type IAuthService } from '../auth';
import { logger } from '../logger';
import { TransactionManager } from '../storage/core/TransactionManager';
import { IStorageService } from '../storage/interfaces/IStorageService';
import { SyncItemsService } from '../storage/services/SyncItemsService';
import { CursorSyncEngine } from '../sync/core/engines/CursorSyncEngine';
import type {
  CursorSyncConfiguration,
  CursorSyncResult,
} from '../sync/core/protocol/cursor-sync-types';
import { SyncVersionManager } from '../sync/infrastructure/SyncVersionManager';

interface SyncStatusResponse {
  version: 'cursor';
  isConfigured: boolean;
  isLinked: boolean;
  isEnabled: boolean;
  lastSync: number | null;
  hasValidToken: boolean;

  cursorStatus: {
    cursor: number;
    pendingItems: number;
    lastPushAt: number | null;
    lastPullAt: number | null;
  };

  syncProgress: {
    phase: 'idle' | 'pushing' | 'pulling' | 'applying' | 'complete';
    progress: number; // 0-100
    currentOperation: string;
    entitiesPushed?: number;
    entitiesPulled?: number;
  };

  conflicts: {
    count: number;
    recent: Array<{
      id: string;
      entityType: 'binder' | 'note' | 'transcription' | 'summary' | 'tag';
      entityId: string;
      conflictType: 'version_conflict';
      resolvedAt: number;
      resolution: string;
    }>;
  };

  retryState: {
    isRetrying: boolean;
    attemptCount: number;
    maxAttempts: number;
    nextRetryAt: number | null;
    lastError: string | null;
  };

  healthStatus: {
    avgSyncDuration: number; // ms
    successRate: number; // 0-1
    engineInitialized: boolean;
  };
}

// Legacy service interfaces for compatibility
export interface LegacySyncService {
  push?: () => Promise<{ success: boolean; processed: number }>;
  pull?: () => Promise<{ success: boolean; changes: number }>;
  [key: string]: unknown;
}

// Legacy config interface removed - auth fields no longer belong in sync config
// Use AuthService for auth-related configuration

export interface SyncHandlersDependencies {
  storage: IStorageService;
  authService: IAuthService;
  syncService?: LegacySyncService | null; // Legacy interface compatibility
  /** Callback to trigger sync via SyncLifecycleManager state machine */
  triggerSync?: (trigger: 'manual') => void;
  /** Callback to check if sync is possible */
  canSync?: () => boolean;
}

export class SyncHandlers {
  private syncEngine: CursorSyncEngine | null = null;
  private syncItemsService: SyncItemsService | null = null;
  private syncVersionManager: SyncVersionManager | null = null;
  private storage: IStorageService;
  private currentSyncProgress: SyncStatusResponse['syncProgress'];
  private conflictHistory: SyncStatusResponse['conflicts']['recent'] = [];
  private retryState: SyncStatusResponse['retryState'];
  private healthMetrics: {
    syncDurations: number[];
    successCount: number;
    totalCount: number;
  };
  private readonly authService: IAuthService;

  constructor(private deps: SyncHandlersDependencies) {
    this.storage = deps.storage;
    this.authService = deps.authService;

    // Initialize sync progress state
    this.currentSyncProgress = {
      phase: 'idle',
      progress: 0,
      currentOperation: 'Ready',
    };

    // Initialize retry state
    this.retryState = {
      isRetrying: false,
      attemptCount: 0,
      maxAttempts: 3,
      nextRetryAt: null,
      lastError: null,
    };

    // Initialize health metrics
    this.healthMetrics = {
      syncDurations: [],
      successCount: 0,
      totalCount: 0,
    };

    // Initialize engines asynchronously (don't wait)
    this.initializeEngines().catch((error) => {
      logger.error('Failed to initialize cursor sync engine during construction:', error);
    });
  }

  private async initializeEngines(): Promise<void> {
    // Backward compatibility: keep single entrypoint, but delegate to robust guard
    await this.ensureCursorSyncInitialized();
  }

  /**
   * Ensure cursor sync engine is initialized when configuration is present.
   * Safe to call repeatedly; initialization is idempotent.
   */
  private async ensureCursorSyncInitialized(): Promise<void> {
    try {
      // If already created, make sure it's initialized and return
      if (this.syncEngine) {
        try {
          await this.syncEngine.initialize();
        } catch (error) {
          logger.debug('Engine initialization attempt failed:', error);
        }
        return;
      }

      // Validate configuration (serverUrl + accessToken)
      const syncConfig = await this.getCursorSyncConfiguration();
      if (!syncConfig) {
        logger.warn('[SyncIPC] Configuration not ready; defer initialization');
        return;
      }

      // Create SyncItemsService if needed
      if (!this.syncItemsService) {
        const transactionManager = new TransactionManager(this.storage.database);
        this.syncItemsService = new SyncItemsService(this.storage.database, transactionManager);
      }

      // Create SyncVersionManager if needed
      if (!this.syncVersionManager) {
        this.syncVersionManager = new SyncVersionManager(this.storage);
      }

      // Initialize cursor sync engine
      this.syncEngine = new CursorSyncEngine(syncConfig, {
        storage: this.storage,
        syncItemsService: this.syncItemsService,
      });
      await this.syncEngine.initialize();

      logger.info('Cursor sync engine initialized successfully');
    } catch (error) {
      logger.error('[SyncIPC] Failed to ensure cursor sync engine initialized:', error);
      // Do not throw; callers can decide whether to proceed or surface an error
    }
  }

  private isFullyInitialized(): boolean {
    return !!(this.syncEngine && this.syncItemsService);
  }

  private async getCursorSyncConfiguration(): Promise<CursorSyncConfiguration | null> {
    try {
      // Use canonical auth context for credentials (serverUrl, accessToken, userId)
      const authContext = await this.authService.getAuthContext();
      const authStatus = await this.authService.getAuthStatus();

      // Require auth context to be available with all required credentials
      if (
        !authContext ||
        !authContext.serverUrl ||
        !authContext.accessToken ||
        !authContext.userId
      ) {
        logger.warn('Sync configuration incomplete - auth context missing credentials', {
          hasAuthContext: !!authContext,
          hasServerUrl: !!authContext?.serverUrl,
          hasAccessToken: !!authContext?.accessToken,
          hasUserId: !!authContext?.userId,
          isConfigured: authStatus.isConfigured,
          isLinked: authStatus.isLinked,
        });
        return null;
      }

      // Use settings.syncEnabled as the single source of truth for sync enabled state
      const syncEnabledSetting = await this.storage.settings.get('syncEnabled');
      const syncEnabled = syncEnabledSetting === 'true';

      // Get or create device ID
      if (!this.syncVersionManager) {
        this.syncVersionManager = new SyncVersionManager(this.storage);
      }
      const deviceId = await this.syncVersionManager.getOrCreateDeviceId();

      // Build cursor sync configuration
      const syncConfig: CursorSyncConfiguration = {
        serverUrl: authContext.serverUrl,
        userId: authContext.userId,
        deviceId,
        deviceName: 'Desktop Client',
        accessToken: authContext.accessToken,
        enabled: syncEnabled,
        syncServiceUrl: `${authContext.serverUrl.replace(/\/$/, '')}/api/sync`,
        maxPushBatchSize: 100,
        maxPullLimit: 500,
        timeoutMs: 30000,
      };

      logger.debug('[SyncHandlers] Cursor sync configuration built', {
        serverUrl: syncConfig.serverUrl,
        syncServiceUrl: syncConfig.syncServiceUrl,
        userId: syncConfig.userId,
        deviceId: syncConfig.deviceId,
        hasAccessToken: !!syncConfig.accessToken,
        enabled: syncConfig.enabled,
      });

      return syncConfig;
    } catch (error) {
      logger.error('Failed to get cursor sync configuration:', error);
      return null;
    }
  }

  register(): void {
    this.registerHandlers();
  }

  private registerHandlers(): void {
    // Get cursor sync status
    ipcMain.handle('sync:get-status', async (): Promise<SyncStatusResponse> => {
      try {
        // Check basic sync configuration
        const isConfigured = await this.isCursorSyncConfigured();
        const isLinked = await this.isAccountLinked();
        const syncEnabledSetting = await this.storage.settings.get('syncEnabled');
        const isEnabled = syncEnabledSetting === 'true';
        const hasValidToken = await this.hasValidAuthToken();
        const lastSync = await this.getLastSuccessfulSyncTimestamp();

        // Get cursor status from database
        const cursorStatus = {
          cursor: 0,
          pendingItems: 0,
          lastPushAt: null as number | null,
          lastPullAt: null as number | null,
        };

        try {
          const db = this.storage.database.getDatabase();

          // Get current cursor (sync_config is a key-value table)
          const cursorRow = db
            .prepare("SELECT value FROM sync_config WHERE key = 'cursor'")
            .get() as { value: string } | undefined;
          cursorStatus.cursor = cursorRow ? Number(cursorRow.value) : 0;

          // Get pending items count
          if (this.syncItemsService) {
            const pendingBatch = this.syncItemsService.getPendingItems(1000);
            cursorStatus.pendingItems = pendingBatch.items.length;
          }

          // Get last push/pull times
          const syncConfig = await this.storage.sync.getConfig();
          cursorStatus.lastPushAt = syncConfig?.lastPushAt || null;
          cursorStatus.lastPullAt = syncConfig?.lastPullAt || null;
        } catch (error) {
          logger.warn('Failed to get cursor status:', error);
        }

        // Get health status
        const healthStatus = {
          avgSyncDuration:
            this.healthMetrics.syncDurations.length > 0
              ? this.healthMetrics.syncDurations.reduce((a, b) => a + b, 0) /
                this.healthMetrics.syncDurations.length
              : 0,
          successRate:
            this.healthMetrics.totalCount > 0
              ? this.healthMetrics.successCount / this.healthMetrics.totalCount
              : 1,
          engineInitialized: this.isFullyInitialized(),
        };

        const status: SyncStatusResponse = {
          version: 'cursor',
          isConfigured,
          isLinked,
          isEnabled,
          lastSync,
          hasValidToken,
          cursorStatus,
          syncProgress: this.currentSyncProgress,
          conflicts: {
            count: this.conflictHistory.length,
            recent: this.conflictHistory.slice(0, 10),
          },
          retryState: this.retryState,
          healthStatus,
        };

        logger.debug('[SYNC_IPC] get-status', {
          isConfigured,
          isLinked,
          isEnabled,
          hasValidToken,
          lastSync,
          cursor: cursorStatus.cursor,
          pendingItems: cursorStatus.pendingItems,
        });

        return status;
      } catch (error) {
        logger.error('Failed to get cursor sync status:', error);
        throw error;
      }
    });

    // Perform cursor-based sync
    ipcMain.handle('sync:perform-sync', async (): Promise<void> => {
      const hasConfig = !!(await this.getCursorSyncConfiguration());
      logger.info('[SYNC_IPC] perform-sync requested', {
        engineInitialized: this.isFullyInitialized(),
        hasConfig,
      });

      // Try to initialize engine if not already done (e.g., after fresh login)
      if (!this.syncEngine && hasConfig) {
        logger.info('[SYNC_IPC] Engine not initialized, attempting initialization...');
        await this.ensureCursorSyncInitialized();
      }

      if (!this.syncEngine) {
        throw new Error('Cursor sync engine not initialized');
      }

      await this.performSync();
    });

    // Reset retry state
    ipcMain.handle('sync:reset-retry-state', async (): Promise<void> => {
      this.retryState = {
        isRetrying: false,
        attemptCount: 0,
        maxAttempts: 3,
        nextRetryAt: null,
        lastError: null,
      };
    });

    // Get conflict details
    ipcMain.handle('sync:get-conflicts', async (): Promise<SyncStatusResponse['conflicts']> => {
      return {
        count: this.conflictHistory.length,
        recent: this.conflictHistory,
      };
    });

    // Clear conflict history
    ipcMain.handle('sync:clear-conflicts', async (): Promise<void> => {
      this.conflictHistory = [];
    });

    // Manual sync trigger - uses SyncLifecycleManager state machine
    ipcMain.handle('sync:push', async () => {
      logger.info('[SYNC_IPC] manual sync requested');

      // Check if sync is possible via state machine
      if (this.deps.canSync && !this.deps.canSync()) {
        logger.warn('[SYNC_IPC] sync not available - state machine not in idle state');
        return {
          success: false,
          processed: 0,
          error: 'Sync not available',
          message: 'Sync is not available. Check authentication and sync settings.',
        };
      }

      try {
        const result = await this.performSyncWithResult();

        return {
          success: result.success,
          processed: result.entities_pushed + result.entities_pulled,
          pushed: result.entities_pushed,
          pulled: result.entities_pulled,
          conflicts: result.conflicts_resolved,
          error: result.error,
          message: result.userMessage,
          operation: result.operation,
          duration_ms: result.duration_ms,
          cursor: result.new_cursor,
          snapshotTriggered: result.snapshot_triggered,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown sync error';
        logger.error('[SYNC_IPC] sync failed:', error);

        this.emitToRenderer('sync-error', {
          error: errorMessage,
          willRetry: false,
          attemptCount: 0,
          maxAttempts: 0,
          nextRetryAt: null,
        });

        return {
          success: false,
          processed: 0,
          error: errorMessage,
          message: `Sync failed: ${errorMessage}`,
        };
      }
    });

    ipcMain.handle('sync:getStatus', async () => {
      // Use canonical auth status from AuthService for consistency
      const authStatus = await this.authService.getAuthStatus();
      const cfg = await this.storage.sync.getConfig();
      // Use settings.syncEnabled as the single source of truth for sync enabled state
      const syncEnabled = await this.storage.settings.get('syncEnabled');

      return {
        isConfigured: authStatus.isConfigured,
        isLinked: authStatus.isLinked,
        isEnabled: syncEnabled === 'true',
        lastPush: cfg?.lastPushAt || null,
        lastPull: cfg?.lastPullAt || null,
        hasValidToken: authStatus.hasValidAccessToken,
      };
    });

    ipcMain.handle('sync:getHealthStatus', async () => {
      return {
        isInitialized: this.isFullyInitialized(),
        hasValidConfig: !!(await this.getCursorSyncConfiguration()),
        enginesReady: this.isFullyInitialized(),
      };
    });

    // Get health metrics for sync status display
    ipcMain.handle('sync:getHealthMetrics', async () => {
      const avgDuration =
        this.healthMetrics.syncDurations.length > 0
          ? this.healthMetrics.syncDurations.reduce((a, b) => a + b, 0) /
            this.healthMetrics.syncDurations.length
          : 0;

      const successRate =
        this.healthMetrics.totalCount > 0
          ? this.healthMetrics.successCount / this.healthMetrics.totalCount
          : 1;

      return {
        successRate,
        averageDuration: avgDuration,
        lastSyncSuccess: null, // Could track this separately if needed
        totalCount: this.healthMetrics.totalCount,
        successCount: this.healthMetrics.successCount,
      };
    });

    // Get server entity counts for merge prompt
    ipcMain.handle('sync:getServerStats', async () => {
      try {
        const authContext = await this.authService.getAuthContext();
        if (!authContext?.serverUrl || !authContext?.accessToken) {
          return { success: false, error: 'Not authenticated' };
        }

        const response = await fetch(`${authContext.serverUrl}/api/sync/stats`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${authContext.accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          return { success: false, error: `Server returned ${response.status}` };
        }

        const data = await response.json();
        return { success: true, data: data.data };
      } catch (error: unknown) {
        logger.error('Failed to fetch server stats:', error);
        return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    });
  }

  async teardownSyncEngines(): Promise<void> {
    try {
      await this.syncEngine?.shutdown();
    } catch (error) {
      logger.debug('SyncHandlers: Engine shutdown failed during teardown', {
        error: error instanceof Error ? error.message : error,
      });
    }
    this.syncEngine = null;
  }

  /**
   * Public method to trigger sync from other handlers.
   * Used by SummaryHandlers to ensure transcription is synced before generating summary.
   * Returns true if sync succeeded, false otherwise.
   */
  async triggerSyncAndWait(): Promise<boolean> {
    try {
      logger.info('[SyncHandlers] triggerSyncAndWait called');

      // Try to initialize engine if not already done
      const hasConfig = !!(await this.getCursorSyncConfiguration());
      if (!this.syncEngine && hasConfig) {
        logger.info('[SyncHandlers] Engine not initialized, attempting initialization...');
        await this.ensureCursorSyncInitialized();
      }

      if (!this.syncEngine) {
        logger.error('[SyncHandlers] Cannot perform sync - engine not initialized');
        return false;
      }

      const result = await this.performSyncWithResult();
      logger.info('[SyncHandlers] triggerSyncAndWait completed', {
        success: result.success,
        pushed: result.entities_pushed,
        pulled: result.entities_pulled,
      });

      return result.success;
    } catch (error) {
      logger.error('[SyncHandlers] triggerSyncAndWait failed', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Perform sync and return the full CursorSyncResult for proper error propagation
   */
  private async performSyncWithResult(): Promise<CursorSyncResult> {
    // Ensure engine is initialized before performing sync
    if (!this.syncEngine) {
      await this.ensureCursorSyncInitialized();
    }
    if (!this.syncEngine) {
      throw new Error('Cursor sync engine not initialized');
    }

    this.currentSyncProgress = {
      phase: 'pushing',
      progress: 0,
      currentOperation: 'Starting sync...',
    };

    this.emitToRenderer('sync-start', {});

    try {
      const result = await this.syncEngine.performSync();

      // Update health metrics
      this.healthMetrics.syncDurations.push(result.duration_ms);
      if (this.healthMetrics.syncDurations.length > 10) {
        this.healthMetrics.syncDurations.shift();
      }
      this.healthMetrics.totalCount++;
      if (result.success) {
        this.healthMetrics.successCount++;
      }

      // Only update timestamp and emit success events if sync succeeded
      if (result.success) {
        this.currentSyncProgress = {
          phase: 'complete',
          progress: 100,
          currentOperation: 'Sync complete',
          entitiesPushed: result.entities_pushed,
          entitiesPulled: result.entities_pulled,
        };

        // Emit completion for UIs relying on IPC events
        this.emitToRenderer('sync-complete', {
          operation: result.operation,
          duration: result.duration_ms,
          entitiesPushed: result.entities_pushed,
          entitiesPulled: result.entities_pulled,
          conflictsResolved: result.conflicts_resolved,
          newCursor: result.new_cursor,
          snapshotTriggered: result.snapshot_triggered,
        });

        // Notify renderers to refresh data views after a successful sync
        try {
          this.emitToRenderer('notes:changed', {});
          this.emitToRenderer('tags:changed', {});
          this.emitToRenderer('note-tags:changed', {});
          this.emitToRenderer('binders:changed', {});
        } catch (e) {
          logger.debug('[SyncIPC] Failed to emit change events after sync', {
            error: e instanceof Error ? e.message : e,
          });
        }

        // Reset retry state on success
        this.retryState = {
          isRetrying: false,
          attemptCount: 0,
          maxAttempts: 3,
          nextRetryAt: null,
          lastError: null,
        };
      } else {
        this.currentSyncProgress = {
          phase: 'idle',
          progress: 0,
          currentOperation: 'Sync failed',
        };

        // Update retry state
        this.retryState.attemptCount++;
        this.retryState.lastError = result.error || 'Unknown error';

        // Emit error event when sync fails
        this.emitToRenderer('sync-error', {
          error: result.error || 'Sync failed',
          willRetry: this.retryState.attemptCount < this.retryState.maxAttempts,
          attemptCount: this.retryState.attemptCount,
          maxAttempts: this.retryState.maxAttempts,
          nextRetryAt: null,
        });
      }

      return result;
    } catch (error) {
      logger.error('[SyncIPC] Sync failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown sync error';

      this.currentSyncProgress = {
        phase: 'idle',
        progress: 0,
        currentOperation: 'Sync failed',
      };

      this.emitToRenderer('sync-error', { error: errorMessage });

      // Return a failed CursorSyncResult instead of throwing
      return {
        success: false,
        operation: 'push',
        duration_ms: 0,
        entities_pushed: 0,
        entities_pulled: 0,
        conflicts_resolved: 0,
        new_cursor: 0,
        error: errorMessage,
        userMessage: `Sync failed: ${errorMessage}`,
      };
    }
  }

  /**
   * Legacy performSync method maintained for backward compatibility
   */
  private async performSync(): Promise<void> {
    const result = await this.performSyncWithResult();

    // Note: sync logging is handled by SyncEngine/SyncService
    // Last sync timestamp is now queried from sync_log table, not settings

    // Throw error if sync failed (legacy behavior)
    if (!result.success) {
      throw new Error(result.error || 'Sync failed');
    }
  }

  private async isCursorSyncConfigured(): Promise<boolean> {
    try {
      // Auth/sync decoupling: Check auth status from AuthService, not sync config
      const authStatus = await this.authService.getAuthStatus();
      // Use settings.syncEnabled as the single source of truth for sync enabled state
      const syncEnabled = await this.storage.settings.get('syncEnabled');

      // Consider cursor sync configured when we have valid auth AND sync is enabled
      return authStatus.isConfigured && authStatus.hasValidAccessToken && syncEnabled === 'true';
    } catch {
      return false;
    }
  }

  private async isAccountLinked(): Promise<boolean> {
    try {
      // Use canonical auth status to determine if account is linked
      const authStatus = await this.authService.getAuthStatus();
      return authStatus.isLinked;
    } catch {
      return false;
    }
  }

  private async hasValidAuthToken(): Promise<boolean> {
    try {
      // Use canonical auth status to determine token validity
      const authStatus = await this.authService.getAuthStatus();
      return authStatus.hasValidAccessToken;
    } catch {
      return false;
    }
  }

  /**
   * Get the timestamp of the last successful sync from sync_log table
   * Returns null if no successful sync has ever occurred
   */
  private async getLastSuccessfulSyncTimestamp(): Promise<number | null> {
    try {
      const db = this.storage.database.getDatabase();
      const result = db
        .prepare(
          `SELECT completed_at FROM sync_log
           WHERE status = 'completed'
           ORDER BY completed_at DESC
           LIMIT 1`
        )
        .get() as { completed_at: number } | undefined;

      return result?.completed_at ?? null;
    } catch (error) {
      logger.error('Failed to get last successful sync timestamp:', error);
      return null;
    }
  }

  private emitToRenderer(channel: string, data: unknown): void {
    try {
      const allWindows = BrowserWindow.getAllWindows();
      allWindows.forEach((window) => {
        if (!window.isDestroyed() && window.webContents) {
          window.webContents.send(channel, data);
        }
      });
    } catch (error) {
      logger.warn('Failed to emit to renderer:', error);
    }
  }

  // Cleanup method
  public cleanup(): void {
    // Remove all IPC handlers
    const syncChannels = [
      'sync:get-status',
      'sync:perform-sync',
      'sync:reset-retry-state',
      'sync:get-conflicts',
      'sync:clear-conflicts',
      'sync:push',
      'sync:getStatus',
      'sync:getHealthStatus',
      'sync:getHealthMetrics',
      'sync:getServerStats',
    ];

    syncChannels.forEach((channel) => {
      ipcMain.removeAllListeners(channel);
    });

    // Cleanup engine
    this.syncEngine?.shutdown();
    this.syncEngine = null;
    this.syncItemsService = null;
  }
}
