import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import type {
  HeartbeatStatus,
  HeartbeatLimitExceeded,
  LicenseWarning,
  LicenseValidatedEvent,
  LicenseExpiredEvent,
  LicenseSnapshot,
  UpgradePollingStatus,
} from '../../shared/types/license';
import { DEFAULT_API_URL } from '../config';
import { logger } from '../logger';
import type { FeatureFlagsService } from '../services/featureFlags';
import type { HeartbeatService } from '../services/heartbeat/HeartbeatService';
import type {
  DiagnosticsService,
  LicenseDiagnostics,
} from '../services/license/DiagnosticsService';
import { LicenseService, type LicensePayload } from '../services/license/LicenseService';
import { ServerHealthService } from '../services/license/ServerHealthService';
import type { UpgradePollingService } from '../services/license/UpgradePollingService';

const ValidateSchema = z.object({
  key: z.string().min(1, 'License key is required'),
});

export interface LicenseHandlersDeps {
  licenseService: LicenseService;
  featureFlagsService: FeatureFlagsService;
  heartbeatService: HeartbeatService;
  diagnosticsService?: DiagnosticsService;
  upgradePollingService?: UpgradePollingService;
  mainWindow?: BrowserWindow | null;
}

export class LicenseHandlers {
  private mainWindow: BrowserWindow | null;
  private unsubscribeLicense?: () => void;
  private unsubscribeFeatures?: () => void;
  private serverHealthService: ServerHealthService;

  constructor(private deps: LicenseHandlersDeps) {
    this.mainWindow = deps.mainWindow ?? null;
    this.serverHealthService = new ServerHealthService();
  }

  register(): void {
    logger.debug('LicenseHandlers: Registering IPC handlers');

    // Register IPC handlers
    ipcMain.handle('license:get-current', this.handleGetCurrent.bind(this));
    ipcMain.handle('license:validate', this.handleValidate.bind(this));
    ipcMain.handle('license:clear-cache', this.handleClear.bind(this));
    ipcMain.handle('license:get-features', this.handleGetFeatures.bind(this));
    ipcMain.handle('license:has-feature', this.handleHasFeature.bind(this));
    ipcMain.handle('license:manual-check', this.handleManualCheck.bind(this));
    ipcMain.handle('license:check-server-health', this.handleCheckServerHealth.bind(this));
    ipcMain.handle('license:set-api-url', this.handleSetApiUrl.bind(this));
    ipcMain.handle('license:get-api-url', this.handleGetApiUrl.bind(this));
    ipcMain.handle('license:fetch-current', this.handleFetchCurrent.bind(this));
    ipcMain.handle('heartbeat:get-status', this.handleGetHeartbeatStatus.bind(this));
    ipcMain.handle('license:get-diagnostics', this.handleGetDiagnostics.bind(this));
    ipcMain.handle('license:export-diagnostics', this.handleExportDiagnostics.bind(this));
    ipcMain.handle(
      'license:clear-validation-history',
      this.handleClearValidationHistory.bind(this)
    );

    // Upgrade polling handlers
    ipcMain.handle('license:start-upgrade-polling', this.handleStartUpgradePolling.bind(this));
    ipcMain.handle('license:stop-upgrade-polling', this.handleStopUpgradePolling.bind(this));
    ipcMain.handle(
      'license:get-upgrade-polling-status',
      this.handleGetUpgradePollingStatus.bind(this)
    );

    // Subscribe to license changes
    this.unsubscribeLicense = this.deps.licenseService.onChanged((payload) => {
      this.handleLicenseChanged(payload);
    });

    // Subscribe to feature flag changes
    this.unsubscribeFeatures = this.deps.featureFlagsService.onFeaturesChanged((features) => {
      this.broadcastFeaturesChanged(features);
    });

    // Subscribe to heartbeat service events
    this.setupHeartbeatListeners();
  }

  updateMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  cleanup(): void {
    logger.info('LicenseHandlers: Cleaning up handlers');

    // Remove IPC handlers
    ipcMain.removeHandler('license:get-current');
    ipcMain.removeHandler('license:validate');
    ipcMain.removeHandler('license:clear-cache');
    ipcMain.removeHandler('license:get-features');
    ipcMain.removeHandler('license:has-feature');
    ipcMain.removeHandler('license:manual-check');
    ipcMain.removeHandler('license:check-server-health');
    ipcMain.removeHandler('license:set-api-url');
    ipcMain.removeHandler('license:get-api-url');
    ipcMain.removeHandler('license:fetch-current');
    ipcMain.removeHandler('heartbeat:get-status');
    ipcMain.removeHandler('license:get-diagnostics');
    ipcMain.removeHandler('license:export-diagnostics');
    ipcMain.removeHandler('license:clear-validation-history');
    ipcMain.removeHandler('license:start-upgrade-polling');
    ipcMain.removeHandler('license:stop-upgrade-polling');
    ipcMain.removeHandler('license:get-upgrade-polling-status');

    // Unsubscribe from services
    if (this.unsubscribeLicense) {
      this.unsubscribeLicense();
      this.unsubscribeLicense = undefined;
    }

    if (this.unsubscribeFeatures) {
      this.unsubscribeFeatures();
      this.unsubscribeFeatures = undefined;
    }

    // Remove heartbeat listeners
    this.cleanupHeartbeatListeners();
  }

