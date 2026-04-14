/**
 * UpdateHandlers
 * IPC handlers for desktop client update functionality
 */

import { BrowserWindow, ipcMain } from 'electron';

import { logger } from '../logger';
import type { UpdateInfo, UpdateService, DownloadStatus } from '../services/update';

export interface UpdateHandlersDeps {
  updateService: UpdateService;
  mainWindow?: BrowserWindow | null;
}

/**
 * IPC handlers for update-related operations
 */
export class UpdateHandlers {
  private mainWindow: BrowserWindow | null;
  private unsubscribeUpdateAvailable?: () => void;
  private unsubscribeUpdateDismissed?: () => void;
  private unsubscribeDownloadProgress?: () => void;
  private unsubscribeDownloadComplete?: () => void;
  private unsubscribeDownloadError?: () => void;
  private unsubscribeDownloadStarted?: () => void;

  constructor(private deps: UpdateHandlersDeps) {
    this.mainWindow = deps.mainWindow ?? null;
  }

  /**
   * Register all IPC handlers
   */
  register(): void {
    logger.debug('UpdateHandlers: Registering IPC handlers');

    // Register handlers
    ipcMain.handle('update:check', this.handleCheckForUpdate.bind(this));
    ipcMain.handle('update:getCached', this.handleGetCached.bind(this));
    ipcMain.handle('update:openDownload', this.handleOpenDownload.bind(this));
    ipcMain.handle('update:dismiss', this.handleDismiss.bind(this));
    ipcMain.handle('update:isDismissed', this.handleIsDismissed.bind(this));
    ipcMain.handle('update:getVersion', this.handleGetVersion.bind(this));

    // New download handlers
    ipcMain.handle('update:startDownload', this.handleStartDownload.bind(this));
    ipcMain.handle('update:getDownloadStatus', this.handleGetDownloadStatus.bind(this));
    ipcMain.handle('update:isDownloadReady', this.handleIsDownloadReady.bind(this));
    ipcMain.handle('update:installAndRestart', this.handleInstallAndRestart.bind(this));
    ipcMain.handle('update:cancelDownload', this.handleCancelDownload.bind(this));
    ipcMain.handle('update:resetDownload', this.handleResetDownload.bind(this));

    // Subscribe to update service events
    this.setupEventListeners();

    logger.debug('UpdateHandlers: IPC handlers registered');
  }

  /**
   * Update the main window reference
   */
  updateMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Cleanup handlers and subscriptions
   */
  cleanup(): void {
    logger.info('UpdateHandlers: Cleaning up handlers');

    // Remove IPC handlers
    ipcMain.removeHandler('update:check');
    ipcMain.removeHandler('update:getCached');
    ipcMain.removeHandler('update:openDownload');
    ipcMain.removeHandler('update:dismiss');
    ipcMain.removeHandler('update:isDismissed');
    ipcMain.removeHandler('update:getVersion');
    ipcMain.removeHandler('update:startDownload');
    ipcMain.removeHandler('update:getDownloadStatus');
    ipcMain.removeHandler('update:isDownloadReady');
    ipcMain.removeHandler('update:installAndRestart');
    ipcMain.removeHandler('update:cancelDownload');
    ipcMain.removeHandler('update:resetDownload');

    // Unsubscribe from events
    if (this.unsubscribeUpdateAvailable) {
      this.unsubscribeUpdateAvailable();
      this.unsubscribeUpdateAvailable = undefined;
    }

    if (this.unsubscribeUpdateDismissed) {
      this.unsubscribeUpdateDismissed();
      this.unsubscribeUpdateDismissed = undefined;
    }

    if (this.unsubscribeDownloadProgress) {
      this.unsubscribeDownloadProgress();
      this.unsubscribeDownloadProgress = undefined;
    }

    if (this.unsubscribeDownloadComplete) {
      this.unsubscribeDownloadComplete();
      this.unsubscribeDownloadComplete = undefined;
    }

    if (this.unsubscribeDownloadError) {
      this.unsubscribeDownloadError();
      this.unsubscribeDownloadError = undefined;
    }

    if (this.unsubscribeDownloadStarted) {
      this.unsubscribeDownloadStarted();
      this.unsubscribeDownloadStarted = undefined;
    }

    logger.info('UpdateHandlers: Cleanup complete');
  }

