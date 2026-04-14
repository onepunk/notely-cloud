/**
 * Feature Flag Service
 *
 * Central service for managing feature flags across the application.
 *
 * Features:
 * - Singleton pattern for global access
 * - Automatic refresh on auth context changes
 * - Event emission for flag updates
 * - Safe defaults and error handling
 *
 * Date: 2025-11-04
 */

import { EventEmitter } from 'node:events';

import { type AuthContext } from '../auth';
import { logger } from '../logger';

import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_FEATURE_FLAG_CONFIG,
  type FeatureFlagConfig,
  type FeatureFlags,
  FeatureFlagLoader,
} from './features';

/**
 * Feature flag events
 */
export interface FeatureFlagEvents {
  updated: (flags: FeatureFlags) => void;
  error: (error: Error) => void;
}

/**
 * Feature Flag Service
 * Singleton service for managing feature flags
 */
export class FeatureFlagService extends EventEmitter {
  private static instance: FeatureFlagService | null = null;
  private loader: FeatureFlagLoader;
  private currentFlags: FeatureFlags;
  private currentUserId: string | null = null;
  private currentAccessToken: string | null = null;

  private constructor(config?: Partial<FeatureFlagConfig>) {
    super();

    const fullConfig: FeatureFlagConfig = {
      ...DEFAULT_FEATURE_FLAG_CONFIG,
      ...config,
    };

    this.loader = new FeatureFlagLoader(fullConfig);
    this.currentFlags = DEFAULT_FEATURE_FLAGS;

    logger.info('FeatureFlagService: Initialized', {
      remoteConfigUrl: fullConfig.remoteConfigUrl,
      localConfigPath: fullConfig.localConfigPath,
    });
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<FeatureFlagConfig>): FeatureFlagService {
    if (!FeatureFlagService.instance) {
      FeatureFlagService.instance = new FeatureFlagService(config);
    }
    return FeatureFlagService.instance;
  }

  /**
   * Initialize feature flags with auth context
   */
  async initialize(authContext: AuthContext | null): Promise<FeatureFlags> {
    try {
      if (!authContext) {
        logger.info('FeatureFlagService: No auth context, using defaults');
        this.currentFlags = DEFAULT_FEATURE_FLAGS;
        return this.currentFlags;
      }

      this.currentUserId = authContext.userId;
      this.currentAccessToken = authContext.accessToken;

      logger.info('FeatureFlagService: Loading flags for user', {
        userId: authContext.userId,
      });

      this.currentFlags = await this.loader.loadFeatureFlags(
        authContext.userId,
        authContext.accessToken
      );

      this.emit('updated', this.currentFlags);

      // Start auto-refresh if enabled
      const refreshInterval = this.currentFlags.featureFlagRefreshIntervalMs;
      if (refreshInterval > 0) {
        this.loader.startAutoRefresh(authContext.userId, authContext.accessToken);
      }

      logger.info('FeatureFlagService: Flags loaded', {
        enableSyncTelemetry: this.currentFlags.enableSyncTelemetry,
        featureFlagRefreshIntervalMs: this.currentFlags.featureFlagRefreshIntervalMs,
      });

      return this.currentFlags;
    } catch (error) {
      logger.error('FeatureFlagService: Failed to initialize', {
        error: error instanceof Error ? error.message : error,
      });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return DEFAULT_FEATURE_FLAGS;
    }
  }

  /**
   * Get current feature flags
   */
  getFlags(): FeatureFlags {
    return { ...this.currentFlags };
  }

  /**
   * Check if a specific flag is enabled
   */
  isEnabled(flagName: keyof FeatureFlags): boolean {
    const value = this.currentFlags[flagName];
    return typeof value === 'boolean' ? value : false;
  }

  /**
   * Manually refresh feature flags
   */
  async refresh(): Promise<FeatureFlags> {
    try {
      if (!this.currentUserId) {
        logger.warn('FeatureFlagService: Cannot refresh without user context');
        return this.currentFlags;
      }

      logger.info('FeatureFlagService: Refreshing flags');

      const previousFlags = { ...this.currentFlags };
      this.currentFlags = await this.loader.refresh(
        this.currentUserId,
        this.currentAccessToken || undefined
      );

      // Check if flags changed
      const flagsChanged = JSON.stringify(previousFlags) !== JSON.stringify(this.currentFlags);
      if (flagsChanged) {
        logger.info('FeatureFlagService: Flags updated after refresh', {
          previous: previousFlags,
          current: this.currentFlags,
        });
        this.emit('updated', this.currentFlags);
      } else {
        logger.debug('FeatureFlagService: No changes after refresh');
      }

      return this.currentFlags;
    } catch (error) {
      logger.error('FeatureFlagService: Failed to refresh', {
        error: error instanceof Error ? error.message : error,
      });
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
      return this.currentFlags;
    }
  }

  /**
   * Update auth context (triggers reload if changed)
   */
  async updateAuthContext(authContext: AuthContext | null): Promise<FeatureFlags> {
    const userIdChanged = this.currentUserId !== authContext?.userId;
    const tokenChanged = this.currentAccessToken !== authContext?.accessToken;

    if (userIdChanged || tokenChanged) {
      logger.info('FeatureFlagService: Auth context changed, reloading flags', {
        userIdChanged,
        tokenChanged,
      });

      // Stop auto-refresh for old context
      this.loader.stopAutoRefresh();

      // Load flags for new context
      return this.initialize(authContext);
    }

    return this.currentFlags;
  }

  /**
   * Get cache metadata
   */
  getCacheMetadata(): { age: number; source: string } | null {
    return this.loader.getCacheMetadata();
  }

  /**
   * Stop auto-refresh and cleanup
   */
  shutdown(): void {
    logger.info('FeatureFlagService: Shutting down');
    this.loader.stopAutoRefresh();
    this.removeAllListeners();
  }

  /**
   * Reset to defaults (for testing)
   */
  resetToDefaults(): void {
    logger.info('FeatureFlagService: Resetting to defaults');
    this.currentFlags = DEFAULT_FEATURE_FLAGS;
    this.currentUserId = null;
    this.currentAccessToken = null;
    this.loader.stopAutoRefresh();
  }
}

/**
 * Helper function to get feature flag service instance
 */
export function getFeatureFlagService(config?: Partial<FeatureFlagConfig>): FeatureFlagService {
  return FeatureFlagService.getInstance(config);
}
