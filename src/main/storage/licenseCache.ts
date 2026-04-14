/**
 * License cache storage module - Manages offline license validation caching with expiry
 */

import { logger } from '../logger';

import type { ISettingsService } from './interfaces/ISettingsService';

// Cache storage key in settings service
const LICENSE_CACHE_KEY = 'license.validation.cache';

// Cache expiry configuration (in days)
export const CACHE_CONFIG = {
  MAX_AGE_DAYS: 7,
  WARNING_THRESHOLD_DAYS: 6,
  CRITICAL_THRESHOLD_DAYS: 7,
} as const;

/**
 * Warning levels based on cache age
 */
export type CacheWarningLevel = 'none' | 'warning' | 'critical' | 'expired';

/**
 * Cached license validation data
 */
export interface CachedValidation {
  licenseKey: string;
  validatedAt: number; // Unix timestamp in milliseconds
  expiresAt: string | null; // ISO 8601 string from license payload
  features: string[];
  isValid: boolean;
  issuedTo: string | null;
  tier: 'public' | 'custom';
}

/**
 * Cache status information
 */
export interface CacheStatus {
  age: number; // Age in days (fractional)
  warningLevel: CacheWarningLevel;
  daysRemaining: number; // Days until cache expires (can be negative)
  isExpired: boolean;
}

/**
 * License cache service for managing offline validation
 */
export class LicenseCache {
  constructor(private settings: ISettingsService) {}

  /**
   * Get cached validation if it exists
   */
  async getCachedValidation(): Promise<CachedValidation | null> {
    try {
      const cached = await this.settings.getJson<CachedValidation>(LICENSE_CACHE_KEY);

      if (!cached) {
        logger.debug('LicenseCache: No cached validation found');
        return null;
      }

      // Validate the structure
      if (!this.isValidCachedValidation(cached)) {
        logger.warn('LicenseCache: Invalid cached validation structure, clearing cache');
        await this.clearCache();
        return null;
      }

      logger.debug('LicenseCache: Retrieved cached validation', {
        validatedAt: new Date(cached.validatedAt).toISOString(),
        licenseKey: this.maskLicenseKey(cached.licenseKey),
      });

      return cached;
    } catch (error) {
      logger.error('LicenseCache: Failed to get cached validation', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Store a new validation in cache
   */
  async setCachedValidation(validation: CachedValidation): Promise<void> {
    try {
      // Ensure timestamp is set
      const validationWithTimestamp: CachedValidation = {
        ...validation,
        validatedAt: validation.validatedAt || Date.now(),
      };

      await this.settings.setJson(LICENSE_CACHE_KEY, validationWithTimestamp);

      logger.info('LicenseCache: Stored new validation in cache', {
        validatedAt: new Date(validationWithTimestamp.validatedAt).toISOString(),
        licenseKey: this.maskLicenseKey(validationWithTimestamp.licenseKey),
      });
    } catch (error) {
      logger.error('LicenseCache: Failed to set cached validation', {
        error: error instanceof Error ? error.message : error,
      });
      throw new Error(
        `Failed to cache license validation: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  /**
   * Clear the cached validation
   */
  async clearCache(): Promise<void> {
    try {
      await this.settings.delete(LICENSE_CACHE_KEY);
      logger.info('LicenseCache: Cache cleared');
    } catch (error) {
      logger.warn('LicenseCache: Failed to clear cache', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Get cache age in days (fractional)
   */
  getCacheAge(validatedAt: number, now: number = Date.now()): number {
    const ageMs = now - validatedAt;
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    return ageDays;
  }

  /**
   * Get comprehensive cache status
   */
  getCacheStatus(validatedAt: number, now: number = Date.now()): CacheStatus {
    const age = this.getCacheAge(validatedAt, now);
    const daysRemaining = CACHE_CONFIG.MAX_AGE_DAYS - age;
    const isExpired = age > CACHE_CONFIG.MAX_AGE_DAYS;

    let warningLevel: CacheWarningLevel;
    if (isExpired) {
      warningLevel = 'expired';
    } else if (age >= CACHE_CONFIG.CRITICAL_THRESHOLD_DAYS) {
      warningLevel = 'critical';
    } else if (age >= CACHE_CONFIG.WARNING_THRESHOLD_DAYS) {
      warningLevel = 'warning';
    } else {
      warningLevel = 'none';
    }

    return {
      age,
      warningLevel,
      daysRemaining,
      isExpired,
    };
  }

  /**
   * Get status message for display to user
   */
  getStatusMessage(status: CacheStatus): string | null {
    if (status.isExpired) {
      return 'License validation expired. Please connect to the internet to revalidate.';
    }

    if (status.warningLevel === 'critical') {
      const daysLeft = Math.ceil(status.daysRemaining);
      if (daysLeft === 1) {
        return 'License validation expires in 1 day. Please connect to validate soon.';
      } else if (daysLeft === 0) {
        return 'License validation expires today. Please connect to the internet.';
      }
    }

    if (status.warningLevel === 'warning') {
      const daysLeft = Math.ceil(status.daysRemaining);
      return `License validation expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Please connect to validate soon.`;
    }

    return null;
  }

  /**
   * Check if cache should be used based on age
   */
  isCacheUsable(validatedAt: number, now: number = Date.now()): boolean {
    const age = this.getCacheAge(validatedAt, now);
    return age <= CACHE_CONFIG.MAX_AGE_DAYS;
  }

  /**
   * Validate cached validation structure
   */
  private isValidCachedValidation(data: unknown): data is CachedValidation {
    if (!data || typeof data !== 'object') {
      return false;
    }

    const validation = data as Record<string, unknown>;

    return (
      typeof validation.licenseKey === 'string' &&
      typeof validation.validatedAt === 'number' &&
      (validation.expiresAt === null || typeof validation.expiresAt === 'string') &&
      Array.isArray(validation.features) &&
      typeof validation.isValid === 'boolean' &&
      (validation.issuedTo === null || typeof validation.issuedTo === 'string') &&
      (validation.tier === 'public' || validation.tier === 'custom')
    );
  }

  /**
   * Mask license key for logging (show prefix and last 4 chars)
   */
  private maskLicenseKey(key: string): string {
    if (key.length <= 8) {
      return '***';
    }
    const prefix = key.substring(0, 3);
    const suffix = key.substring(key.length - 4);
    return `${prefix}...${suffix}`;
  }
}

/**
 * Create a new license cache instance
 */
export function createLicenseCache(settings: ISettingsService): LicenseCache {
  return new LicenseCache(settings);
}
