import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, dialog } from 'electron';

import { logger } from '../../logger';
import type { ISettingsService } from '../../storage/interfaces/ISettingsService';
import type { HeartbeatService } from '../heartbeat/HeartbeatService';

import type { LicenseService } from './LicenseService';

/**
 * Validation history entry
 */
export interface ValidationHistoryEntry {
  timestamp: string;
  success: boolean;
  validationType: 'online' | 'offline' | 'manual';
  errorMessage?: string;
  validationMode?: 'online' | 'offline';
}

/**
 * Complete diagnostics data structure
 */
export interface LicenseDiagnostics {
  // License Status
  licenseStatus: {
    status: string;
    type: string;
    validationMode: string;
    statusMessage: string | null;
  };

  // Cache Information
  cacheInfo: {
    lastValidatedAt: string | null;
    nextValidationAt: string | null;
    cacheAgeDays: number | null;
    daysUntilNextValidation: number | null;
  };

  // Features
  features: {
    enabled: string[];
    count: number;
  };

  // Validation History
  validationHistory: ValidationHistoryEntry[];

  // Heartbeat Status
  heartbeatStatus: {
    isRunning: boolean;
    isPaused: boolean;
    sessionToken: string; // Masked
    lastHeartbeatTime?: string | null;
    activeSessions?: number;
  };

  // Server Configuration
  serverConfig: {
    apiUrl: string;
    serverHealthy: boolean | null;
    lastChecked: string | null;
  };

  // Network Status
  networkStatus: {
    online: boolean;
    lastOnlineTime: string | null;
  };

  // System Information
  systemInfo: {
    appVersion: string;
    platform: string;
    clientId: string; // Masked
    electronVersion: string;
    nodeVersion: string;
  };

  // Error Logs (recent license-related errors)
  errorLogs: Array<{
    timestamp: string;
    level: string;
    message: string;
    context?: string;
  }>;

  // Metadata
  metadata: {
    generatedAt: string;
    diagnosticVersion: string;
  };
}

/**
 * DiagnosticsService Dependencies
 */
export interface DiagnosticsServiceDeps {
  licenseService: LicenseService;
  heartbeatService: HeartbeatService;
  settings: ISettingsService;
  getApiUrl: () => Promise<string>;
}

const VALIDATION_HISTORY_KEY = 'license.validationHistory';
const MAX_HISTORY_ENTRIES = 10;
const MAX_ERROR_LOGS = 20;
const DIAGNOSTIC_VERSION = '1.0.0';

/**
 * DiagnosticsService
 *
 * Collects comprehensive diagnostic information about license status,
 * validation history, heartbeat status, and system configuration.
 * All sensitive data (keys, tokens, full IDs) is masked for security.
 */
export class DiagnosticsService {
  private recentErrors: Array<{
    timestamp: string;
    level: string;
    message: string;
    context?: string;
  }> = [];

  constructor(private deps: DiagnosticsServiceDeps) {
    // Subscribe to license service errors
    this.setupErrorTracking();
  }

  /**
   * Setup error tracking for license-related errors
   */
  private setupErrorTracking(): void {
    // Hook into logger to capture license-related errors
    // This is a simplified implementation - in production you'd want
    // a more robust logging system
  }

  /**
   * Log an error for diagnostic purposes
   */
  logError(level: string, message: string, context?: string): void {
    this.recentErrors.unshift({
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    });

    // Keep only recent errors
    if (this.recentErrors.length > MAX_ERROR_LOGS) {
      this.recentErrors = this.recentErrors.slice(0, MAX_ERROR_LOGS);
    }
  }

