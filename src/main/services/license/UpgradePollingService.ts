import { EventEmitter } from 'node:events';

import type { UpgradePollingStatus } from '../../../shared/types/license';
import { logger } from '../../logger';
import type { ISettingsService } from '../../storage/interfaces/ISettingsService';

import type { LicensePayload, LicenseService } from './LicenseService';

const FAST_POLL_INTERVAL_MS = 10000; // 10 seconds during active upgrade
const FAST_POLL_TIMEOUT_MS = 300000; // 5 minutes max fast polling
const DEBOUNCE_MS = 5000; // Min time between checks
const STORAGE_KEY = 'license.upgradePolling';

interface UpgradePollingState {
  isActive: boolean;
  startedAt: number | null;
}

interface UpgradePollingServiceDeps {
  settings: ISettingsService;
  licenseService: LicenseService;
}

/**
 * UpgradePollingService
 *
 * Manages fast polling for license updates during an external upgrade flow.
 * When the user initiates an upgrade, this service polls every 10 seconds
 * to detect when their license becomes active.
 *
 * Features:
 * - Fast polling (10s) during active upgrade flow
 * - Automatic timeout after 5 minutes
 * - State persistence for recovery after app restart
 * - Debouncing to prevent duplicate API calls
 * - Automatic stop when license becomes active
 *
 * Events:
 * - 'status:changed': Emitted when polling status changes
 * - 'upgrade:success': Emitted when license transitions to active during polling
 */
export class UpgradePollingService extends EventEmitter {
  private state: UpgradePollingState = { isActive: false, startedAt: null };
  private pollInterval: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private lastCheckTime = 0;
  private previousLicenseStatus: string | null = null;

  constructor(private deps: UpgradePollingServiceDeps) {
    super();
  }

  async initialize(): Promise<void> {
    // Load persisted state
    try {
      const stored = await this.deps.settings.getJson<UpgradePollingState>(STORAGE_KEY);
      if (stored?.isActive && stored.startedAt) {
        const elapsed = Date.now() - stored.startedAt;
        if (elapsed < FAST_POLL_TIMEOUT_MS) {
          logger.info('UpgradePollingService: Resuming upgrade polling from persisted state', {
            elapsedMs: elapsed,
            remainingMs: FAST_POLL_TIMEOUT_MS - elapsed,
          });
          await this.resumePolling(stored.startedAt);
        } else {
          logger.info('UpgradePollingService: Persisted polling state expired, clearing');
          await this.clearPersistedState();
        }
      }
    } catch (error) {
      logger.warn('UpgradePollingService: Failed to load persisted state', {
        error: error instanceof Error ? error.message : error,
      });
    }

    // Get initial license status
    try {
      const currentLicense = await this.deps.licenseService.getCurrentLicense();
      this.previousLicenseStatus = currentLicense.status;
    } catch (error) {
      logger.warn('UpgradePollingService: Failed to get initial license status', {
        error: error instanceof Error ? error.message : error,
      });
    }

    // Listen for license changes
    this.deps.licenseService.on('changed', (license: LicensePayload) =>
      this.handleLicenseChange(license)
    );
  }

  async startUpgradePolling(): Promise<void> {
    if (this.state.isActive) {
      logger.info('UpgradePollingService: Already polling, ignoring start request');
      return;
    }

    const startedAt = Date.now();
    this.state = { isActive: true, startedAt };

    // Persist state for recovery after app restart
    await this.persistState();

    // Start polling interval
    this.pollInterval = setInterval(() => {
      void this.pollLicense();
    }, FAST_POLL_INTERVAL_MS);

    // Start timeout timer
    this.timeoutTimer = setTimeout(() => {
      void this.stopUpgradePolling('timeout');
    }, FAST_POLL_TIMEOUT_MS);

    // Perform immediate check
    void this.pollLicense();

    logger.info('UpgradePollingService: Started upgrade polling', {
      intervalMs: FAST_POLL_INTERVAL_MS,
      timeoutMs: FAST_POLL_TIMEOUT_MS,
    });

    this.emitStatusChange();
  }

  async stopUpgradePolling(reason: 'success' | 'timeout' | 'manual' = 'manual'): Promise<void> {
    if (!this.state.isActive) {
      return;
    }

    // Clear timers
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }

    this.state = { isActive: false, startedAt: null };
    await this.clearPersistedState();

    logger.info('UpgradePollingService: Stopped upgrade polling', { reason });
    this.emitStatusChange();
  }

  getStatus(): UpgradePollingStatus {
    const timeRemainingMs =
      this.state.isActive && this.state.startedAt
        ? Math.max(0, FAST_POLL_TIMEOUT_MS - (Date.now() - this.state.startedAt))
        : null;

    return {
      isActive: this.state.isActive,
      startedAt: this.state.startedAt,
      timeRemainingMs,
    };
  }

  /**
   * Check license with debouncing - can be called by visibility change handler
   */
  async checkLicenseDebounced(): Promise<void> {
    const now = Date.now();
    if (now - this.lastCheckTime < DEBOUNCE_MS) {
      logger.debug('UpgradePollingService: Skipping check, too recent');
      return;
    }
    await this.pollLicense();
  }

  private async pollLicense(): Promise<void> {
    this.lastCheckTime = Date.now();

    try {
      logger.debug('UpgradePollingService: Polling license');
      await this.deps.licenseService.fetchCurrentLicense();
      // License change will be handled by handleLicenseChange
    } catch (error) {
      logger.warn('UpgradePollingService: License poll failed', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private handleLicenseChange(license: LicensePayload): void {
    const previousStatus = this.previousLicenseStatus;
    this.previousLicenseStatus = license.status;

    // Check for upgrade success: unlicensed -> active
    if (this.state.isActive && previousStatus === 'unlicensed' && license.status === 'active') {
      logger.info('UpgradePollingService: License activated, stopping polling');
      void this.stopUpgradePolling('success');
      this.emit('upgrade:success', license);
    }
  }

  private async resumePolling(originalStartedAt: number): Promise<void> {
    this.state = { isActive: true, startedAt: originalStartedAt };

    const elapsed = Date.now() - originalStartedAt;
    const remaining = FAST_POLL_TIMEOUT_MS - elapsed;

    // Start polling interval
    this.pollInterval = setInterval(() => {
      void this.pollLicense();
    }, FAST_POLL_INTERVAL_MS);

    // Start timeout with remaining time
    this.timeoutTimer = setTimeout(() => {
      void this.stopUpgradePolling('timeout');
    }, remaining);

    // Perform immediate check
    void this.pollLicense();

    this.emitStatusChange();
  }

  private async persistState(): Promise<void> {
    try {
      await this.deps.settings.setJson(STORAGE_KEY, this.state);
    } catch (error) {
      logger.warn('UpgradePollingService: Failed to persist state', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private async clearPersistedState(): Promise<void> {
    try {
      await this.deps.settings.delete(STORAGE_KEY);
    } catch (error) {
      logger.warn('UpgradePollingService: Failed to clear persisted state', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private emitStatusChange(): void {
    this.emit('status:changed', this.getStatus());
  }

  cleanup(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    this.removeAllListeners();
  }
}
