/**
 * UpdateService
 * Handles automatic updates using electron-updater.
 *
 * Certificate pinning is handled automatically via session.defaultSession.setCertificateVerifyProc()
 * which is configured by CertificatePinningService. electron-updater uses Electron's net module
 * which respects the session-level certificate verification.
 */

import { EventEmitter } from 'events';

import { app } from 'electron';
import { autoUpdater, UpdateInfo as ElectronUpdateInfo } from 'electron-updater';

import { logger } from '../../logger';
import type { ISettingsService } from '../../storage/interfaces';

export interface UpdateInfo {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  forceUpdate: boolean;
  platform: string;
}

export interface UpdateCheckResult {
  success: boolean;
  data?: UpdateInfo;
  error?: string;
}

export type DownloadState = 'idle' | 'downloading' | 'complete' | 'error';

export interface DownloadStatus {
  state: DownloadState;
  progress: number;
  downloadPath: string | null;
  error: string | null;
}

interface UpdateServiceDeps {
  settings: ISettingsService;
}

/**
 * Service for checking and managing desktop client updates via electron-updater.
 *
 * Key features:
 * - Uses electron-updater for cross-platform auto-updates
 * - Certificate pinning is automatically respected via Electron's session
 * - Supports Windows (NSIS), macOS (ZIP), and Linux (AppImage)
 */
export class UpdateService extends EventEmitter {
  private cachedUpdateInfo: UpdateInfo | null = null;
  private hasChecked = false;

  // Download state
  private downloadState: DownloadState = 'idle';
  private downloadProgress = 0;
  private downloadError: string | null = null;
  private electronUpdateInfo: ElectronUpdateInfo | null = null;

  constructor(private deps: UpdateServiceDeps) {
    super();
    this.configureUpdater();
    logger.info('UpdateService: Initialized with electron-updater');
  }

