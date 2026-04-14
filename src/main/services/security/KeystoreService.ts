/**
 * KeystoreService - Secure token storage using OS keychain
 *
 * Wraps credential storage to provide secure storage for authentication tokens.
 * Uses Electron's safeStorage API (via the keytar abstraction layer):
 * - macOS: Keychain
 * - Windows: Credential Manager (DPAPI)
 * - Linux: libsecret (GNOME Keyring / KWallet)
 *
 * Account names are scoped per server+user to support multi-profile:
 * - Format: auth-<scopeHash>-access, auth-<scopeHash>-refresh
 * - scopeHash = sha256(serverUrl + userId).substring(0, 8)
 *
 * IMPORTANT: This service has NO fallback. If the keystore is unavailable,
 * token operations will throw errors. Users must have a working keystore.
 */

import crypto from 'node:crypto';

import { logger } from '../../logger';

import { getKeytar } from './keytar';

/**
 * Keytar service configuration
 */
const KEYSTORE_CONFIG = {
  /** Service name appearing in OS credential managers */
  SERVICE_NAME: 'com.notely.desktop',

  /** Account name suffixes for different token types */
  ACCOUNT_SUFFIXES: {
    ACCESS_TOKEN: '-access',
    REFRESH_TOKEN: '-refresh',
  },

  /** Prefix for scoped accounts */
  ACCOUNT_PREFIX: 'auth-',
} as const;

/**
 * Error thrown when keystore operations fail
 */
export class KeystoreError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/**
 * Token data structure for batch operations
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
}

/**
 * Scope information for multi-profile token isolation
 */
export interface KeystoreScope {
  serverUrl: string;
  userId: string;
}

/**
 * Interface for KeystoreService to enable testing and dependency injection
 */
export interface IKeystoreService {
  /**
   * Set the current scope for token operations.
   * Must be called before any token operations for proper multi-profile isolation.
   * @param scope - Server URL and user ID to scope tokens to
   */
  setScope(scope: KeystoreScope): void;

  /**
   * Get the current scope, if set
   */
  getScope(): KeystoreScope | null;

  /**
   * Check if a scope has been set
   */
  hasScope(): boolean;

  /** Get the stored access token */
  getAccessToken(): Promise<string | null>;

  /** Store the access token */
  setAccessToken(token: string): Promise<void>;

  /** Get the stored refresh token */
  getRefreshToken(): Promise<string | null>;

  /** Store the refresh token */
  setRefreshToken(token: string): Promise<void>;

  /** Store both tokens at once */
  setTokens(tokens: AuthTokens): Promise<void>;

  /** Delete the access token */
  deleteAccessToken(): Promise<void>;

  /** Delete the refresh token */
  deleteRefreshToken(): Promise<void>;

  /** Delete all stored tokens */
  deleteAllTokens(): Promise<void>;

  /** Check if keystore is available and working */
  isAvailable(): Promise<boolean>;
}

/**
 * KeystoreService provides secure token storage using the OS keychain.
 *
 * All operations are strict - they will throw KeystoreError if the keystore
 * is unavailable or operations fail. There is NO fallback to plaintext storage.
 *
 * Token accounts are scoped per server+user for multi-profile isolation.
 * Call setScope() before token operations to ensure proper isolation.
 */
export class KeystoreService implements IKeystoreService {
  private readonly serviceName: string;
  private availabilityChecked = false;
  private isKeystoreAvailable = false;
  private currentScope: KeystoreScope | null = null;
  private scopeHash: string | null = null;

  constructor(serviceName?: string) {
    this.serviceName = serviceName ?? KEYSTORE_CONFIG.SERVICE_NAME;
  }

  /**
   * Set the current scope for token operations.
   * Computes a hash of serverUrl + userId for account naming.
   */
  setScope(scope: KeystoreScope): void {
    this.currentScope = scope;
    this.scopeHash = this.computeScopeHash(scope.serverUrl, scope.userId);
    logger.debug('KeystoreService: Scope set', {
      serverUrl: scope.serverUrl,
      userId: scope.userId.substring(0, 8) + '...',
      scopeHash: this.scopeHash,
    });
  }

  /**
   * Get the current scope, if set
   */
  getScope(): KeystoreScope | null {
    return this.currentScope;
  }

  /**
   * Check if a scope has been set
   */
  hasScope(): boolean {
    return this.currentScope !== null && this.scopeHash !== null;
  }

