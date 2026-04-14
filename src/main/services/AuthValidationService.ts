import crypto from 'node:crypto';
import os from 'node:os';

import { logger } from '../logger';
import { type IStorageService } from '../storage/index';

import { type IKeystoreService, getKeystoreService } from './security';

// Auth service interface for token refresh
export interface IAuthService {
  refreshTokens(force?: boolean): Promise<{ success: boolean; error?: string }>;
}

/**
 * Result of authentication validation
 */
export interface AuthValidationResult {
  /** Whether the stored authentication is valid */
  isValid: boolean;
  /** Reason for the validation result */
  reason: 'valid' | 'no_stored_auth' | 'server_rejected' | 'unverified_network_error' | 'refreshed';
  /** Action taken during validation */
  action?: 'none' | 'cleared_invalid_auth' | 'assumed_valid' | 'refreshed_tokens';
  /** Additional details about the validation */
  details?: string;
  /** Error message if validation failed due to network/technical issues */
  error?: string;
}

/**
 * Result of server session validation
 */
interface SessionValidationResult {
  /** Whether the session is valid according to the server */
  isValid: boolean;
  /** Reason for the validation result */
  reason: string;
  /** Server error response if validation failed */
  serverResponse: string | null;
  /** HTTP status code from the server */
  httpStatus?: number;
}

/**
 * Service responsible for validating stored authentication state at startup.
 * Ensures the UI accurately reflects the current authentication status by
 * checking stored tokens against the server and clearing invalid state.
 * Attempts to refresh expired tokens using refresh token before clearing state.
 */
export class AuthValidationService {
  private readonly keystoreService: IKeystoreService;

  constructor(
    _unused: null, // Preserved for backwards compatibility with existing callers
    private storage: IStorageService,
    private authService?: IAuthService, // Optional: used for token refresh
    keystoreService?: IKeystoreService
  ) {
    this.keystoreService = keystoreService ?? getKeystoreService();
  }

  /**
   * Set keystore scope from settings for multi-profile isolation
   */
  private async ensureKeystoreScope(): Promise<void> {
    const serverUrl = await this.storage.settings.get('auth.serverUrl');
    const userId = await this.storage.settings.get('auth.userId');
    if (serverUrl && userId) {
      this.keystoreService.setScope({ serverUrl, userId });
    }
  }

