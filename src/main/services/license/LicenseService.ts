import { EventEmitter } from 'node:events';

import { DEFAULT_API_URL } from '../../config';
import { logger } from '../../logger';
import type { ISettingsService } from '../../storage/interfaces/ISettingsService';
import { pinnedFetch, getKeystoreService } from '../security';

export type LicenseStatus = 'unlicensed' | 'active' | 'expiring' | 'expired' | 'invalid';
export type LicenseTier = 'public' | 'custom' | 'unknown'; // Legacy type based on license_type
export type LicenseTierKey = 'free' | 'starter' | 'professional' | 'enterprise' | 'unknown'; // Actual pricing tier
export type LicenseValidationMode = 'online' | 'offline';
export type LicenseGrantType = 'purchase' | 'beta' | 'trial' | 'promotional' | 'admin_grant'; // How license was acquired

export interface LicensePayload {
  status: LicenseStatus;
  type: LicenseTier; // Legacy: 'public' or 'custom'
  tierKey: LicenseTierKey; // Actual tier: 'free', 'starter', 'professional', 'enterprise'
  tierName: string; // Display name: 'Free', 'Starter', 'Professional', 'Enterprise'
  grantType?: LicenseGrantType; // How the license was acquired
  isBeta?: boolean; // Convenience flag for beta licenses
  validationMode: LicenseValidationMode;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  nextValidationAt: string | null;
  features: string[];
  issuedTo: string | null;
  statusMessage: string | null;
}

type StoredLicense = LicensePayload & {
  licenseKey: string | null;
};

interface LicenseServiceDeps {
  settings: ISettingsService;
}

/**
 * API response from /api/license/validate endpoint
 */
interface OnlineValidationResponse {
  valid: boolean;
  reason?: string;
  licenseId?: string;
  type?: string; // Legacy: 'public' or 'custom'
  tierKey?: string; // Actual tier: 'free', 'starter', 'professional', 'enterprise'
  tierName?: string; // Display name: 'Free', 'Starter', 'Professional', 'Enterprise'
  grantType?: string; // How the license was acquired
  isBeta?: boolean; // Convenience flag for beta licenses
  productType?: string;
  organizationId?: string;
  userId?: string;
  features?: Record<string, boolean>;
  limits?: Record<string, number>;
  issuedAt?: string;
  expiresAt?: string;
  hardwareId?: string;
}

