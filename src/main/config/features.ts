/**
 * Feature Flags System
 *
 * Enables gradual rollout of new features with remote configuration support.
 * Monolithic backend is decommissioned - desktop connects directly to V3 microservices.
 *
 * Architecture:
 * - Remote config from feature flag service (V3 platform)
 * - Local file-based fallback for offline operation
 * - User-level targeting for gradual rollout
 * - Dynamic reloading without restart
 *
 * Date: 2025-11-04
 */

import { logger } from '../logger';

/**
 * Feature flag definitions
 * Each flag controls a specific feature or capability
 */
export interface FeatureFlags {
  /**
   * Enable enhanced telemetry for sync operations
   * Tracks detailed metrics about sync performance
   */
  enableSyncTelemetry: boolean;

  /**
   * Enable feature flag refresh interval (ms)
   * 0 = disabled, reload only on manual trigger
   */
  featureFlagRefreshIntervalMs: number;
}

/**
 * Remote feature flag response from config service
 */
export interface RemoteFeatureFlagResponse {
  userId: string;
  flags: Partial<FeatureFlags>;
  timestamp: number;
  environment: 'development' | 'staging' | 'production';
}

/**
 * Feature flag configuration
 */
export interface FeatureFlagConfig {
  /**
   * URL of the remote feature flag service
   * Example: https://api.yourdomain.com/v3/config/features
   */
  remoteConfigUrl: string | null;

  /**
   * Path to local feature flag file
   * Used as fallback when remote is unavailable
   */
  localConfigPath: string | null;

  /**
   * Timeout for remote config requests (ms)
   */
  requestTimeoutMs: number;

  /**
   * Cache duration for feature flags (ms)
   * Flags are cached to reduce API calls
   */
  cacheDurationMs: number;

  /**
   * Refresh interval for automatic updates (ms)
   * 0 = disabled
   */
  refreshIntervalMs: number;
}

/**
 * Safe default feature flags
 */
export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  enableSyncTelemetry: true, // Always enable telemetry
  featureFlagRefreshIntervalMs: 300000, // 5 minutes
};

/**
 * Default configuration for feature flag service
 */
export const DEFAULT_FEATURE_FLAG_CONFIG: FeatureFlagConfig = {
  remoteConfigUrl: null, // Must be configured
  localConfigPath: null, // Optional local override
  requestTimeoutMs: 5000, // 5 second timeout
  cacheDurationMs: 60000, // 1 minute cache
  refreshIntervalMs: 300000, // 5 minute refresh
};

/**
 * Feature flag cache entry
 */
interface FeatureFlagCacheEntry {
  flags: FeatureFlags;
  timestamp: number;
  source: 'remote' | 'local' | 'default';
}

/**
 * Feature flag loader with remote and local fallback
 */
export class FeatureFlagLoader {
  private cache: FeatureFlagCacheEntry | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor(private config: FeatureFlagConfig) {
    logger.info('FeatureFlagLoader: Initialized', {
      remoteConfigUrl: config.remoteConfigUrl,
      localConfigPath: config.localConfigPath,
      refreshIntervalMs: config.refreshIntervalMs,
    });
  }

