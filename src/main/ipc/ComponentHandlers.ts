/**
 * ComponentHandlers
 * IPC handlers for component download functionality
 */

import { BrowserWindow, ipcMain } from 'electron';

import type {
  ComponentInfo,
  DownloadProgress,
  DownloadResult,
  SetupStatusEvent,
  VerificationResult,
} from '../../shared/types/components';
import { logger } from '../logger';
import type { ComponentManager } from '../services/components';

export interface ComponentHandlersDeps {
  componentManager: ComponentManager;
  mainWindow?: BrowserWindow | null;
  onSetupRetryComplete?: () => Promise<void>;
}

/**
 * IPC handlers for component download operations
 */
export class ComponentHandlers {
  private mainWindow: BrowserWindow | null;
  private unsubscribeStatusChanged?: () => void;
  private unsubscribeDownloadProgress?: () => void;
  private unsubscribeDownloadComplete?: () => void;
  private unsubscribeDownloadError?: () => void;
  private unsubscribeAllReady?: () => void;
  private currentSetupStatus: SetupStatusEvent | null = null;

  constructor(private deps: ComponentHandlersDeps) {
    this.mainWindow = deps.mainWindow ?? null;
  }

  /**
   * Register all IPC handlers
   */
  register(): void {
    logger.debug('ComponentHandlers: Registering IPC handlers');

    // Register handlers
    ipcMain.handle('components:checkAll', this.handleCheckAll.bind(this));
    ipcMain.handle('components:download', this.handleDownload.bind(this));
    ipcMain.handle('components:downloadAll', this.handleDownloadAll.bind(this));
    ipcMain.handle('components:cancelDownload', this.handleCancelDownload.bind(this));
    ipcMain.handle('components:verify', this.handleVerify.bind(this));
    ipcMain.handle('components:repair', this.handleRepair.bind(this));
    ipcMain.handle('components:getInfo', this.handleGetInfo.bind(this));
    ipcMain.handle('components:areAllReady', this.handleAreAllReady.bind(this));
    ipcMain.handle('components:getSetupStatus', this.handleGetSetupStatus.bind(this));
    ipcMain.handle('components:setupRetryComplete', this.handleSetupRetryComplete.bind(this));

    // Subscribe to ComponentManager events
    this.setupEventListeners();

    logger.debug('ComponentHandlers: IPC handlers registered');
  }

  /**
   * Update the main window reference.
   * Sends buffered setup status to the newly available window.
   */
  updateMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;