  /**
   * Setup event listeners for update service
   */
  private setupEventListeners(): void {
    // Listen for update available events
    const handleUpdateAvailable = (info: UpdateInfo) => {
      this.broadcastUpdateAvailable(info);
    };
    this.deps.updateService.on('update-available', handleUpdateAvailable);
    this.unsubscribeUpdateAvailable = () => {
      this.deps.updateService.removeListener('update-available', handleUpdateAvailable);
    };

    // Listen for update dismissed events
    const handleUpdateDismissed = (version: string) => {
      this.broadcastUpdateDismissed(version);
    };
    this.deps.updateService.on('update-dismissed', handleUpdateDismissed);
    this.unsubscribeUpdateDismissed = () => {
      this.deps.updateService.removeListener('update-dismissed', handleUpdateDismissed);
    };

    // Listen for download started events
    const handleDownloadStarted = () => {
      this.broadcastDownloadStarted();
    };
    this.deps.updateService.on('download-started', handleDownloadStarted);
    this.unsubscribeDownloadStarted = () => {
      this.deps.updateService.removeListener('download-started', handleDownloadStarted);
    };

    // Listen for download progress events
    const handleDownloadProgress = (progress: number) => {
      this.broadcastDownloadProgress(progress);
    };
    this.deps.updateService.on('download-progress', handleDownloadProgress);
    this.unsubscribeDownloadProgress = () => {
      this.deps.updateService.removeListener('download-progress', handleDownloadProgress);
    };

    // Listen for download complete events
    const handleDownloadComplete = (downloadPath: string) => {
      this.broadcastDownloadComplete(downloadPath);
    };
    this.deps.updateService.on('download-complete', handleDownloadComplete);
    this.unsubscribeDownloadComplete = () => {
      this.deps.updateService.removeListener('download-complete', handleDownloadComplete);
    };

    // Listen for download error events
    const handleDownloadError = (error: string) => {
      this.broadcastDownloadError(error);
    };
    this.deps.updateService.on('download-error', handleDownloadError);
    this.unsubscribeDownloadError = () => {
      this.deps.updateService.removeListener('download-error', handleDownloadError);
    };
  }