  /**
   * Load feature flags for a user
   * Priority: cache -> remote -> local -> defaults
   */
  async loadFeatureFlags(userId: string, accessToken?: string): Promise<FeatureFlags> {
    try {
      // Check cache first
      if (this.isCacheValid()) {
        logger.debug('FeatureFlagLoader: Using cached flags', {
          source: this.cache?.source,
          age: Date.now() - (this.cache?.timestamp || 0),
        });
        return this.cache!.flags;
      }

      // Try remote config
      if (this.config.remoteConfigUrl && accessToken) {
        try {
          const remoteFlags = await this.loadRemoteFlags(userId, accessToken);
          if (remoteFlags) {
            this.updateCache(remoteFlags, 'remote');
            return remoteFlags;
          }
        } catch (error) {
          logger.warn('FeatureFlagLoader: Remote config failed, falling back', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Try local config file
      if (this.config.localConfigPath) {
        try {
          const localFlags = await this.loadLocalFlags();
          if (localFlags) {
            this.updateCache(localFlags, 'local');
            return localFlags;
          }
        } catch (error) {
          logger.warn('FeatureFlagLoader: Local config failed, using defaults', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Fallback to safe defaults
      logger.info('FeatureFlagLoader: Using default flags (no remote/local config)');
      this.updateCache(DEFAULT_FEATURE_FLAGS, 'default');
      return DEFAULT_FEATURE_FLAGS;
    } catch (error) {
      logger.error('FeatureFlagLoader: Error loading flags, using defaults', {
        error: error instanceof Error ? error.message : error,
      });
      return DEFAULT_FEATURE_FLAGS;
    }
  }

  /**
   * Load feature flags from remote config service
   */
  private async loadRemoteFlags(userId: string, accessToken: string): Promise<FeatureFlags | null> {
    if (!this.config.remoteConfigUrl) {
      return null;
    }

    try {
      const url = `${this.config.remoteConfigUrl}/${userId}`;
      logger.debug('FeatureFlagLoader: Fetching remote flags', { url });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        logger.warn('FeatureFlagLoader: Remote config request failed', {
          status: response.status,
          statusText: response.statusText,
        });
        return null;
      }

      const data: RemoteFeatureFlagResponse = await response.json();
      logger.info('FeatureFlagLoader: Loaded remote flags', {
        userId: data.userId,
        environment: data.environment,
        timestamp: data.timestamp,
      });

      // Merge with defaults to ensure all flags are present
      return {
        ...DEFAULT_FEATURE_FLAGS,
        ...data.flags,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.warn('FeatureFlagLoader: Remote config request timed out');
      } else {
        logger.error('FeatureFlagLoader: Error fetching remote flags', {
          error: error instanceof Error ? error.message : error,
        });
      }
      return null;
    }
  }

  /**
   * Load feature flags from local file
   */
  private async loadLocalFlags(): Promise<FeatureFlags | null> {
    if (!this.config.localConfigPath) {
      return null;
    }

    try {
      const fs = await import('node:fs/promises');
      const content = await fs.readFile(this.config.localConfigPath, 'utf-8');
      const data = JSON.parse(content) as Partial<FeatureFlags>;

      logger.info('FeatureFlagLoader: Loaded local flags', {
        path: this.config.localConfigPath,
      });

      // Merge with defaults to ensure all flags are present
      return {
        ...DEFAULT_FEATURE_FLAGS,
        ...data,
      };
    } catch (error) {
      logger.error('FeatureFlagLoader: Error reading local config', {
        path: this.config.localConfigPath,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Check if cached flags are still valid
   */
  private isCacheValid(): boolean {
    if (!this.cache) {
      return false;
    }

    const age = Date.now() - this.cache.timestamp;
    return age < this.config.cacheDurationMs;
  }

  /**
   * Update the feature flag cache
   */
  private updateCache(flags: FeatureFlags, source: 'remote' | 'local' | 'default'): void {
    this.cache = {
      flags,
      timestamp: Date.now(),
      source,
    };

    logger.debug('FeatureFlagLoader: Cache updated', {
      source,
      timestamp: this.cache.timestamp,
    });
  }

  /**
   * Manually refresh feature flags
   */
  async refresh(userId: string, accessToken?: string): Promise<FeatureFlags> {
    logger.info('FeatureFlagLoader: Manual refresh triggered');
    this.cache = null; // Invalidate cache
    return this.loadFeatureFlags(userId, accessToken);
  }

  /**
   * Start automatic refresh interval
   */
  startAutoRefresh(userId: string, accessToken?: string): void {
    if (this.refreshInterval) {
      logger.warn('FeatureFlagLoader: Auto-refresh already started');
      return;
    }

    if (this.config.refreshIntervalMs <= 0) {
      logger.info('FeatureFlagLoader: Auto-refresh disabled (interval <= 0)');
      return;
    }

    logger.info('FeatureFlagLoader: Starting auto-refresh', {
      intervalMs: this.config.refreshIntervalMs,
    });

    this.refreshInterval = setInterval(async () => {
      try {
        await this.refresh(userId, accessToken);
      } catch (error) {
        logger.error('FeatureFlagLoader: Auto-refresh failed', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }, this.config.refreshIntervalMs);
  }

  /**
   * Stop automatic refresh interval
   */
  stopAutoRefresh(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
      logger.info('FeatureFlagLoader: Auto-refresh stopped');
    }
  }

  /**
   * Get current cached flags (or null if no cache)
   */
  getCachedFlags(): FeatureFlags | null {
    return this.cache?.flags || null;
  }

  /**
   * Get cache metadata
   */
  getCacheMetadata(): { age: number; source: string } | null {
    if (!this.cache) {
      return null;
    }

    return {
      age: Date.now() - this.cache.timestamp,
      source: this.cache.source,
    };
  }
}
