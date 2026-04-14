import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import { type IStorageService } from '../storage/index';
import { SyncVersionManager } from '../sync/infrastructure/SyncVersionManager';

// Validation schemas
const SetUserEnabledSchema = z.object({
  enabled: z.boolean(),
});

export interface SyncVersionHandlersDependencies {
  storage: IStorageService;
  mainWindow: BrowserWindow | null;
}

/**
 * SyncVersionHandlers manages all IPC handlers related to sync version detection,
 * device node_id management, and sync v2 configuration.
 */
export class SyncVersionHandlers {
  private syncVersionManager: SyncVersionManager;

  constructor(private deps: SyncVersionHandlersDependencies) {
    this.syncVersionManager = new SyncVersionManager(deps.storage);
  }

  /**
   * Register all sync version related IPC handlers
   */
  register(): void {
    logger.debug('SyncVersionHandlers: Registering IPC handlers');

    // Sync version IPC handlers
    ipcMain.handle('syncVersion:getNodeId', this.handleGetNodeId.bind(this));
    ipcMain.handle('syncVersion:getConfig', this.handleGetConfig.bind(this));
    ipcMain.handle('syncVersion:shouldUseSyncV2', this.handleShouldUseSyncV2.bind(this));
    ipcMain.handle('syncVersion:setUserEnabled', this.handleSetUserEnabled.bind(this));
    ipcMain.handle('syncVersion:refreshFromServer', this.handleRefreshFromServer.bind(this));
    ipcMain.handle('syncVersion:getDebugInfo', this.handleGetDebugInfo.bind(this));
    ipcMain.handle('syncVersion:clearSettings', this.handleClearSettings.bind(this));

    logger.debug('SyncVersionHandlers: All handlers registered successfully');
  }

  /**
   * Cleanup all handlers when shutting down
   */
  cleanup(): void {
    logger.debug('SyncVersionHandlers: Cleaning up IPC handlers');

    // Remove all sync version handlers
    ipcMain.removeHandler('syncVersion:getNodeId');
    ipcMain.removeHandler('syncVersion:getConfig');
    ipcMain.removeHandler('syncVersion:shouldUseSyncV2');
    ipcMain.removeHandler('syncVersion:setUserEnabled');
    ipcMain.removeHandler('syncVersion:refreshFromServer');
    ipcMain.removeHandler('syncVersion:getDebugInfo');
    ipcMain.removeHandler('syncVersion:clearSettings');
  }

  /**
   * Get or create the device node_id (desktop_user_uuid)
   */
  private async handleGetNodeId(): Promise<{ success: boolean; nodeId?: string; error?: string }> {
    try {
      logger.debug('SyncVersionHandlers: Getting node_id');

      const nodeId = await this.syncVersionManager.getOrCreateNodeId();

      return {
        success: true,
        nodeId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('SyncVersionHandlers: Failed to get node_id:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get current sync version configuration
   */
  private async handleGetConfig(): Promise<{
    success: boolean;
    config?: Record<string, unknown>;
    error?: string;
  }> {
    try {
      logger.debug('SyncVersionHandlers: Getting sync version config');

      const config = await this.syncVersionManager.getSyncVersionConfig();

      return {
        success: true,
        config,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('SyncVersionHandlers: Failed to get sync version config:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Check if should use sync v2
   */
  private async handleShouldUseSyncV2(): Promise<{
    success: boolean;
    shouldUse?: boolean;
    error?: string;
  }> {
    try {
      logger.debug('SyncVersionHandlers: Checking if should use sync v2');

      const shouldUse = await this.syncVersionManager.shouldUseSyncV2();

      return {
        success: true,
        shouldUse,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('SyncVersionHandlers: Failed to check sync v2 status:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Set user sync v2 enabled preference
   */
  private async handleSetUserEnabled(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      logger.debug('SyncVersionHandlers: Setting user sync v2 enabled preference');

      // Validate input
      const { enabled } = SetUserEnabledSchema.parse(input);

      await this.syncVersionManager.setUserSyncV2Enabled(enabled);

      // Broadcast the change to all windows
      this.broadcastSyncVersionChange();

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('SyncVersionHandlers: Failed to set user sync v2 preference:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Refresh sync version from server
   */
  private async handleRefreshFromServer(): Promise<{ success: boolean; error?: string }> {
    try {
      logger.debug('SyncVersionHandlers: Refreshing sync version from server');

      await this.syncVersionManager.refreshServerSyncVersion();

      // Broadcast the change to all windows
      this.broadcastSyncVersionChange();

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('SyncVersionHandlers: Failed to refresh sync version from server:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get debug information for sync version system
   */
  private async handleGetDebugInfo(): Promise<{
    success: boolean;
    debugInfo?: Record<string, unknown>;
    error?: string;
  }> {
    try {
      logger.debug('SyncVersionHandlers: Getting sync version debug info');

      const debugInfo = await this.syncVersionManager.getDebugInfo();

      return {
        success: true,
        debugInfo,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('SyncVersionHandlers: Failed to get debug info:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Clear all sync v2 settings (for testing/reset)
   */
  private async handleClearSettings(): Promise<{ success: boolean; error?: string }> {
    try {
      logger.debug('SyncVersionHandlers: Clearing sync v2 settings');

      await this.syncVersionManager.clearSyncV2Settings();

      // Broadcast the change to all windows
      this.broadcastSyncVersionChange();

      return {
        success: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('SyncVersionHandlers: Failed to clear sync v2 settings:', error);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Broadcast sync version changes to all renderer processes
   */
  private broadcastSyncVersionChange(): void {
    if (this.deps.mainWindow && !this.deps.mainWindow.isDestroyed()) {
      this.deps.mainWindow.webContents.send('syncVersion:changed');
    }
  }
}
