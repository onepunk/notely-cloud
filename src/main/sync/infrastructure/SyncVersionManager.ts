/**
 * Desktop Sync Version Manager
 *
 * Manages feature flags and version selection for v1/v2 sync systems
 * Provides safe rollout and fallback mechanisms
 *
 * References:
 * - /notely/SYNC_RE_ARCHITECTURE.md - Implementation Phases
 * - /notely/SYNC_RE_ARCHITECTURE_TODO.md - Phase 6 requirements
 * - Server version manager: /notely-platform/server/api/config/syncVersionManager.js
 *
 * Date: 2025-09-09
 */

import { createHash, randomUUID } from 'crypto';
import { hostname } from 'os';

import { logger } from '../../logger';
import { IStorageService } from '../../storage/interfaces';

/**
 * Sync version types
 */
export type SyncVersion = 'v1' | 'v2';

/**
 * Sync version configuration
 */
export interface SyncVersionConfig {
  version: SyncVersion;
  enabled: boolean;
  forceVersion?: SyncVersion;
  rolloutPercentage: number;
  userOverride?: SyncVersion;
  fallbackOnError: boolean;
  maxRetries: number;
}

/**
 * Sync version decision result
 */
export interface SyncVersionDecision {
  version: SyncVersion;
  reason: 'user_override' | 'force_version' | 'rollout_percentage' | 'fallback' | 'default';
  fallbackAvailable: boolean;
}

/**
 * Sync version metrics
 */
export interface SyncVersionMetrics {
  v1Attempts: number;
  v1Successes: number;
  v1Failures: number;
  v2Attempts: number;
  v2Successes: number;
  v2Failures: number;
  fallbacks: number;
  lastUpdated: number;
}

/**
 * Desktop Sync Version Manager - handles version selection and rollout
 */
export class DesktopSyncVersionManager {
  private static readonly CONFIG_KEY = 'sync.version.config';
  private static readonly METRICS_KEY = 'sync.version.metrics';
  private static readonly DEFAULT_CONFIG: SyncVersionConfig = {
    version: 'v1',
    enabled: true,
    rolloutPercentage: 0,
    fallbackOnError: true,
    maxRetries: 3,
  };

  private config: SyncVersionConfig;
  private metrics: SyncVersionMetrics;
  private deviceHash: string;
  private isInitialized = false;

  constructor(private storage: IStorageService) {
    this.config = { ...DesktopSyncVersionManager.DEFAULT_CONFIG };
    this.metrics = this.createEmptyMetrics();
    this.deviceHash = '';
  }

  /**
   * Initialize the version manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Generate or load device hash for consistent rollout
      this.deviceHash = await this.getOrCreateDeviceHash();

      // Load configuration and metrics
      await this.loadConfiguration();
      await this.loadMetrics();

      this.isInitialized = true;
      logger.info('[SyncVersionManager] Initialized', {
        version: this.config.version,
        rolloutPercentage: this.config.rolloutPercentage,
        deviceHash: this.deviceHash.substring(0, 8) + '...',
      });
    } catch (error) {
      logger.error('[SyncVersionManager] Failed to initialize:', error);
      throw new Error(`Sync version manager initialization failed: ${error}`);
    }
  }

  /**
   * Decide which sync version to use for this operation
   */
  async decideSyncVersion(): Promise<SyncVersionDecision> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // Check for user override first
    if (this.config.userOverride) {
      logger.debug('[SyncVersionManager] Using user override', {
        version: this.config.userOverride,
      });

      return {
        version: this.config.userOverride,
        reason: 'user_override',
        fallbackAvailable: this.config.fallbackOnError && this.config.userOverride === 'v2',
      };
    }

    // Check for force version (admin/testing override)
    if (this.config.forceVersion) {
      logger.debug('[SyncVersionManager] Using force version', {
        version: this.config.forceVersion,
      });

      return {
        version: this.config.forceVersion,
        reason: 'force_version',
        fallbackAvailable: this.config.fallbackOnError && this.config.forceVersion === 'v2',
      };
    }

    // Check rollout percentage
    if (this.shouldUseV2BasedOnRollout()) {
      logger.debug('[SyncVersionManager] Using v2 based on rollout', {
        rolloutPercentage: this.config.rolloutPercentage,
        deviceHash: this.deviceHash.substring(0, 8) + '...',
      });

      return {
        version: 'v2',
        reason: 'rollout_percentage',
        fallbackAvailable: this.config.fallbackOnError,
      };
    }

    // Default to v1
    logger.debug('[SyncVersionManager] Using default v1');