  /**
   * One-time cleanup of legacy tokens from SQLite settings.
   * Tokens are now stored in the OS keystore, so any remaining in settings
   * are leftover from the previous storage method and should be removed.
   */
  private async cleanupLegacyTokens(): Promise<void> {
    try {
      const legacyAccessToken = await this.storage.settings.get('auth.accessToken');
      const legacyRefreshToken = await this.storage.settings.get('auth.refreshToken');

      if (legacyAccessToken || legacyRefreshToken) {
        logger.info('AuthValidationService: Cleaning up legacy tokens from settings', {
          hasLegacyAccessToken: !!legacyAccessToken,
          hasLegacyRefreshToken: !!legacyRefreshToken,
        });

        // Clear the legacy tokens from settings
        await this.storage.settings.setBatch({
          'auth.accessToken': '',
          'auth.refreshToken': '',
        });

        logger.info('AuthValidationService: Legacy tokens removed from settings');
      }
    } catch (error) {
      // Non-fatal - log and continue
      logger.warn('AuthValidationService: Failed to cleanup legacy tokens', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Validate stored authentication state at startup.
   * Called during app initialization to ensure UI state is accurate.
   *
   * @returns Promise<AuthValidationResult> The validation result with details
   */
  async validateStoredAuthState(): Promise<AuthValidationResult> {
    logger.info('AuthValidationService: Validating stored authentication state...');

    // Set keystore scope for multi-profile isolation
    await this.ensureKeystoreScope();

    // Clean up any legacy tokens from SQLite settings (one-time migration)
    await this.cleanupLegacyTokens();

    // Get access token from OS keystore
    let accessToken: string | null = null;
    try {
      accessToken = await this.keystoreService.getAccessToken();
    } catch (error) {
      logger.warn('AuthValidationService: Failed to retrieve access token from keystore', {
        error: error instanceof Error ? error.message : error,
      });
    }
    const serverUrl = await this.storage.settings.get('auth.serverUrl');

    logger.debug('AuthValidationService: Retrieved stored auth config', {
      hasAccessToken: !!accessToken,
      hasServerUrl: !!serverUrl,
      accessTokenLength: accessToken?.length || 0,
      serverUrl: serverUrl || 'none',
    });

    // No stored auth - clean state
    if (!accessToken || !serverUrl) {
      logger.info('AuthValidationService: No stored authentication found - clean state', {
        reason: !accessToken ? 'no_access_token' : 'no_server_url',
      });
      return {
        isValid: false,
        reason: 'no_stored_auth',
        action: 'none', // Already clean
      };
    }

    try {
      const config = { accessToken, serverUrl };
      const validation = await this.validateSessionWithServer(config);

      if (!validation.isValid) {
        logger.warn('AuthValidationService: Stored authentication invalid', {
          reason: validation.reason,
          serverResponse: validation.serverResponse,
          httpStatus: validation.httpStatus,
        });

        // Check if we have a refresh token and can attempt refresh
        let refreshToken: string | null = null;
        try {
          refreshToken = await this.keystoreService.getRefreshToken();
        } catch {
          // Ignore keystore errors here - we'll just skip refresh
        }
        if (refreshToken && this.authService) {
          logger.info('AuthValidationService: Attempting to refresh expired token');

          try {
            const refreshResult = await this.authService.refreshTokens(true);

            if (refreshResult.success) {
              logger.info('AuthValidationService: Token refresh succeeded, accepting new token');
              return {
                isValid: true,
                reason: 'refreshed',
                action: 'refreshed_tokens',
              };
            } else {
              logger.warn('AuthValidationService: Token refresh failed', {
                error: refreshResult.error,
              });
            }
          } catch (refreshError) {
            logger.warn('AuthValidationService: Token refresh threw error', {
              error: refreshError instanceof Error ? refreshError.message : refreshError,
            });
          }
        }

        // Refresh failed or not available - clear invalid auth state
        logger.warn('AuthValidationService: Clearing invalid authentication state');
        await this.clearInvalidAuthState();

        return {
          isValid: false,
          reason: 'server_rejected',
          action: 'cleared_invalid_auth',
          details: validation.serverResponse || undefined,
        };
      }

      logger.info('AuthValidationService: Stored authentication valid');
      return { isValid: true, reason: 'valid' };
    } catch (error) {
      logger.warn('AuthValidationService: Could not validate auth due to network error', {
        error: error instanceof Error ? error.message : error,
      });

      // On network errors, assume auth is valid but mark as unverified
      // This prevents breaking offline functionality
      return {
        isValid: true,
        reason: 'unverified_network_error',
        action: 'assumed_valid',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Validate session with server by calling the session validation endpoint
   *
   * @param config The sync configuration containing auth tokens and server URL
   * @returns Promise<SessionValidationResult> The server validation result
   */
  private async validateSessionWithServer(config: {
    accessToken: string;
    serverUrl: string;
  }): Promise<SessionValidationResult> {
    const deviceId = await this.getOrCreateDeviceId();

    logger.debug('AuthValidationService: Validating session with server', {
      serverUrl: config.serverUrl,
      hasToken: !!config.accessToken,
      deviceId: deviceId.substring(0, 8) + '...', // Log partial ID for privacy
    });

    const response = await fetch(`${config.serverUrl}/api/auth/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `Notely Desktop/${process.env.npm_package_version || '2.0.0'}`,
      },
      body: JSON.stringify({
        token: config.accessToken,
      }),
      // Add timeout to prevent hanging
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    const result = await response.json();

    logger.debug('AuthValidationService: Server validation response', {
      status: response.status,
      valid: result.valid,
      reason: result.message,
    });

    return {
      isValid: result.valid === true,
      reason: result.valid ? 'valid' : 'server_rejected',
      serverResponse: result.message || null,
      httpStatus: response.status,
    };
  }

  /**
   * Clear invalid authentication state while preserving server configuration.
   * This ensures the user can re-authenticate without reconfiguring server settings.
   */
  private async clearInvalidAuthState(): Promise<void> {
    logger.info('AuthValidationService: Clearing invalid authentication state');

    try {
      // Clear tokens from OS keystore
      await this.keystoreService.deleteAllTokens();

      // Clear non-sensitive auth metadata while preserving server URL
      await this.storage.settings.setBatch({
        'auth.tokenExpiresAt': '',
        'auth.userId': '',
      });

      logger.info('AuthValidationService: Invalid auth state cleared successfully');
    } catch (error) {
      logger.error('AuthValidationService: Failed to clear invalid auth state', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get or create a unique device ID for session validation.
   * Uses sync.device_id as the SINGLE SOURCE OF TRUTH for device identification.
   *
   * @returns Promise<string> The device ID
   */
  private async getOrCreateDeviceId(): Promise<string> {
    const DEVICE_ID_KEY = 'sync.device_id';

    try {
      const settings = this.storage.settings;
      let deviceId = (await settings.get(DEVICE_ID_KEY)) as string | null;

      if (!deviceId) {
        // Generate a unique device ID using UUID
        deviceId = crypto.randomUUID();
        await settings.set(DEVICE_ID_KEY, deviceId);

        logger.info('AuthValidationService: Created new device ID', {
          deviceId: deviceId.substring(0, 8) + '...', // Log partial for privacy
        });
      }

      return deviceId;
    } catch (error) {
      logger.warn('AuthValidationService: Failed to get/create device ID, using fallback', {
        error: error instanceof Error ? error.message : error,
      });

      // Fallback to a deterministic ID based on hostname and OS info
      // This ensures consistency across app restarts even if settings fail
      const fallbackData = `${os.hostname()}-${os.platform()}-${os.arch()}`;
      const fallbackId = crypto
        .createHash('sha256')
        .update(fallbackData)
        .digest('hex')
        .substring(0, 32);

      logger.debug('AuthValidationService: Using fallback device ID', {
        fallbackId: fallbackId.substring(0, 8) + '...',
      });

      return fallbackId;
    }
  }

  /**
   * Check if authentication validation is needed.
   * Can be used to skip validation in certain scenarios (e.g., offline mode).
   *
   * @returns Promise<boolean> Whether validation should be performed
   */
  async shouldValidateAuth(): Promise<boolean> {
    try {
      // Set keystore scope for multi-profile isolation
      await this.ensureKeystoreScope();

      // Get access token from OS keystore
      let accessToken: string | null = null;
      try {
        accessToken = await this.keystoreService.getAccessToken();
      } catch {
        // Ignore keystore errors - treat as no token
      }
      const serverUrl = await this.storage.settings.get('auth.serverUrl');

      logger.debug('AuthValidationService: Checking stored auth config for validation decision', {
        hasAccessToken: !!accessToken,
        hasServerUrl: !!serverUrl,
        accessTokenLength: accessToken?.length || 0,
        serverUrl: serverUrl || 'none',
      });

      // Skip validation if no auth is stored
      if (!accessToken || !serverUrl) {
        logger.info('AuthValidationService: Skipping validation - no stored authentication found', {
          reason: !accessToken ? 'no_access_token' : 'no_server_url',
          hasAccessToken: !!accessToken,
          hasServerUrl: !!serverUrl,
        });
        return false;
      }

      // Skip validation if explicitly disabled (future feature)
      const skipValidationStr = (await this.storage.settings.get(
        'auth.skip_startup_validation'
      )) as string | null;
      if (skipValidationStr === 'true') {
        logger.info('AuthValidationService: Startup validation disabled by user setting');
        return false;
      }

      logger.info('AuthValidationService: Should validate auth - stored authentication found');
      return true;
    } catch (error) {
      logger.warn('AuthValidationService: Error checking if validation needed', {
        error: error instanceof Error ? error.message : error,
      });
      return true; // Default to validating on error
    }
  }
}