  /**
   * Record a validation attempt in history
   */
  async recordValidation(entry: ValidationHistoryEntry): Promise<void> {
    try {
      const history = await this.getValidationHistory();
      history.unshift(entry);

      // Keep only the most recent entries
      const trimmed = history.slice(0, MAX_HISTORY_ENTRIES);

      await this.deps.settings.setJson(VALIDATION_HISTORY_KEY, trimmed);
    } catch (error) {
      logger.error('DiagnosticsService: Failed to record validation history', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Get validation history
   */
  async getValidationHistory(): Promise<ValidationHistoryEntry[]> {
    try {
      const history =
        await this.deps.settings.getJson<ValidationHistoryEntry[]>(VALIDATION_HISTORY_KEY);
      return history || [];
    } catch (error) {
      logger.warn('DiagnosticsService: Failed to get validation history', {
        error: error instanceof Error ? error.message : error,
      });
      return [];
    }
  }

  /**
   * Clear validation history
   */
  async clearValidationHistory(): Promise<void> {
    try {
      await this.deps.settings.delete(VALIDATION_HISTORY_KEY);
    } catch (error) {
      logger.error('DiagnosticsService: Failed to clear validation history', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Collect comprehensive diagnostic information
   */
  async collectDiagnostics(): Promise<LicenseDiagnostics> {
    logger.info('DiagnosticsService: Collecting diagnostics');

    const license = await this.deps.licenseService.getCurrentLicense();
    const heartbeatStatus = this.deps.heartbeatService.getStatus();
    const validationHistory = await this.getValidationHistory();
    const apiUrl = await this.deps.getApiUrl();

    // Calculate cache age
    let cacheAgeDays: number | null = null;
    if (license.lastValidatedAt) {
      const lastValidated = new Date(license.lastValidatedAt);
      const now = new Date();
      cacheAgeDays = (now.getTime() - lastValidated.getTime()) / (1000 * 60 * 60 * 24);
    }

    // Calculate days until next validation
    let daysUntilNextValidation: number | null = null;
    if (license.nextValidationAt) {
      const nextValidation = new Date(license.nextValidationAt);
      const now = new Date();
      daysUntilNextValidation = (nextValidation.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    }

    // Check server health
    let serverHealthy: boolean | null = null;
    let serverLastChecked: string | null = null;
    try {
      serverHealthy = await this.checkServerHealth(apiUrl);
      serverLastChecked = new Date().toISOString();
    } catch (error) {
      logger.warn('DiagnosticsService: Server health check failed', {
        error: error instanceof Error ? error.message : error,
      });
      serverHealthy = false;
      serverLastChecked = new Date().toISOString();
    }

    // Get client ID (masked)
    const clientId = await this.getClientId();

    // Get network status
    const online = navigator?.onLine ?? true;

    const diagnostics: LicenseDiagnostics = {
      licenseStatus: {
        status: license.status,
        type: license.type,
        validationMode: license.validationMode,
        statusMessage: license.statusMessage,
      },

      cacheInfo: {
        lastValidatedAt: license.lastValidatedAt,
        nextValidationAt: license.nextValidationAt,
        cacheAgeDays: cacheAgeDays !== null ? Math.round(cacheAgeDays * 100) / 100 : null,
        daysUntilNextValidation:
          daysUntilNextValidation !== null ? Math.round(daysUntilNextValidation * 100) / 100 : null,
      },

      features: {
        enabled: license.features,
        count: license.features.length,
      },

      validationHistory: validationHistory.slice(0, 5), // Last 5 entries

      heartbeatStatus: {
        isRunning: heartbeatStatus.isRunning,
        isPaused: heartbeatStatus.isPaused,
        sessionToken: heartbeatStatus.sessionToken, // Already masked
        lastHeartbeatTime: null, // TODO: Track this
        activeSessions: undefined, // TODO: Get from heartbeat service
      },

      serverConfig: {
        apiUrl,
        serverHealthy,
        lastChecked: serverLastChecked,
      },

      networkStatus: {
        online,
        lastOnlineTime: online ? new Date().toISOString() : null,
      },

      systemInfo: {
        appVersion: app.getVersion(),
        platform: process.platform,
        clientId,
        electronVersion: process.versions.electron,
        nodeVersion: process.versions.node,
      },

      errorLogs: this.recentErrors,

      metadata: {
        generatedAt: new Date().toISOString(),
        diagnosticVersion: DIAGNOSTIC_VERSION,
      },
    };

    logger.info('DiagnosticsService: Diagnostics collected successfully');
    return diagnostics;
  }

  /**
   * Export diagnostics to a JSON file
   * Opens a save dialog and writes the diagnostics to the selected file
   */
  async exportDiagnostics(): Promise<string> {
    const diagnostics = await this.collectDiagnostics();

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const defaultFilename = `notely-license-diagnostics-${timestamp}.json`;

    // Show save dialog
    const result = await dialog.showSaveDialog({
      title: 'Export License Diagnostics',
      defaultPath: join(app.getPath('documents'), defaultFilename),
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (result.canceled || !result.filePath) {
      throw new Error('Export canceled by user');
    }

    // Write diagnostics to file
    const content = JSON.stringify(diagnostics, null, 2);
    writeFileSync(result.filePath, content, 'utf8');

    logger.info('DiagnosticsService: Diagnostics exported successfully', {
      path: result.filePath,
    });

    return result.filePath;
  }

  /**
   * Check if the license server is healthy
   */
  private async checkServerHealth(apiUrl: string): Promise<boolean> {
    try {
      const healthUrl = `${apiUrl}/api/health`;
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      return response.ok;
    } catch (error) {
      logger.debug('DiagnosticsService: Server health check failed', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Get client ID (masked for security)
   */
  private async getClientId(): Promise<string> {
    try {
      const clientId = await this.deps.settings.get('heartbeat.clientId');
      if (!clientId) {
        return 'not-set';
      }
      return this.maskClientId(clientId);
    } catch (error) {
      return 'error-reading';
    }
  }

  /**
   * Mask client ID - show prefix and last 6 characters
   */
  private maskClientId(clientId: string): string {
    if (clientId.length <= 10) {
      return '***';
    }
    const prefix = clientId.substring(0, 8);
    const suffix = clientId.substring(clientId.length - 6);
    return `${prefix}...${suffix}`;
  }
}