  /**
   * Compute a short hash from serverUrl + userId for account scoping
   */
  private computeScopeHash(serverUrl: string, userId: string): string {
    const input = `${serverUrl}:${userId}`;
    return crypto.createHash('sha256').update(input).digest('hex').substring(0, 8);
  }

  /**
   * Get the account name for access token (scoped or unscoped)
   */
  private getAccessTokenAccount(): string {
    if (this.scopeHash) {
      return `${KEYSTORE_CONFIG.ACCOUNT_PREFIX}${this.scopeHash}${KEYSTORE_CONFIG.ACCOUNT_SUFFIXES.ACCESS_TOKEN}`;
    }
    // Fallback to unscoped (for backward compatibility during migration)
    return `${KEYSTORE_CONFIG.ACCOUNT_PREFIX}default${KEYSTORE_CONFIG.ACCOUNT_SUFFIXES.ACCESS_TOKEN}`;
  }

  /**
   * Get the account name for refresh token (scoped or unscoped)
   */
  private getRefreshTokenAccount(): string {
    if (this.scopeHash) {
      return `${KEYSTORE_CONFIG.ACCOUNT_PREFIX}${this.scopeHash}${KEYSTORE_CONFIG.ACCOUNT_SUFFIXES.REFRESH_TOKEN}`;
    }
    // Fallback to unscoped (for backward compatibility during migration)
    return `${KEYSTORE_CONFIG.ACCOUNT_PREFIX}default${KEYSTORE_CONFIG.ACCOUNT_SUFFIXES.REFRESH_TOKEN}`;
  }

  /**
   * Check if keystore is available and working.
   * Performs a test write/read/delete cycle on first call.
   */
  async isAvailable(): Promise<boolean> {
    if (this.availabilityChecked) {
      return this.isKeystoreAvailable;
    }

    try {
      const keytar = await getKeytar();
      const testAccount = '__keystore_test__';
      const testValue = `test-${Date.now()}`;

      // Try to write, read, and delete a test value
      await keytar.setPassword(this.serviceName, testAccount, testValue);
      const retrieved = await keytar.getPassword(this.serviceName, testAccount);
      await keytar.deletePassword(this.serviceName, testAccount);

      this.isKeystoreAvailable = retrieved === testValue;
      this.availabilityChecked = true;

      if (this.isKeystoreAvailable) {
        logger.info('KeystoreService: Keystore is available and working', {
          service: this.serviceName,
          platform: process.platform,
        });
      } else {
        logger.error('KeystoreService: Keystore test failed - read value mismatch');
      }

      return this.isKeystoreAvailable;
    } catch (error) {
      this.isKeystoreAvailable = false;
      this.availabilityChecked = true;

      logger.error('KeystoreService: Keystore is NOT available', {
        service: this.serviceName,
        platform: process.platform,
        error: error instanceof Error ? error.message : String(error),
        hint: this.getPlatformHint(),
      });

      return false;
    }
  }