    // Send buffered setup status to the newly available window
    if (window && !window.isDestroyed() && this.currentSetupStatus) {
      try {
        window.webContents.send('components:setup-status', this.currentSetupStatus);
      } catch {
        // Window may not be ready yet — renderer will query via getSetupStatus
      }
    }
  }

  /**
   * Set the current setup status and broadcast to renderer if available.
   * Called by AppManager during Phase 2.5 to report progress.
   */
  setCurrentSetupStatus(status: SetupStatusEvent): void {
    this.currentSetupStatus = status;

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send('components:setup-status', status);
      } catch {
        // Window not ready
      }
    }
  }

  /**
   * Cleanup handlers and subscriptions
   */
  cleanup(): void {
    logger.info('ComponentHandlers: Cleaning up handlers');

    // Remove IPC handlers
    ipcMain.removeHandler('components:checkAll');
    ipcMain.removeHandler('components:download');
    ipcMain.removeHandler('components:downloadAll');
    ipcMain.removeHandler('components:cancelDownload');
    ipcMain.removeHandler('components:verify');
    ipcMain.removeHandler('components:repair');
    ipcMain.removeHandler('components:getInfo');
    ipcMain.removeHandler('components:areAllReady');
    ipcMain.removeHandler('components:getSetupStatus');
    ipcMain.removeHandler('components:setupRetryComplete');

    // Unsubscribe from events
    this.unsubscribeStatusChanged?.();
    this.unsubscribeDownloadProgress?.();
    this.unsubscribeDownloadComplete?.();
    this.unsubscribeDownloadError?.();
    this.unsubscribeAllReady?.();

    this.unsubscribeStatusChanged = undefined;
    this.unsubscribeDownloadProgress = undefined;
    this.unsubscribeDownloadComplete = undefined;
    this.unsubscribeDownloadError = undefined;
    this.unsubscribeAllReady = undefined;

    logger.info('ComponentHandlers: Cleanup complete');
  }

  /**
   * Setup event listeners for ComponentManager
   */
  private setupEventListeners(): void {
    // Listen for status changes
    this.unsubscribeStatusChanged = this.deps.componentManager.on('status-changed', (info) => {
      this.broadcastStatusChanged(info);
    });

    // Listen for download progress
    this.unsubscribeDownloadProgress = this.deps.componentManager.on(
      'download-progress',
      (progress) => {
        this.broadcastDownloadProgress(progress);
      }
    );

    // Listen for download complete
    this.unsubscribeDownloadComplete = this.deps.componentManager.on(
      'download-complete',
      (componentId) => {
        this.broadcastDownloadComplete(componentId);
      }
    );

    // Listen for download errors
    this.unsubscribeDownloadError = this.deps.componentManager.on('download-error', (data) => {
      this.broadcastDownloadError(data);
    });

    // Listen for all components ready
    this.unsubscribeAllReady = this.deps.componentManager.on('all-ready', () => {
      this.broadcastAllReady();
    });
  }

  /**
   * Handle check all components request
   */
  private async handleCheckAll(): Promise<ComponentInfo[]> {
    try {
      logger.debug('ComponentHandlers: Checking all components');
      return await this.deps.componentManager.checkAllComponents();
    } catch (error) {
      logger.error('ComponentHandlers: Failed to check components', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Handle download single component request
   */
  private async handleDownload(
    _event: Electron.IpcMainInvokeEvent,
    componentId: string
  ): Promise<DownloadResult> {
    try {
      logger.debug('ComponentHandlers: Download requested', { componentId });
      return await this.deps.componentManager.downloadComponent(componentId);
    } catch (error) {
      logger.error('ComponentHandlers: Download failed', {
        componentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        componentId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle download all components request
   */
  private async handleDownloadAll(): Promise<{ success: boolean; results: DownloadResult[] }> {
    try {
      logger.debug('ComponentHandlers: Download all requested');
      return await this.deps.componentManager.downloadAllComponents();
    } catch (error) {
      logger.error('ComponentHandlers: Download all failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        results: [],
      };
    }
  }

  /**
   * Handle cancel download request
   */
  private async handleCancelDownload(): Promise<void> {
    try {
      logger.debug('ComponentHandlers: Cancel download requested');
      this.deps.componentManager.cancelDownload();
    } catch (error) {
      logger.error('ComponentHandlers: Cancel download failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handle verify component request
   */
  private async handleVerify(
    _event: Electron.IpcMainInvokeEvent,
    componentId: string
  ): Promise<VerificationResult> {
    try {
      logger.debug('ComponentHandlers: Verify requested', { componentId });
      return await this.deps.componentManager.verifyComponent(componentId);
    } catch (error) {
      logger.error('ComponentHandlers: Verify failed', {
        componentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        valid: false,
        componentId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle repair component request
   */
  private async handleRepair(
    _event: Electron.IpcMainInvokeEvent,
    componentId: string
  ): Promise<DownloadResult> {
    try {
      logger.debug('ComponentHandlers: Repair requested', { componentId });
      return await this.deps.componentManager.repairComponent(componentId);
    } catch (error) {
      logger.error('ComponentHandlers: Repair failed', {
        componentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        componentId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle get component info request
   */
  private async handleGetInfo(
    _event: Electron.IpcMainInvokeEvent,
    componentId: string
  ): Promise<ComponentInfo> {
    try {
      logger.debug('ComponentHandlers: Get info requested', { componentId });
      return await this.deps.componentManager.getComponentInfo(componentId);
    } catch (error) {
      logger.error('ComponentHandlers: Get info failed', {
        componentId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Handle are all components ready request
   */
  private async handleAreAllReady(): Promise<boolean> {
    try {
      // Skip component check in test mode to bypass setup screen
      const skipSetup =
        process.env.NOTELY_SKIP_SETUP === 'true' || process.env.NOTELY_SKIP_SETUP === '1';
      if (skipSetup) {
        logger.info('ComponentHandlers: Skipping component check (NOTELY_SKIP_SETUP mode)');
        return true;
      }

      return await this.deps.componentManager.areAllComponentsReady();
    } catch (error) {
      logger.error('ComponentHandlers: areAllReady check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Handle get setup status request (renderer queries buffered status)
   */
  private async handleGetSetupStatus(): Promise<SetupStatusEvent | null> {
    return this.currentSetupStatus;
  }

  /**
   * Handle setup retry complete (renderer signals retry download succeeded)
   */
  private async handleSetupRetryComplete(): Promise<void> {
    try {
      logger.info('ComponentHandlers: Setup retry complete, invoking callback');
      await this.deps.onSetupRetryComplete?.();
    } catch (error) {
      logger.error('ComponentHandlers: Setup retry complete callback failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Broadcast status changed event to renderer
   */
  private broadcastStatusChanged(info: ComponentInfo): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      this.mainWindow.webContents.send('components:status-changed', info);
      logger.debug('ComponentHandlers: Broadcasted status changed', {
        componentId: info.id,
        status: info.status,
      });
    } catch (error) {
      logger.warn('ComponentHandlers: Failed to broadcast status changed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast download progress event to renderer
   */
  private broadcastDownloadProgress(progress: DownloadProgress): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      this.mainWindow.webContents.send('components:download-progress', progress);
    } catch (error) {
      // Don't log every progress error to avoid log spam
    }
  }

  /**
   * Broadcast download complete event to renderer
   */
  private broadcastDownloadComplete(componentId: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      this.mainWindow.webContents.send('components:download-complete', componentId);
      logger.debug('ComponentHandlers: Broadcasted download complete', { componentId });
    } catch (error) {
      logger.warn('ComponentHandlers: Failed to broadcast download complete', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast download error event to renderer
   */
  private broadcastDownloadError(data: { componentId: string; error: string }): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      this.mainWindow.webContents.send('components:download-error', data);
      logger.debug('ComponentHandlers: Broadcasted download error', data);
    } catch (error) {
      logger.warn('ComponentHandlers: Failed to broadcast download error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast all ready event to renderer
   */
  private broadcastAllReady(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    try {
      this.mainWindow.webContents.send('components:all-ready');
      logger.debug('ComponentHandlers: Broadcasted all ready');
    } catch (error) {
      logger.warn('ComponentHandlers: Failed to broadcast all ready', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
