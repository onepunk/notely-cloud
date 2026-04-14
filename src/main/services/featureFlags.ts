import { EventEmitter } from 'node:events';

import { logger } from '../logger';
import type { ISettingsService } from '../storage/interfaces/ISettingsService';

import type { LicenseService, LicensePayload } from './license/LicenseService';

/**
 * Known feature flags that can be enabled via licenses.
 * Add new features here as they are implemented.
 */
export const KnownFeatures = {
  AI_SUMMARY: 'ai-summary',
  ADVANCED_SEARCH: 'advanced-search',
  TEAM_SHARING: 'team-sharing',
  CUSTOM_TEMPLATES: 'custom-templates',
  PRIORITY_SUPPORT: 'priority-support',
  CALENDAR_INTEGRATION: 'calendar-integration',
  OFFLINE_MODE: 'offline-mode',
  EXPORT_FORMATS: 'export-formats',
  CROSS_DEVICE_SYNC: 'cross-device-sync',
} as const;

export type FeatureKey = (typeof KnownFeatures)[keyof typeof KnownFeatures];

export interface FeatureFlagsService {
  /**
   * Check if a specific feature is enabled in the current license.
   * @param key - Feature key to check
   * @returns true if the feature is enabled, false otherwise
   */
  hasFeature(key: string): boolean;

  /**
   * Get all enabled features from the current license.
   * @returns Array of enabled feature keys
   */
  getEnabledFeatures(): string[];

  /**
   * Subscribe to feature flag changes.
   * @param listener - Callback invoked when features change
   * @returns Unsubscribe function
   */
  onFeaturesChanged(listener: (features: string[]) => void): () => void;
}

interface FeatureFlagsDeps {
  licenseService: LicenseService;
  settingsService?: ISettingsService;
}

/**
 * Service for managing feature flags based on the active license.
 *
 * Features are cached in memory for fast lookups and automatically
 * updated when the license changes.
 *
 * Usage:
 * ```typescript
 * if (featureFlags.hasFeature(KnownFeatures.AI_SUMMARY)) {
 *   // Show AI summary feature
 * }
 * ```
 */
export class FeatureFlagsServiceImpl extends EventEmitter implements FeatureFlagsService {
  private enabledFeatures: Set<string> = new Set();
  private unsubscribeLicense?: () => void;

  constructor(private deps: FeatureFlagsDeps) {
    super();
  }

  async initialize(): Promise<void> {
    try {
      // Load initial features from current license
      const license = await this.deps.licenseService.getCurrentLicense();
      this.updateFeatures(license);

      // Subscribe to license changes
      this.unsubscribeLicense = this.deps.licenseService.onChanged((payload) => {
        this.updateFeatures(payload);
      });

      logger.info('FeatureFlagsService: Initialized', {
        enabledFeatures: Array.from(this.enabledFeatures),
      });

      // Check if cross-device-sync feature is already present on initialization
      // This handles the case where user logs in with a Professional license on a new device
      if (this.hasFeature(KnownFeatures.CROSS_DEVICE_SYNC) && this.deps.settingsService) {
        logger.info(
          'FeatureFlagsService: Cross-device sync feature detected on init, checking sync config'
        );
        void this.enableSyncForLicensedUser();
      }
    } catch (error) {
      logger.error('FeatureFlagsService: Failed to initialize', {
        error: error instanceof Error ? error.message : error,
      });
      // Continue with empty feature set
      this.enabledFeatures = new Set();
    }
  }

  hasFeature(key: string): boolean {
    return this.enabledFeatures.has(key);
  }

  getEnabledFeatures(): string[] {
    return Array.from(this.enabledFeatures).sort();
  }

  onFeaturesChanged(listener: (features: string[]) => void): () => void {
    this.on('features-changed', listener);
    return () => {
      this.off('features-changed', listener);
    };
  }

  cleanup(): void {
    if (this.unsubscribeLicense) {
      this.unsubscribeLicense();
      this.unsubscribeLicense = undefined;
    }
    this.removeAllListeners();
    logger.info('FeatureFlagsService: Cleaned up');
  }

  private updateFeatures(license: LicensePayload): void {
    const previousFeatures = new Set(this.enabledFeatures);

    // Update feature set from license
    this.enabledFeatures = new Set(license.features || []);

    // Check if features changed
    const featuresChanged =
      previousFeatures.size !== this.enabledFeatures.size ||
      !Array.from(previousFeatures).every((f) => this.enabledFeatures.has(f));

    if (featuresChanged) {
      logger.info('FeatureFlagsService: Features updated', {
        previous: Array.from(previousFeatures),
        current: Array.from(this.enabledFeatures),
      });

      this.emit('features-changed', this.getEnabledFeatures());

      // Auto-enable sync when cross-device-sync feature is granted
      const hasCrossDeviceSync = this.enabledFeatures.has(KnownFeatures.CROSS_DEVICE_SYNC);
      const hadCrossDeviceSync = previousFeatures.has(KnownFeatures.CROSS_DEVICE_SYNC);

      if (hasCrossDeviceSync && !hadCrossDeviceSync && this.deps.settingsService) {
        logger.info('FeatureFlagsService: Cross-device sync feature enabled, auto-enabling sync');
        void this.enableSyncForLicensedUser();
      }
    }
  }

  /**
   * Automatically enable sync when a user has the cross-device-sync license feature.
   * This ensures users with Professional licenses have sync enabled by default.
   *
   * Uses the settings table (key: 'syncEnabled') as the single source of truth
   * for sync enabled state. This is what the UI reads and writes.
   */
  private async enableSyncForLicensedUser(): Promise<void> {
    if (!this.deps.settingsService) {
      logger.warn('FeatureFlagsService: Cannot enable sync - no settings service available');
      return;
    }

    try {
      // Read syncEnabled from settings table - the single source of truth
      const currentValue = await this.deps.settingsService.get('syncEnabled');
      const isCurrentlyEnabled = currentValue === 'true';

      // Only enable if currently disabled - don't override user's explicit choice
      if (!isCurrentlyEnabled) {
        await this.deps.settingsService.set('syncEnabled', 'true');
        logger.info(
          'FeatureFlagsService: Sync auto-enabled for licensed user (settings.syncEnabled = true)'
        );
      } else {
        logger.info('FeatureFlagsService: Sync already enabled for licensed user');
      }
    } catch (error) {
      logger.error('FeatureFlagsService: Failed to auto-enable sync', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