  /**
   * Configure electron-updater settings and event handlers
   */
  private configureUpdater(): void {
    // Configure electron-updater
    autoUpdater.autoDownload = false; // We control when to download
    autoUpdater.autoInstallOnAppQuit = false; // We control when to install
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = false;

    // Configure logging
    autoUpdater.logger = {
      info: (message?: unknown) => logger.info('autoUpdater:', { message }),
      warn: (message?: unknown) => logger.warn('autoUpdater:', { message }),
      error: (message?: unknown) => logger.error('autoUpdater:', { message }),
      debug: (message?: unknown) => logger.debug('autoUpdater:', { message }),
    };

    // Event handlers
    autoUpdater.on('checking-for-update', () => {
      logger.debug('UpdateService: Checking for update...');
    });

    autoUpdater.on('update-available', (info: ElectronUpdateInfo) => {
      logger.info('UpdateService: Update available', {
        version: info.version,
        releaseDate: info.releaseDate,
      });
      this.electronUpdateInfo = info;
      this.hasChecked = true;

      // Convert to our UpdateInfo format
      const updateInfo = this.convertToUpdateInfo(info, true);
      this.cachedUpdateInfo = updateInfo;

      this.emit('update-available', updateInfo);
    });

    autoUpdater.on('update-not-available', (info: ElectronUpdateInfo) => {
      logger.info('UpdateService: No update available', {
        currentVersion: app.getVersion(),
        latestVersion: info.version,
      });
      this.electronUpdateInfo = info;
      this.hasChecked = true;

      // Cache the "no update" info
      const updateInfo = this.convertToUpdateInfo(info, false);
      this.cachedUpdateInfo = updateInfo;
    });

    autoUpdater.on('download-progress', (progress) => {
      this.downloadProgress = Math.round(progress.percent);
      this.emit('download-progress', this.downloadProgress);

      logger.debug('UpdateService: Download progress', {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    autoUpdater.on('update-downloaded', (info: ElectronUpdateInfo) => {
      logger.info('UpdateService: Update downloaded', {
        version: info.version,
      });
      this.downloadState = 'complete';
      this.downloadProgress = 100;
      this.emit('download-complete', info.version);
    });

    autoUpdater.on('error', (err: Error) => {
      logger.error('UpdateService: electron-updater error', {
        error: err.message,
        stack: err.stack,
      });

      // Update download state if we were downloading
      if (this.downloadState === 'downloading') {
        this.downloadState = 'error';
        this.downloadError = err.message;
        this.emit('download-error', err.message);
      }

      this.emit('error', err.message);
    });
  }

  /**
   * Convert electron-updater's UpdateInfo to our format
   */
  private convertToUpdateInfo(info: ElectronUpdateInfo, updateAvailable: boolean): UpdateInfo {
    // Extract release notes
    let releaseNotes: string | null = null;
    if (info.releaseNotes) {
      if (typeof info.releaseNotes === 'string') {
        releaseNotes = info.releaseNotes;
      } else if (Array.isArray(info.releaseNotes)) {
        releaseNotes = info.releaseNotes.map((n) => n.note || '').join('\n');
      }
    }

    return {
      updateAvailable,
      currentVersion: app.getVersion(),
      latestVersion: info.version,
      downloadUrl: null, // electron-updater handles the URL internally
      releaseNotes,
      releaseDate: info.releaseDate || null,
      forceUpdate: false, // electron-updater doesn't have this concept
      platform: process.platform,
    };
  }

  /**
   * Get the current app version
   */
  getCurrentVersion(): string {
    return app.getVersion();
  }

  /**
   * Get the current platform
   */
  getPlatform(): NodeJS.Platform {
    return process.platform;
  }

  /**
   * Check for updates using electron-updater.
   * Only checks once per session unless forced.
   *
   * @param force - Force a fresh check even if already checked
   */
  async checkForUpdate(force = false): Promise<UpdateCheckResult> {
    // Return cached result if already checked (unless forced)
    if (!force && this.hasChecked && this.cachedUpdateInfo) {
      logger.debug('UpdateService: Returning cached update info');
      return { success: true, data: this.cachedUpdateInfo };
    }

    try {
      logger.info('UpdateService: Checking for updates', {
        currentVersion: this.getCurrentVersion(),
        platform: this.getPlatform(),
      });

      // Check for updates via electron-updater
      // This uses Electron's net module which respects session certificate pinning
      const result = await autoUpdater.checkForUpdates();

      if (result && result.updateInfo) {
        const updateAvailable = result.updateInfo.version !== app.getVersion();
        const updateInfo = this.convertToUpdateInfo(result.updateInfo, updateAvailable);
        this.cachedUpdateInfo = updateInfo;
        this.hasChecked = true;

        logger.info('UpdateService: Update check completed', {
          updateAvailable,
          currentVersion: updateInfo.currentVersion,
          latestVersion: updateInfo.latestVersion,
        });

        return { success: true, data: updateInfo };
      }

      // No result - create a "no update" response
      const noUpdateInfo: UpdateInfo = {
        updateAvailable: false,
        currentVersion: app.getVersion(),
        latestVersion: app.getVersion(),
        downloadUrl: null,
        releaseNotes: null,
        releaseDate: null,
        forceUpdate: false,
        platform: process.platform,
      };

      this.cachedUpdateInfo = noUpdateInfo;
      this.hasChecked = true;

      return { success: true, data: noUpdateInfo };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('UpdateService: Failed to check for updates', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Mark as checked even on error to avoid retrying on every IPC call
      this.hasChecked = true;

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Get the cached update info if available
   */
  getCachedUpdateInfo(): UpdateInfo | null {
    return this.cachedUpdateInfo;
  }

  /**
   * Clear the cached update info and allow re-checking
   */
  clearCache(): void {
    this.cachedUpdateInfo = null;
    this.hasChecked = false;
    this.electronUpdateInfo = null;
    logger.debug('UpdateService: Cache cleared');
  }

  /**
   * Open the download URL in the default browser.
   * With electron-updater, this is typically not needed as updates are handled internally.
   */
  async openDownloadUrl(): Promise<boolean> {
    // electron-updater doesn't expose direct download URLs
    // Fall back to opening the releases page
    const { shell } = await import('electron');
    try {
      await shell.openExternal('https://get.yourdomain.com/releases');
      logger.info('UpdateService: Opened releases page');
      return true;
    } catch (error) {
      logger.error('UpdateService: Failed to open releases page', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Dismiss the update notification (persist user preference)
   * @param version - Version to dismiss
   */
  async dismissUpdate(version: string): Promise<void> {
    try {
      await this.deps.settings.set('update.dismissedVersion', version);
      await this.deps.settings.set('update.dismissedAt', new Date().toISOString());
      logger.info('UpdateService: Update dismissed', { version });
      this.emit('update-dismissed', version);
    } catch (error) {
      logger.error('UpdateService: Failed to dismiss update', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if a specific version update was dismissed
   * @param version - Version to check
   */
  async isUpdateDismissed(version: string): Promise<boolean> {
    try {
      const dismissedVersion = await this.deps.settings.get('update.dismissedVersion');
      return dismissedVersion === version;
    } catch {
      return false;
    }
  }

  /**
   * Get the current download status
   */
  getDownloadStatus(): DownloadStatus {
    return {
      state: this.downloadState,
      progress: this.downloadProgress,
      downloadPath: null, // electron-updater manages the download path internally
      error: this.downloadError,
    };
  }

  /**
   * Check if download is ready for installation
   */
  isDownloadReady(): boolean {
    return this.downloadState === 'complete';
  }

  /**
   * Check if download is in progress
   */
  isDownloading(): boolean {
    return this.downloadState === 'downloading';
  }

  /**
   * Get the download progress percentage (0-100)
   */
  getDownloadProgress(): number {
    return this.downloadProgress;
  }

  /**
   * Get the downloaded file path.
   * With electron-updater, the path is managed internally.
   */
  getDownloadPath(): string | null {
    // electron-updater manages the download path internally
    return null;
  }

  /**
   * Cancel an in-progress download.
   * Note: electron-updater doesn't have a native cancel method,
   * but we can reset state to allow a new download attempt.
   */
  cancelDownload(): void {
    // electron-updater doesn't expose a cancel method
    // Reset our state tracking
    this.downloadState = 'idle';
    this.downloadProgress = 0;
    this.downloadError = null;
    logger.info('UpdateService: Download cancelled (state reset)');
    this.emit('download-cancelled');
  }

  /**
   * Download the update using electron-updater.
   * Certificate pinning is handled automatically via Electron's session.
   */
  async downloadUpdate(): Promise<{ success: boolean; error?: string }> {
    // Check if already downloading
    if (this.downloadState === 'downloading') {
      logger.warn('UpdateService: Download already in progress');
      return { success: false, error: 'Download already in progress' };
    }

    // Check if already downloaded
    if (this.downloadState === 'complete') {
      logger.info('UpdateService: Update already downloaded');
      return { success: true };
    }

    // Check if we have update info
    if (!this.cachedUpdateInfo?.updateAvailable) {
      logger.error('UpdateService: No update available to download');
      return { success: false, error: 'No update available' };
    }

    try {
      // Reset state
      this.downloadState = 'downloading';
      this.downloadProgress = 0;
      this.downloadError = null;

      logger.info('UpdateService: Starting download via electron-updater');
      this.emit('download-started');

      // Download the update
      // This uses Electron's net module which respects session certificate pinning
      await autoUpdater.downloadUpdate();

      // Note: downloadState will be set to 'complete' by the 'update-downloaded' event handler

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.downloadState = 'error';
      this.downloadError = errorMessage;

      logger.error('UpdateService: Download failed', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      this.emit('download-error', errorMessage);

      return { success: false, error: errorMessage };
    }
  }

  /**
   * Install the downloaded update and restart the application.
   *
   * electron-updater handles platform-specific installation:
   * - Windows: NSIS installer with runAfterFinish flag relaunches the app
   * - macOS: Extracts ZIP and replaces app bundle, then relaunches
   * - Linux: AppImage self-updates and relaunches
   */
  async installAndRestart(): Promise<{ success: boolean; error?: string }> {
    if (this.downloadState !== 'complete') {
      logger.error('UpdateService: Download not complete, cannot install');
      return { success: false, error: 'Download not complete' };
    }

    try {
      logger.info('UpdateService: Installing update and restarting via electron-updater');

      // quitAndInstall handles platform-specific installation:
      // - isSilent: false = show progress to user
      // - isForceRunAfter: true = relaunch after installation
      //
      // On Windows with NSIS, the installer's runAfterFinish flag ensures
      // the app relaunches after the update completes.
      autoUpdater.quitAndInstall(false, true);

      // Note: This line may not execute as quitAndInstall triggers app quit
      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('UpdateService: Failed to install update', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Reset download state (useful for retry)
   */
  resetDownload(): void {
    this.downloadState = 'idle';
    this.downloadProgress = 0;
    this.downloadError = null;

    logger.info('UpdateService: Download state reset');
  }
}