    return {
      version: 'v1',
      reason: 'default',
      fallbackAvailable: false,
    };
  }

  /**
   * Record sync operation success
   */
  async recordSuccess(version: SyncVersion): Promise<void> {
    this.updateMetrics(version, 'success');
    await this.saveMetrics();

    logger.debug('[SyncVersionManager] Recorded success', { version });
  }

  /**
   * Record sync operation failure
   */
  async recordFailure(version: SyncVersion, error?: string): Promise<void> {
    this.updateMetrics(version, 'failure');
    await this.saveMetrics();

    logger.warn('[SyncVersionManager] Recorded failure', { version, error });
  }

  /**
   * Record fallback from v2 to v1
   */
  async recordFallback(): Promise<void> {
    this.metrics.fallbacks++;
    this.metrics.lastUpdated = Date.now();
    await this.saveMetrics();

    logger.info('[SyncVersionManager] Recorded fallback from v2 to v1');
  }

  /**
   * Get current sync version configuration
   */
  getConfiguration(): SyncVersionConfig {
    return { ...this.config };
  }

  /**
   * Update sync version configuration
   */
  async updateConfiguration(updates: Partial<SyncVersionConfig>): Promise<void> {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...updates };

    await this.saveConfiguration();

    logger.info('[SyncVersionManager] Configuration updated', {
      oldVersion: oldConfig.version,
      newVersion: this.config.version,
      oldRollout: oldConfig.rolloutPercentage,
      newRollout: this.config.rolloutPercentage,
      updates,
    });
  }

  /**
   * Get sync version metrics
   */
  getMetrics(): SyncVersionMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset metrics
   */
  async resetMetrics(): Promise<void> {
    this.metrics = this.createEmptyMetrics();
    await this.saveMetrics();

    logger.info('[SyncVersionManager] Metrics reset');
  }

  /**
   * Get or create device ID for sync
   * Retrieves the existing device ID from settings or generates a new one.
   * This is the SINGLE SOURCE OF TRUTH for device identification.
   */
  async getOrCreateDeviceId(): Promise<string> {
    const DEVICE_ID_KEY = 'sync.device_id';

    try {
      // Check if device ID already exists
      const existingDeviceId = await this.storage.settings.get(DEVICE_ID_KEY);
      if (existingDeviceId) {
        logger.debug('[SyncVersionManager] Using existing device ID');
        return existingDeviceId;
      }

      // Generate new device ID
      const newDeviceId = randomUUID();
      await this.storage.settings.set(DEVICE_ID_KEY, newDeviceId);

      logger.info('[SyncVersionManager] Created new device ID', {
        deviceId: newDeviceId.substring(0, 8) + '...',
      });

      return newDeviceId;
    } catch (error) {
      logger.error('[SyncVersionManager] Failed to get or create device ID', { error });
      throw new Error(`Failed to get or create device ID: ${error}`);
    }
  }

  /**
   * @deprecated Use getOrCreateDeviceId() instead
   */
  async getOrCreateNodeId(): Promise<string> {
    return this.getOrCreateDeviceId();
  }

  /**
   * Check if v2 should be used based on rollout percentage
   */
  private shouldUseV2BasedOnRollout(): boolean {
    if (this.config.rolloutPercentage <= 0) {
      return false;
    }

    if (this.config.rolloutPercentage >= 100) {
      return true;
    }

    // Use device hash for consistent rollout
    const hashNum = parseInt(this.deviceHash.substring(0, 8), 16);
    const percentage = (hashNum % 10000) / 100; // Convert to 0-99.99 percentage

    return percentage < this.config.rolloutPercentage;
  }

  /**
   * Get or create device hash for consistent rollout
   */
  private async getOrCreateDeviceHash(): Promise<string> {
    try {
      // Try to get device ID from the single source of truth
      const deviceId = await this.storage.settings.get('sync.device_id');
      if (deviceId) {
        return this.hashString(deviceId);
      }

      // Fallback to creating a hash from system info
      const systemInfo = {
        platform: process.platform,
        arch: process.arch,
        hostname: hostname(),
        timestamp: Date.now(),
      };

      return this.hashString(JSON.stringify(systemInfo));
    } catch (error) {
      logger.warn('[SyncVersionManager] Failed to create device hash, using random', { error });
      return this.hashString(Math.random().toString());
    }
  }

  /**
   * Create hash from string
   */
  private hashString(str: string): string {
    return createHash('sha256').update(str).digest('hex');
  }

  /**
   * Load configuration from storage
   */
  private async loadConfiguration(): Promise<void> {
    try {
      const stored = await this.storage.settings.get(DesktopSyncVersionManager.CONFIG_KEY);
      if (stored) {
        this.config = {
          ...DesktopSyncVersionManager.DEFAULT_CONFIG,
          ...JSON.parse(stored),
        };

        logger.debug('[SyncVersionManager] Configuration loaded', this.config);
      }
    } catch (error) {
      logger.warn('[SyncVersionManager] Failed to load configuration, using defaults', { error });
    }
  }

  /**
   * Save configuration to storage
   */
  private async saveConfiguration(): Promise<void> {
    try {
      await this.storage.settings.set(
        DesktopSyncVersionManager.CONFIG_KEY,
        JSON.stringify(this.config)
      );
    } catch (error) {
      logger.error('[SyncVersionManager] Failed to save configuration', { error });
    }
  }

  /**
   * Load metrics from storage
   */
  private async loadMetrics(): Promise<void> {
    try {
      const stored = await this.storage.settings.get(DesktopSyncVersionManager.METRICS_KEY);
      if (stored) {
        this.metrics = {
          ...this.createEmptyMetrics(),
          ...JSON.parse(stored),
        };

        logger.debug('[SyncVersionManager] Metrics loaded', this.metrics);
      }
    } catch (error) {
      logger.warn('[SyncVersionManager] Failed to load metrics, using empty', { error });
    }
  }

  /**
   * Save metrics to storage
   */
  private async saveMetrics(): Promise<void> {
    try {
      await this.storage.settings.set(
        DesktopSyncVersionManager.METRICS_KEY,
        JSON.stringify(this.metrics)
      );
    } catch (error) {
      logger.error('[SyncVersionManager] Failed to save metrics', { error });
    }
  }

  /**
   * Update metrics for operation
   */
  private updateMetrics(version: SyncVersion, result: 'success' | 'failure'): void {
    if (version === 'v1') {
      this.metrics.v1Attempts++;
      if (result === 'success') {
        this.metrics.v1Successes++;
      } else {
        this.metrics.v1Failures++;
      }
    } else {
      this.metrics.v2Attempts++;
      if (result === 'success') {
        this.metrics.v2Successes++;
      } else {
        this.metrics.v2Failures++;
      }
    }

    this.metrics.lastUpdated = Date.now();
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): SyncVersionMetrics {
    return {
      v1Attempts: 0,
      v1Successes: 0,
      v1Failures: 0,
      v2Attempts: 0,
      v2Successes: 0,
      v2Failures: 0,
      fallbacks: 0,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Get success rate for version
   */
  getSuccessRate(version: SyncVersion): number {
    const metrics = this.metrics;

    if (version === 'v1') {
      if (metrics.v1Attempts === 0) return 0;
      return metrics.v1Successes / metrics.v1Attempts;
    } else {
      if (metrics.v2Attempts === 0) return 0;
      return metrics.v2Successes / metrics.v2Attempts;
    }
  }

  /**
   * Check if fallback should be triggered
   */
  shouldFallbackToV1(): boolean {
    if (!this.config.fallbackOnError) {
      return false;
    }

    const v2SuccessRate = this.getSuccessRate('v2');
    const v1SuccessRate = this.getSuccessRate('v1');

    // If v2 success rate is significantly lower than v1, consider fallback
    if (this.metrics.v2Attempts >= 5 && v2SuccessRate < 0.5 && v1SuccessRate > 0.8) {
      return true;
    }

    return false;
  }

  /**
   * Cleanup resources
   */
  async shutdown(): Promise<void> {
    await this.saveConfiguration();
    await this.saveMetrics();
    this.isInitialized = false;
    logger.info('[SyncVersionManager] Shutdown complete');
  }

  /**
   * Get sync version configuration (alias for getConfiguration)
   */
  async getSyncVersionConfig(): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    return this.config as unknown as Record<string, unknown>;
  }

  /**
   * Check if sync v2 should be used
   */
  async shouldUseSyncV2(): Promise<boolean> {
    const decision = await this.decideSyncVersion();
    return decision.version === 'v2';
  }

  /**
   * Set user sync v2 enabled preference
   */
  async setUserSyncV2Enabled(enabled: boolean): Promise<void> {
    await this.updateConfiguration({
      userOverride: enabled ? 'v2' : undefined,
    });
  }

  /**
   * Refresh sync version from server
   * Currently a no-op as configuration is local
   */
  async refreshServerSyncVersion(): Promise<void> {
    // Reload configuration from storage
    await this.loadConfiguration();
    logger.info('[SyncVersionManager] Refreshed sync version configuration');
  }

  /**
   * Get debug information
   */
  async getDebugInfo(): Promise<Record<string, unknown>> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    return {
      config: this.config,
      metrics: this.metrics,
      deviceHash: this.deviceHash.substring(0, 8) + '...',
      isInitialized: this.isInitialized,
      successRateV1: this.getSuccessRate('v1'),
      successRateV2: this.getSuccessRate('v2'),
      shouldFallback: this.shouldFallbackToV1(),
    };
  }

  /**
   * Clear all sync v2 settings
   */
  async clearSyncV2Settings(): Promise<void> {
    this.config = { ...DesktopSyncVersionManager.DEFAULT_CONFIG };
    this.metrics = this.createEmptyMetrics();
    await this.saveConfiguration();
    await this.saveMetrics();
    logger.info('[SyncVersionManager] Cleared all sync v2 settings');
  }
}

// Export singleton factory
export const createDesktopSyncVersionManager = (
  storage: IStorageService
): DesktopSyncVersionManager => {
  return new DesktopSyncVersionManager(storage);
};

// Export alias for backwards compatibility
export { DesktopSyncVersionManager as SyncVersionManager };