  private async handleGetCurrent(): Promise<LicensePayload> {
    try {
      return await this.deps.licenseService.getCurrentLicense();
    } catch (error) {
      logger.error('LicenseHandlers: Failed to get current license', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private async handleValidate(
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<LicensePayload> {
    try {
      const { key } = ValidateSchema.parse(payload);
      return await this.deps.licenseService.validateLicense(key);
    } catch (error) {
      logger.warn('LicenseHandlers: License validation failed', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private async handleClear(): Promise<void> {
    try {
      await this.deps.licenseService.clearLicense();
    } catch (error) {
      logger.error('LicenseHandlers: Failed to clear license cache', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private async handleGetFeatures(): Promise<string[]> {
    try {
      return this.deps.featureFlagsService.getEnabledFeatures();
    } catch (error) {
      logger.error('LicenseHandlers: Failed to get features', {
        error: error instanceof Error ? error.message : error,
      });
      return [];
    }
  }

  private async handleHasFeature(
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<boolean> {
    try {
      const key = typeof payload === 'string' ? payload : (payload as { key: string })?.key;
      if (!key) {
        throw new Error('Feature key is required');
      }
      return this.deps.featureFlagsService.hasFeature(key);
    } catch (error) {
      logger.error('LicenseHandlers: Failed to check feature', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Handle manual license check
   * Triggers a re-validation of the current license
   */
  private async handleManualCheck(): Promise<LicensePayload> {
    try {
      const currentLicense = await this.deps.licenseService.getCurrentLicense();

      if (currentLicense.status === 'unlicensed') {
        throw new Error('No license key configured. Please enter a license key first.');
      }

      // Re-validate using the stored license key
      // This requires accessing the internal license key, which we'll need to add a method for
      logger.info('LicenseHandlers: Manual license check requested');

      // For now, just return the current license
      // TODO: Add a method to LicenseService to re-validate the current key
      return currentLicense;
    } catch (error) {
      logger.error('LicenseHandlers: Failed to perform manual license check', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get heartbeat service status
   */
  private async handleGetHeartbeatStatus(): Promise<HeartbeatStatus> {
    try {
      const status = this.deps.heartbeatService.getStatus();
      return status;
    } catch (error) {
      logger.error('LicenseHandlers: Failed to get heartbeat status', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Check server health
   */
  private async handleCheckServerHealth(
    _event: Electron.IpcMainInvokeEvent,
    apiUrl?: string
  ): Promise<{ online: boolean; responseTime: number; error?: string }> {
    try {
      return await this.serverHealthService.checkHealth(apiUrl);
    } catch (error) {
      logger.error('LicenseHandlers: Failed to check server health', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Set custom API URL
   */
  private async handleSetApiUrl(
    _event: Electron.IpcMainInvokeEvent,
    rawUrl: string | null
  ): Promise<void> {
    try {
      const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';

      if (!trimmed) {
        await this.deps.licenseService['deps'].settings.delete('server.apiUrl');
        this.serverHealthService.clearCache();
        logger.info('LicenseHandlers: Custom API URL cleared');
        return;
      }

      // Basic URL validation
      try {
        const parsed = new URL(trimmed);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error('URL must use http or https protocol');
        }
      } catch {
        throw new Error('Invalid URL format');
      }

      await this.deps.licenseService['deps'].settings.set('server.apiUrl', trimmed);
      this.serverHealthService.clearCache();

      logger.info('LicenseHandlers: Custom API URL set', { url: trimmed });
    } catch (error) {
      logger.error('LicenseHandlers: Failed to set API URL', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get current API URL
   */
  private async handleGetApiUrl(): Promise<string> {
    try {
      return await this.deps.licenseService.resolveApiUrl();
    } catch (error) {
      logger.error('LicenseHandlers: Failed to resolve API URL', {
        error: error instanceof Error ? error.message : error,
      });
      return DEFAULT_API_URL;
    }
  }

  /**
   * Fetch current license from backend
   * Calls /api/license/current with the user's access token
   */
  private async handleFetchCurrent(): Promise<LicensePayload> {
    try {
      return await this.deps.licenseService.fetchCurrentLicense();
    } catch (error) {
      logger.error('LicenseHandlers: Failed to fetch current license', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Handle license changed event
   * Manages heartbeat service lifecycle based on license status
   */
  private handleLicenseChanged(payload: LicensePayload): void {
    logger.info('LicenseHandlers: License changed', {
      status: payload.status,
      type: payload.type,
      features: payload.features.length,
    });

    // Broadcast to renderer
    this.broadcastChange(payload);

    // Emit validated event
    this.broadcastValidated({
      success: payload.status === 'active',
      mode: payload.validationMode,
      timestamp: new Date().toISOString(),
    });

    // Check for expiry
    if (payload.status === 'expired') {
      this.broadcastExpired({
        expiresAt: payload.expiresAt || new Date().toISOString(),
        timestamp: new Date().toISOString(),
      });
    }

    // Check for warnings
    this.checkAndEmitWarnings(payload);

    // Manage heartbeat service lifecycle
    if (payload.status === 'active') {
      // Start heartbeat for active licenses
      void this.deps.heartbeatService.start();
    } else {
      // Stop heartbeat for inactive licenses
      this.deps.heartbeatService.stop();
    }
  }

  /**
   * Check license status and emit warnings if needed
   */
  private checkAndEmitWarnings(payload: LicensePayload): void {
    const now = new Date();

    // Check cache age
    if (payload.lastValidatedAt) {
      const lastValidated = new Date(payload.lastValidatedAt);
      const hoursSinceValidation = (now.getTime() - lastValidated.getTime()) / (1000 * 60 * 60);

      if (hoursSinceValidation > 24) {
        this.broadcastWarning({
          type: 'cache-age-warning',
          message: `License hasn't been validated in ${Math.floor(hoursSinceValidation)} hours. Consider checking your connection.`,
          severity: 'warning',
          timestamp: now.toISOString(),
        });
      }
    }

    // Check if validation is overdue
    if (payload.nextValidationAt) {
      const nextValidation = new Date(payload.nextValidationAt);
      if (now > nextValidation) {
        this.broadcastWarning({
          type: 'validation-overdue',
          message: 'License validation is overdue. Please connect to the internet to validate.',
          severity: 'warning',
          timestamp: now.toISOString(),
        });
      }
    }

    // Check expiry warning (7 days before expiry)
    if (payload.expiresAt && payload.status === 'active') {
      const expiresAt = new Date(payload.expiresAt);
      const daysUntilExpiry = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

      if (daysUntilExpiry > 0 && daysUntilExpiry <= 7) {
        this.broadcastWarning({
          type: 'expiry-warning',
          message: `Your license expires in ${Math.ceil(daysUntilExpiry)} days. Please renew to continue using all features.`,
          severity: 'warning',
          timestamp: now.toISOString(),
        });
      }
    }
  }

  /**
   * Setup heartbeat service event listeners
   */
  private setupHeartbeatListeners(): void {
    // Listen for limit exceeded
    this.deps.heartbeatService.on('heartbeat:limit-exceeded', (data) => {
      logger.warn('LicenseHandlers: Heartbeat limit exceeded', data);
      this.broadcastLimitExceeded({
        activeSessions: data.activeSessions,
        sessionLimit: data.sessionLimit,
        warnings: data.warnings,
        timestamp: new Date().toISOString(),
      });
    });

    // Listen for offline mode
    this.deps.heartbeatService.on('heartbeat:offline', () => {
      logger.info('LicenseHandlers: Heartbeat service went offline');
      this.broadcastWarning({
        type: 'offline-mode',
        message: 'Connection lost. License is now running in offline mode.',
        severity: 'warning',
        timestamp: new Date().toISOString(),
      });
    });

    // Listen for online mode
    this.deps.heartbeatService.on('heartbeat:online', () => {
      logger.info('LicenseHandlers: Heartbeat service came online');
      // Trigger license validation when coming back online
      void this.handleManualCheck();
    });

    // Listen for license changes detected via heartbeat
    this.deps.heartbeatService.on(
      'heartbeat:license-changed',
      async (snapshot: LicenseSnapshot) => {
        logger.info('LicenseHandlers: License change detected via heartbeat', {
          licenseId: snapshot.licenseId,
          status: snapshot.status,
          hasLicense: snapshot.hasLicense,
        });

        // If a new license was detected or license became active, fetch full details
        if (snapshot.hasLicense && snapshot.status === 'active') {
          try {
            await this.deps.licenseService.fetchCurrentLicense();
            // The fetchCurrentLicense will emit 'changed' event which triggers UI update
          } catch (error) {
            logger.error('LicenseHandlers: Failed to fetch updated license', {
              error: error instanceof Error ? error.message : error,
            });
          }
        } else if (
          !snapshot.hasLicense ||
          snapshot.status === 'expired' ||
          snapshot.status === 'revoked'
        ) {
          // License was removed or expired - clear local license
          await this.deps.licenseService.clearLicense();
        }
      }
    );

    // Setup upgrade polling listeners if service is available
    this.setupUpgradePollingListeners();
  }

  /**
   * Setup upgrade polling service event listeners
   */
  private setupUpgradePollingListeners(): void {
    if (!this.deps.upgradePollingService) {
      return;
    }

    // Listen for status changes
    this.deps.upgradePollingService.on('status:changed', (status: UpgradePollingStatus) => {
      this.broadcastUpgradePollingStatus(status);
    });

    // Listen for upgrade success
    this.deps.upgradePollingService.on('upgrade:success', (license: LicensePayload) => {
      logger.info('LicenseHandlers: Upgrade success detected via polling');
      this.broadcastUpgradeSuccess(license);
    });
  }

  /**
   * Cleanup heartbeat service listeners
   */
  private cleanupHeartbeatListeners(): void {
    this.deps.heartbeatService.removeAllListeners('heartbeat:limit-exceeded');
    this.deps.heartbeatService.removeAllListeners('heartbeat:offline');
    this.deps.heartbeatService.removeAllListeners('heartbeat:online');
    this.deps.heartbeatService.removeAllListeners('heartbeat:license-changed');

    // Cleanup upgrade polling listeners
    if (this.deps.upgradePollingService) {
      this.deps.upgradePollingService.removeAllListeners('status:changed');
      this.deps.upgradePollingService.removeAllListeners('upgrade:success');
    }
  }

  /**
   * Handle start upgrade polling request
   */
  private async handleStartUpgradePolling(): Promise<void> {
    if (!this.deps.upgradePollingService) {
      logger.warn('LicenseHandlers: UpgradePollingService not available');
      return;
    }
    await this.deps.upgradePollingService.startUpgradePolling();
  }

  /**
   * Handle stop upgrade polling request
   */
  private async handleStopUpgradePolling(): Promise<void> {
    if (!this.deps.upgradePollingService) {
      logger.warn('LicenseHandlers: UpgradePollingService not available');
      return;
    }
    await this.deps.upgradePollingService.stopUpgradePolling();
  }

  /**
   * Handle get upgrade polling status request
   */
  private handleGetUpgradePollingStatus(): UpgradePollingStatus {
    if (!this.deps.upgradePollingService) {
      return { isActive: false, startedAt: null, timeRemainingMs: null };
    }
    return this.deps.upgradePollingService.getStatus();
  }

  /**
   * Broadcast license change to renderer
   */
  private broadcastChange(payload: LicensePayload): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('license:changed', payload);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast license change', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Broadcast license validation event to renderer
   */
  private broadcastValidated(event: LicenseValidatedEvent): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('license:validated', event);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast license validated event', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Broadcast license expired event to renderer
   */
  private broadcastExpired(event: LicenseExpiredEvent): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('license:expired', event);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast license expired event', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Broadcast license warning to renderer
   */
  private broadcastWarning(warning: LicenseWarning): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('license:warning', warning);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast license warning', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Broadcast features changed to renderer
   */
  private broadcastFeaturesChanged(features: string[]): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('license:features-changed', features);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast features change', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Broadcast heartbeat limit exceeded to renderer
   */
  private broadcastLimitExceeded(event: HeartbeatLimitExceeded): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('heartbeat:limit-exceeded', event);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast heartbeat limit exceeded', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Broadcast upgrade polling status to renderer
   */
  private broadcastUpgradePollingStatus(status: UpgradePollingStatus): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('license:upgrade-polling-status', status);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast upgrade polling status', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Broadcast upgrade success to renderer
   */
  private broadcastUpgradeSuccess(license: LicensePayload): void {
    if (!this.mainWindow) {
      return;
    }
    try {
      this.mainWindow.webContents.send('license:upgrade-success', license);
    } catch (error) {
      logger.warn('LicenseHandlers: Failed to broadcast upgrade success', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Handle get diagnostics request
   * Returns comprehensive diagnostic information
   */
  private async handleGetDiagnostics(): Promise<LicenseDiagnostics> {
    try {
      return await this.deps.diagnosticsService.collectDiagnostics();
    } catch (error) {
      logger.error('LicenseHandlers: Failed to get diagnostics', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Handle export diagnostics request
   * Opens save dialog and exports diagnostics to JSON file
   */
  private async handleExportDiagnostics(): Promise<{
    success: boolean;
    path?: string;
    error?: string;
  }> {
    try {
      const path = await this.deps.diagnosticsService.exportDiagnostics();
      return { success: true, path };
    } catch (error) {
      logger.error('LicenseHandlers: Failed to export diagnostics', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export diagnostics',
      };
    }
  }

  /**
   * Handle clear validation history request
   */
  private async handleClearValidationHistory(): Promise<void> {
    try {
      await this.deps.diagnosticsService.clearValidationHistory();
    } catch (error) {
      logger.error('LicenseHandlers: Failed to clear validation history', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }
}