const LICENSE_STORAGE_KEY = 'license.cache';
const LICENSE_KEY_REGEX = /^(np|nd)-([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const DEFAULT_REVALIDATE_MINUTES = 60;
const ONLINE_VALIDATION_TIMEOUT_MS = 10000; // 10 seconds

export class LicenseService extends EventEmitter {
  private cachedLicense: StoredLicense | null = null;

  constructor(private deps: LicenseServiceDeps) {
    super();
  }

  async initialize(): Promise<void> {
    try {
      const cached = await this.deps.settings.getJson<StoredLicense>(LICENSE_STORAGE_KEY);
      if (cached) {
        this.cachedLicense = cached;
      } else {
        this.cachedLicense = this.buildDefault();
      }
    } catch (error) {
      logger.warn('LicenseService: Failed to load cached license, using defaults', {
        error: error instanceof Error ? error.message : error,
      });
      this.cachedLicense = this.buildDefault();
    }
  }

  async getCurrentLicense(): Promise<LicensePayload> {
    if (!this.cachedLicense) {
      await this.initialize();
    }
    return this.stripInternalFields(this.cachedLicense!);
  }

  /**
   * Get the stored license key (for re-validation purposes)
   * @returns The stored license key, or null if no license is stored
   */
  async getStoredLicenseKey(): Promise<string | null> {
    if (!this.cachedLicense) {
      await this.initialize();
    }
    return this.cachedLicense?.licenseKey || null;
  }

  async validateLicense(licenseKey: string): Promise<LicensePayload> {
    const normalized = this.normalizeInput(licenseKey);

    logger.info('LicenseService: Attempting online validation (offline mode disabled)');
    const onlineResult = await this.validateOnline(normalized);
    logger.info('LicenseService: Online validation successful');
    return onlineResult;
  }

  async clearLicense(): Promise<void> {
    this.cachedLicense = this.buildDefault();
    try {
      await this.deps.settings.delete(LICENSE_STORAGE_KEY);
    } catch (error) {
      logger.warn('LicenseService: Failed to delete cached license key', {
        error: error instanceof Error ? error.message : error,
      });
    }
    this.emitChange(this.cachedLicense);
  }

  /**
   * Fetch the current user's license from the backend /api/license/current endpoint
   * Requires an authenticated user with valid access token
   *
   * @returns A LicensePayload with the user's current license information
   * @throws Error if fetch fails, user is not authenticated, or response is invalid
   */
  async fetchCurrentLicense(): Promise<LicensePayload> {
    // Get auth token from OS keystore
    const keystoreService = getKeystoreService();
    let accessToken: string | null = null;
    try {
      accessToken = await keystoreService.getAccessToken();
    } catch (error) {
      logger.warn('LicenseService: Failed to retrieve access token from keystore', {
        error: error instanceof Error ? error.message : error,
      });
    }
    if (!accessToken) {
      throw new Error('Authentication required to fetch license');
    }

    const apiUrl = await this.resolveApiUrl();
    const currentLicenseUrl = `${apiUrl}/api/license/current?format=desktop`;

    logger.info('LicenseService: Fetching current license from backend', {
      url: currentLicenseUrl,
    });

    try {
      const response = await pinnedFetch(currentLicenseUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(ONLINE_VALIDATION_TIMEOUT_MS),
      });

      // Check HTTP status
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Authentication expired. Please log in again.');
        } else if (response.status === 404) {
          // No license found - update cache to unlicensed state
          const unlicensedState: StoredLicense = {
            status: 'unlicensed',
            type: 'unknown',
            tierKey: 'unknown',
            tierName: 'Unknown',
            validationMode: 'online',
            expiresAt: null,
            lastValidatedAt: new Date().toISOString(),
            nextValidationAt: null,
            features: [],
            issuedTo: this.cachedLicense?.issuedTo || null,
            statusMessage: 'No license found for this user',
            licenseKey: null,
          };

          await this.persist(unlicensedState);
          this.emitChange(unlicensedState);

          logger.info('LicenseService: Updated cache to unlicensed (no license found)', {
            previousStatus: this.cachedLicense?.status,
          });

          throw new Error('No license found for this user.');
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else if (response.status >= 500) {
          throw new Error(`License server error (${response.status}). Please try again later.`);
        } else {
          throw new Error(`Failed to fetch license with status ${response.status}`);
        }
      }

      const data: OnlineValidationResponse = await response.json();

      // Check if license is valid
      if (!data.valid) {
        const reason = data.reason || 'Unknown reason';
        logger.warn('LicenseService: Fetched license is not valid', { reason });

        // CRITICAL: Update cached license to reflect the invalid/revoked state
        // This ensures the UI shows the correct status instead of stale "active" cache
        const invalidLicense: StoredLicense = {
          status: 'invalid',
          type: 'unknown',
          tierKey: 'unknown',
          tierName: 'Unknown',
          validationMode: 'online',
          expiresAt: null,
          lastValidatedAt: new Date().toISOString(),
          nextValidationAt: null,
          features: [],
          issuedTo: this.cachedLicense?.issuedTo || null,
          statusMessage: reason,
          licenseKey: this.cachedLicense?.licenseKey || null,
        };

        await this.persist(invalidLicense);
        this.emitChange(invalidLicense);

        logger.info('LicenseService: Updated cache to reflect invalid license status', {
          reason,
          previousStatus: this.cachedLicense?.status,
        });

        throw new Error(`License is not valid: ${reason}`);
      }

      // Extract license information from response
      const now = new Date();

      // Determine license type from response (legacy field)
      const type: LicenseTier =
        data.type === 'public' ? 'public' : data.type === 'custom' ? 'custom' : 'unknown';

      // Get actual tier information from response
      const tierKey: LicenseTierKey = (data.tierKey as LicenseTierKey) || 'unknown';
      const tierName = data.tierName || 'Unknown';

      // Get grant type information from response
      const grantType = data.grantType as LicenseGrantType | undefined;
      const isBeta = data.isBeta === true || grantType === 'beta';

      // Convert API features object to array of enabled features
      const features: string[] = data.features
        ? Object.entries(data.features)
            .filter(([, enabled]) => Boolean(enabled))
            .map(([key]) => key)
            .sort()
        : [];

      // Determine next validation time
      const validationIntervalMinutes =
        (data.limits?.validation_interval_minutes as number) || DEFAULT_REVALIDATE_MINUTES;
      const nextValidationAt = new Date(
        now.getTime() + validationIntervalMinutes * 60 * 1000
      ).toISOString();

      // For fetched licenses, we don't have the license key, so we preserve existing or use null
      const existingLicenseKey = this.cachedLicense?.licenseKey || null;

      const storedLicense: StoredLicense = {
        status: 'active',
        type,
        tierKey,
        tierName,
        grantType,
        isBeta,
        validationMode: 'online',
        expiresAt: data.expiresAt || null,
        lastValidatedAt: now.toISOString(),
        nextValidationAt,
        features,
        issuedTo: data.userId || null,
        statusMessage: null,
        licenseKey: existingLicenseKey,
      };

      await this.persist(storedLicense);
      this.emitChange(storedLicense);

      logger.info('LicenseService: Successfully fetched and cached license from backend', {
        licenseId: data.licenseId,
        type: data.type,
        tierKey,
        tierName,
        productType: data.productType,
        expiresAt: data.expiresAt,
        features: features.length,
      });

      return this.stripInternalFields(storedLicense);
    } catch (error) {
      // Handle network errors
      if (error instanceof TypeError) {
        logger.error('LicenseService: Network error during license fetch', {
          error: error.message,
        });
        throw new Error('Network error: Unable to reach license server');
      }

      // Handle timeout errors
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        logger.error('LicenseService: Timeout during license fetch');
        throw new Error('License fetch timed out');
      }

      // Re-throw other errors
      throw error;
    }
  }

  onChanged(listener: (payload: LicensePayload) => void): () => void {
    this.on('changed', listener);
    return () => {
      this.off('changed', listener);
    };
  }

  private buildDefault(): StoredLicense {
    return {
      status: 'unlicensed',
      type: 'unknown',
      tierKey: 'unknown',
      tierName: 'Unknown',
      validationMode: 'online',
      expiresAt: null,
      lastValidatedAt: null,
      nextValidationAt: null,
      features: [],
      issuedTo: null,
      statusMessage: null,
      licenseKey: null,
    };
  }

  private stripInternalFields(record: StoredLicense): LicensePayload {
    const {
      status,
      type,
      tierKey,
      tierName,
      grantType,
      isBeta,
      validationMode,
      expiresAt,
      lastValidatedAt,
      nextValidationAt,
      features,
      issuedTo,
      statusMessage,
    } = record;
    return {
      status,
      type,
      tierKey,
      tierName,
      grantType,
      isBeta,
      validationMode,
      expiresAt,
      lastValidatedAt,
      nextValidationAt,
      features,
      issuedTo,
      statusMessage,
    };
  }

  private async persist(record: StoredLicense): Promise<void> {
    this.cachedLicense = record;
    try {
      await this.deps.settings.setJson(LICENSE_STORAGE_KEY, record);
    } catch (error) {
      logger.warn('LicenseService: Failed to persist license cache', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private emitChange(record: StoredLicense): void {
    const payload = this.stripInternalFields(record);
    this.emit('changed', payload);
  }

  private normalizeInput(value: string): string {
    return value.replace(/\s+/g, '').trim();
  }

  private parseLicenseKey(key: string): { prefix: 'np' | 'nd'; jwt: string } {
    const match = LICENSE_KEY_REGEX.exec(key);
    if (!match) {
      throw new Error('License key format looks invalid. Double-check and try again.');
    }
    const [, prefix, jwt] = match;
    return {
      prefix: prefix.toLowerCase() as 'np' | 'nd',
      jwt,
    };
  }

  /**
   * Get the API base URL from settings or use default
   */
  async resolveApiUrl(): Promise<string> {
    const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

    try {
      const customApiUrl = normalize(await this.deps.settings.get('server.apiUrl'));
      if (customApiUrl) {
        logger.info('LicenseService: Using custom API URL from settings', {
          apiUrl: customApiUrl,
        });
        return customApiUrl;
      }
    } catch (error) {
      logger.debug('LicenseService: Failed to get custom API URL from settings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const authServerUrl = normalize(await this.deps.settings.get('auth.serverUrl'));
      if (authServerUrl) {
        logger.info('LicenseService: Using auth server URL for license validation', {
          apiUrl: authServerUrl,
        });
        return authServerUrl;
      }
    } catch (error) {
      logger.debug('LicenseService: Failed to get auth server URL from settings', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info('LicenseService: Using default API URL', {
      apiUrl: DEFAULT_API_URL,
    });
    return DEFAULT_API_URL;
  }

  /**
   * Validates a license key online via the license microservice API
   *
   * @param licenseKey - The normalized license key to validate
   * @returns A LicensePayload with online validation mode
   * @throws Error if online validation fails for any reason
   */
  private async validateOnline(licenseKey: string): Promise<LicensePayload> {
    const apiUrl = await this.resolveApiUrl();
    const validationUrl = `${apiUrl}/api/license/validate`;

    logger.info('LicenseService: Calling online validation endpoint', {
      url: validationUrl,
      licenseKeyPrefix: licenseKey.substring(0, 10) + '...',
    });

    try {
      const response = await pinnedFetch(validationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          licenseKey,
        }),
        signal: AbortSignal.timeout(ONLINE_VALIDATION_TIMEOUT_MS),
      });

      // Check HTTP status
      if (!response.ok) {
        if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else if (response.status >= 500) {
          throw new Error(`License server error (${response.status}). Please try again later.`);
        } else if (response.status === 403) {
          throw new Error('License validation rejected: Concurrent usage limit exceeded.');
        } else {
          throw new Error(`License validation failed with status ${response.status}`);
        }
      }

      const data: OnlineValidationResponse = await response.json();

      // Check if license is valid
      if (!data.valid) {
        const reason = data.reason || 'Unknown reason';
        logger.warn('LicenseService: License validation failed', { reason });

        // CRITICAL: Update cached license to reflect the invalid/revoked state
        // This ensures the UI shows the correct status instead of stale "active" cache
        const invalidLicense: StoredLicense = {
          status: 'invalid',
          type: 'unknown',
          tierKey: 'unknown',
          tierName: 'Unknown',
          validationMode: 'online',
          expiresAt: null,
          lastValidatedAt: new Date().toISOString(),
          nextValidationAt: null,
          features: [],
          issuedTo: this.cachedLicense?.issuedTo || null,
          statusMessage: reason,
          licenseKey: licenseKey,
        };

        await this.persist(invalidLicense);
        this.emitChange(invalidLicense);

        logger.info('LicenseService: Updated cache to reflect invalid license status', {
          reason,
          previousStatus: this.cachedLicense?.status,
        });

        throw new Error(`License validation failed: ${reason}`);
      }

      // Extract license information from response
      const now = new Date();
      const parsed = this.parseLicenseKey(licenseKey);
      const type: LicenseTier = parsed.prefix === 'np' ? 'custom' : 'public';

      // Get actual tier information from response
      const tierKey: LicenseTierKey = (data.tierKey as LicenseTierKey) || 'unknown';
      const tierName = data.tierName || 'Unknown';

      // Get grant type information from response
      const grantType = data.grantType as LicenseGrantType | undefined;
      const isBeta = data.isBeta === true || grantType === 'beta';

      // Convert API features object to array of enabled features
      const features: string[] = data.features
        ? Object.entries(data.features)
            .filter(([, enabled]) => Boolean(enabled))
            .map(([key]) => key)
            .sort()
        : [];

      // Determine next validation time
      const validationIntervalMinutes =
        (data.limits?.validation_interval_minutes as number) || DEFAULT_REVALIDATE_MINUTES;
      const nextValidationAt = new Date(
        now.getTime() + validationIntervalMinutes * 60 * 1000
      ).toISOString();

      const storedLicense: StoredLicense = {
        status: 'active',
        type,
        tierKey,
        tierName,
        grantType,
        isBeta,
        validationMode: 'online',
        expiresAt: data.expiresAt || null,
        lastValidatedAt: now.toISOString(),
        nextValidationAt,
        features,
        issuedTo: data.userId || null,
        statusMessage: null,
        licenseKey,
      };

      await this.persist(storedLicense);
      this.emitChange(storedLicense);

      logger.info('LicenseService: Online validation successful and cached', {
        licenseId: data.licenseId,
        type: data.type,
        grantType,
        isBeta,
        productType: data.productType,
        expiresAt: data.expiresAt,
        features: features.length,
      });

      return this.stripInternalFields(storedLicense);
    } catch (error) {
      // Handle network errors
      if (error instanceof TypeError) {
        logger.error('LicenseService: Network error during online validation', {
          error: error.message,
        });
        throw new Error('Network error: Unable to reach license server');
      }

      // Handle timeout errors
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        logger.error('LicenseService: Timeout during online validation');
        throw new Error('License validation timed out');
      }

      // Re-throw validation errors
      throw error;
    }
  }
}