  /**
   * Ensure keystore is available before operations.
   * Throws KeystoreError if not available.
   */
  private async ensureAvailable(operation: string): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      throw new KeystoreError(`Keystore is not available. ${this.getPlatformHint()}`, operation);
    }
  }

  /**
   * Get platform-specific help message for keystore issues
   */
  private getPlatformHint(): string {
    switch (process.platform) {
      case 'linux':
        return 'Please ensure libsecret is installed (e.g., sudo apt install libsecret-1-0 gnome-keyring)';
      case 'darwin':
        return 'Please ensure Keychain Access is available and not locked';
      case 'win32':
        return 'Please ensure Windows Credential Manager is accessible';
      default:
        return 'Secure credential storage is not available on this platform';
    }
  }

  /**
   * Get the stored access token
   */
  async getAccessToken(): Promise<string | null> {
    await this.ensureAvailable('getAccessToken');

    try {
      const keytar = await getKeytar();
      const accountName = this.getAccessTokenAccount();
      const token = await keytar.getPassword(this.serviceName, accountName);

      logger.debug('KeystoreService: Retrieved access token', {
        hasToken: !!token,
        account: accountName,
      });

      return token;
    } catch (error) {
      throw new KeystoreError(
        'Failed to retrieve access token from keystore',
        'getAccessToken',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Store the access token
   */
  async setAccessToken(token: string): Promise<void> {
    await this.ensureAvailable('setAccessToken');

    if (!token || typeof token !== 'string') {
      throw new KeystoreError('Invalid access token provided', 'setAccessToken');
    }

    try {
      const keytar = await getKeytar();
      const accountName = this.getAccessTokenAccount();
      await keytar.setPassword(this.serviceName, accountName, token);

      logger.info('KeystoreService: Stored access token', {
        tokenLength: token.length,
        account: accountName,
      });
    } catch (error) {
      throw new KeystoreError(
        'Failed to store access token in keystore',
        'setAccessToken',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the stored refresh token
   */
  async getRefreshToken(): Promise<string | null> {
    await this.ensureAvailable('getRefreshToken');

    try {
      const keytar = await getKeytar();
      const accountName = this.getRefreshTokenAccount();
      const token = await keytar.getPassword(this.serviceName, accountName);

      logger.debug('KeystoreService: Retrieved refresh token', {
        hasToken: !!token,
        account: accountName,
      });

      return token;
    } catch (error) {
      throw new KeystoreError(
        'Failed to retrieve refresh token from keystore',
        'getRefreshToken',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Store the refresh token
   */
  async setRefreshToken(token: string): Promise<void> {
    await this.ensureAvailable('setRefreshToken');

    if (!token || typeof token !== 'string') {
      throw new KeystoreError('Invalid refresh token provided', 'setRefreshToken');
    }

    try {
      const keytar = await getKeytar();
      const accountName = this.getRefreshTokenAccount();
      await keytar.setPassword(this.serviceName, accountName, token);

      logger.info('KeystoreService: Stored refresh token', {
        tokenLength: token.length,
        account: accountName,
      });
    } catch (error) {
      throw new KeystoreError(
        'Failed to store refresh token in keystore',
        'setRefreshToken',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Store both tokens at once
   */
  async setTokens(tokens: AuthTokens): Promise<void> {
    await this.ensureAvailable('setTokens');

    try {
      await this.setAccessToken(tokens.accessToken);

      if (tokens.refreshToken) {
        await this.setRefreshToken(tokens.refreshToken);
      }

      logger.info('KeystoreService: Stored auth tokens', {
        hasAccessToken: true,
        hasRefreshToken: !!tokens.refreshToken,
      });
    } catch (error) {
      if (error instanceof KeystoreError) {
        throw error;
      }
      throw new KeystoreError(
        'Failed to store tokens in keystore',
        'setTokens',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete the access token
   */
  async deleteAccessToken(): Promise<void> {
    await this.ensureAvailable('deleteAccessToken');

    try {
      const keytar = await getKeytar();
      const accountName = this.getAccessTokenAccount();
      const deleted = await keytar.deletePassword(this.serviceName, accountName);

      logger.info('KeystoreService: Deleted access token', { deleted, account: accountName });
    } catch (error) {
      throw new KeystoreError(
        'Failed to delete access token from keystore',
        'deleteAccessToken',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete the refresh token
   */
  async deleteRefreshToken(): Promise<void> {
    await this.ensureAvailable('deleteRefreshToken');

    try {
      const keytar = await getKeytar();
      const accountName = this.getRefreshTokenAccount();
      const deleted = await keytar.deletePassword(this.serviceName, accountName);

      logger.info('KeystoreService: Deleted refresh token', { deleted, account: accountName });
    } catch (error) {
      throw new KeystoreError(
        'Failed to delete refresh token from keystore',
        'deleteRefreshToken',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete all stored tokens
   */
  async deleteAllTokens(): Promise<void> {
    await this.ensureAvailable('deleteAllTokens');

    try {
      const keytar = await getKeytar();
      const accessAccount = this.getAccessTokenAccount();
      const refreshAccount = this.getRefreshTokenAccount();

      // Delete both tokens, ignoring individual failures
      const accessDeleted = await keytar
        .deletePassword(this.serviceName, accessAccount)
        .catch(() => false);

      const refreshDeleted = await keytar
        .deletePassword(this.serviceName, refreshAccount)
        .catch(() => false);

      logger.info('KeystoreService: Deleted all tokens', {
        accessDeleted,
        refreshDeleted,
        accessAccount,
        refreshAccount,
      });
    } catch (error) {
      throw new KeystoreError(
        'Failed to delete tokens from keystore',
        'deleteAllTokens',
        error instanceof Error ? error : undefined
      );
    }
  }
}

/**
 * Singleton instance for application-wide use
 */
let keystoreServiceInstance: KeystoreService | null = null;

/**
 * Get the singleton KeystoreService instance
 */
export function getKeystoreService(): KeystoreService {
  if (!keystoreServiceInstance) {
    keystoreServiceInstance = new KeystoreService();
  }
  return keystoreServiceInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetKeystoreService(): void {
  keystoreServiceInstance = null;
}