  /**
   * Handle check for update request
   */
  private async handleCheckForUpdate(
    _event: Electron.IpcMainInvokeEvent,
    force?: boolean
  ): Promise<{ success: boolean; data?: UpdateInfo; error?: string }> {
    try {
      logger.debug('UpdateHandlers: Check for update requested', { force });
      return await this.deps.updateService.checkForUpdate(force ?? false);
    } catch (error) {
      logger.error('UpdateHandlers: Failed to check for update', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle get cached update info request
   */
  private async handleGetCached(): Promise<UpdateInfo | null> {
    return this.deps.updateService.getCachedUpdateInfo();
  }

  /**
   * Handle open download URL request
   */
  private async handleOpenDownload(): Promise<boolean> {
    try {
      return await this.deps.updateService.openDownloadUrl();
    } catch (error) {
      logger.error('UpdateHandlers: Failed to open download URL', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Handle dismiss update request
   */
  private async handleDismiss(_event: Electron.IpcMainInvokeEvent, version: string): Promise<void> {
    try {
      await this.deps.updateService.dismissUpdate(version);
    } catch (error) {
      logger.error('UpdateHandlers: Failed to dismiss update', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Handle check if update is dismissed
   */
  private async handleIsDismissed(
    _event: Electron.IpcMainInvokeEvent,
    version: string
  ): Promise<boolean> {
    try {
      return await this.deps.updateService.isUpdateDismissed(version);
    } catch (error) {
      logger.error('UpdateHandlers: Failed to check if dismissed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Handle get current version request
   */
  private async handleGetVersion(): Promise<string> {
    return this.deps.updateService.getCurrentVersion();
  }

  /**
   * Handle start download request
   */
  private async handleStartDownload(): Promise<{ success: boolean; error?: string }> {
    try {
      logger.debug('UpdateHandlers: Start download requested');
      return await this.deps.updateService.downloadUpdate();
    } catch (error) {
      logger.error('UpdateHandlers: Failed to start download', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle get download status request
   */
  private async handleGetDownloadStatus(): Promise<DownloadStatus> {
    return this.deps.updateService.getDownloadStatus();
  }

  /**
   * Handle is download ready request
   */
  private async handleIsDownloadReady(): Promise<boolean> {
    return this.deps.updateService.isDownloadReady();
  }

  /**
   * Handle install and restart request
   */
  private async handleInstallAndRestart(): Promise<{ success: boolean; error?: string }> {
    try {
      logger.debug('UpdateHandlers: Install and restart requested');
      return await this.deps.updateService.installAndRestart();
    } catch (error) {
      logger.error('UpdateHandlers: Failed to install and restart', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Handle cancel download request
   */
  private async handleCancelDownload(): Promise<void> {
    logger.debug('UpdateHandlers: Cancel download requested');
    this.deps.updateService.cancelDownload();
  }

  /**
   * Handle reset download request
   */
  private async handleResetDownload(): Promise<void> {
    logger.debug('UpdateHandlers: Reset download requested');
    this.deps.updateService.resetDownload();
  }

  /**
   * Broadcast update available event to renderer
   */
  private broadcastUpdateAvailable(info: UpdateInfo): void {
    if (!this.mainWindow) {
      return;
    }

    try {
      this.mainWindow.webContents.send('update:available', info);
      logger.debug('UpdateHandlers: Broadcasted update available', {
        latestVersion: info.latestVersion,
      });
    } catch (error) {
      logger.warn('UpdateHandlers: Failed to broadcast update available', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast update dismissed event to renderer
   */
  private broadcastUpdateDismissed(version: string): void {
    if (!this.mainWindow) {
      return;
    }

    try {
      this.mainWindow.webContents.send('update:dismissed', version);
      logger.debug('UpdateHandlers: Broadcasted update dismissed', { version });
    } catch (error) {
      logger.warn('UpdateHandlers: Failed to broadcast update dismissed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast download started event to renderer
   */
  private broadcastDownloadStarted(): void {
    if (!this.mainWindow) {
      return;
    }

    try {
      this.mainWindow.webContents.send('update:download-started');
      logger.debug('UpdateHandlers: Broadcasted download started');
    } catch (error) {
      logger.warn('UpdateHandlers: Failed to broadcast download started', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast download progress event to renderer
   */
  private broadcastDownloadProgress(progress: number): void {
    if (!this.mainWindow) {
      return;
    }

    try {
      this.mainWindow.webContents.send('update:download-progress', progress);
    } catch (error) {
      logger.warn('UpdateHandlers: Failed to broadcast download progress', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast download complete event to renderer
   */
  private broadcastDownloadComplete(downloadPath: string): void {
    if (!this.mainWindow) {
      return;
    }

    try {
      this.mainWindow.webContents.send('update:download-complete', downloadPath);
      logger.debug('UpdateHandlers: Broadcasted download complete', { downloadPath });
    } catch (error) {
      logger.warn('UpdateHandlers: Failed to broadcast download complete', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast download error event to renderer
   */
  private broadcastDownloadError(error: string): void {
    if (!this.mainWindow) {
      return;
    }

    try {
      this.mainWindow.webContents.send('update:download-error', error);
      logger.debug('UpdateHandlers: Broadcasted download error', { error });
    } catch (error) {
      logger.warn('UpdateHandlers: Failed to broadcast download error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
