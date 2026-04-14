/**
 * EncryptionKeyManager - Manages SQLCipher database encryption keys
 *
 * Stores the master encryption key in the OS keystore for security.
 * Supports one-time migration from legacy file-based keys.
 * Provides recovery key export/import as the single recovery path.
 *
 * Key format: 32 bytes (256 bits) stored as 64-character hex string
 * SQLCipher key format: "x'<64 hex chars>'" for raw key pragma
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../../logger';
import { type IKeystoreService, getKeystoreService, KeystoreError } from '../../services/security';
import { getKeytar } from '../../services/security/keytar';
import type { IDatabaseManager } from '../interfaces/IDatabaseManager';

/**
 * Resolves an app base directory from the database path.
 * DB path: <baseDir>/data/notes.sqlite -> baseDir
 */
function resolveBaseDirFromDbPath(dbPath: string): string {
  const dataDir = path.dirname(dbPath); // <baseDir>/data
  return path.resolve(dataDir, '..');
}

/**
 * Keystore account name for the DB encryption key
 * Stored separately from auth tokens for isolation
 */
const DB_KEY_ACCOUNT = 'database-encryption-key';

/**
 * Interface for encryption key management
 */
export interface IEncryptionKeyManager {
  /**
   * Get or create the encryption key for SQLCipher.
   * Returns the key as a hex string suitable for SQLCipher PRAGMA.
   * On first call, migrates legacy file-based keys if present.
   */
  getOrCreateKey(): Promise<string>;

  /**
   * Export the recovery key as a 64-character hex string.
   * Users should store this securely for database recovery.
   */
  exportRecoveryKey(): Promise<string>;

  /**
   * Import a recovery key to restore database access.
   * @param hexKey - 64-character hex string (32 bytes)
   */
  importRecoveryKey(hexKey: string): Promise<void>;

  /**
   * Check if an encryption key exists in the keystore
   */
  hasKey(): Promise<boolean>;

  /**
   * Delete the encryption key (use with caution - may make DB unreadable)
   */
  deleteKey(): Promise<void>;

  /**
   * Get the SQLCipher-formatted key pragma value
   * Format: x'<64 hex chars>' for raw key
   */
  getSqlCipherKey(): Promise<string>;
}

/**
 * Error thrown when encryption key operations fail
 */
export class EncryptionKeyError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

/**
 * EncryptionKeyManager implementation using OS keystore
 */
export class EncryptionKeyManager implements IEncryptionKeyManager {
  private readonly keystoreService: IKeystoreService;
  private readonly serviceName = 'com.notely.desktop';
  private legacyMigrationAttempted = false;

  constructor(
    private readonly baseDir: string,
    keystoreService?: IKeystoreService
  ) {
    this.keystoreService = keystoreService ?? getKeystoreService();
  }

  /**
   * Get or create the encryption key.
   * Migrates from legacy file-based storage on first access.
   */
  async getOrCreateKey(): Promise<string> {
    // Try to get existing key from keystore
    let key = await this.getKeyFromKeystore();

    if (key) {
      return key;
    }

    // Attempt one-time migration from legacy file-based key
    if (!this.legacyMigrationAttempted) {
      this.legacyMigrationAttempted = true;
      key = await this.migrateLegacyKey();
      if (key) {
        return key;
      }
    }

    // No existing key - generate a new one
    key = await this.generateAndStoreKey();
    return key;
  }

  /**
   * Export the recovery key
   */
  async exportRecoveryKey(): Promise<string> {
    const key = await this.getOrCreateKey();
    return key; // Already in hex format
  }

  /**
   * Import a recovery key
   */
  async importRecoveryKey(hexKey: string): Promise<void> {
    const trimmed = hexKey.trim().toLowerCase();

    // Validate hex format
    if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
      throw new EncryptionKeyError(
        'Invalid recovery key format. Expected 64 hexadecimal characters (32 bytes).',
        'importRecoveryKey'
      );
    }

    try {
      await this.storeKeyInKeystore(trimmed);
      logger.info('EncryptionKeyManager: Recovery key imported successfully');
    } catch (error) {
      throw new EncryptionKeyError(
        'Failed to import recovery key to keystore',
        'importRecoveryKey',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if a key exists in the keystore
   */
  async hasKey(): Promise<boolean> {
    const key = await this.getKeyFromKeystore();
    return key !== null;
  }

  /**
   * Delete the encryption key
   */
  async deleteKey(): Promise<void> {
    try {
      // Use keytar directly since KeystoreService doesn't expose generic delete
      const keytar = await getKeytar();
      await keytar.deletePassword(this.serviceName, DB_KEY_ACCOUNT);
      logger.info('EncryptionKeyManager: Encryption key deleted');
    } catch (error) {
      throw new EncryptionKeyError(
        'Failed to delete encryption key',
        'deleteKey',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get the SQLCipher-formatted key for PRAGMA
   * Format: x'<hex>' for raw key bytes
   */
  async getSqlCipherKey(): Promise<string> {
    const hexKey = await this.getOrCreateKey();
    return `'x''${hexKey}'''`;
  }

  /**
   * Get key from OS keystore
   */
  private async getKeyFromKeystore(): Promise<string | null> {
    try {
      const keytar = await getKeytar();
      const key = await keytar.getPassword(this.serviceName, DB_KEY_ACCOUNT);

      if (key && /^[0-9a-f]{64}$/i.test(key)) {
        logger.debug('EncryptionKeyManager: Retrieved key from keystore');
        return key.toLowerCase();
      }

      return null;
    } catch (error) {
      logger.warn('EncryptionKeyManager: Failed to retrieve key from keystore', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Store key in OS keystore
   */
  private async storeKeyInKeystore(hexKey: string): Promise<void> {
    try {
      const keytar = await getKeytar();
      await keytar.setPassword(this.serviceName, DB_KEY_ACCOUNT, hexKey.toLowerCase());
      logger.info('EncryptionKeyManager: Stored encryption key in keystore');
    } catch (error) {
      logger.error('EncryptionKeyManager: Failed to store encryption key in keystore', {
        error: error instanceof Error ? error.message : error,
      });
      throw new EncryptionKeyError(
        'Failed to store encryption key in keystore. ' + this.getPlatformHint(),
        'storeKeyInKeystore',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Generate a new random key and store it
   */
  private async generateAndStoreKey(): Promise<string> {
    const keyBytes = crypto.randomBytes(32);
    const hexKey = keyBytes.toString('hex');

    await this.storeKeyInKeystore(hexKey);
    logger.info('EncryptionKeyManager: Generated and stored new encryption key');

    return hexKey;
  }

  /**
   * Migrate from legacy file-based key storage
   * Legacy location: <baseDir>/keys/master.key (32 bytes binary)
   */
  private async migrateLegacyKey(): Promise<string | null> {
    const legacyKeyPath = path.join(this.baseDir, 'keys', 'master.key');

    try {
      if (!fs.existsSync(legacyKeyPath)) {
        logger.debug('EncryptionKeyManager: No legacy key file found at %s', legacyKeyPath);
        return null;
      }

      const keyBytes = fs.readFileSync(legacyKeyPath);

      if (keyBytes.length !== 32) {
        logger.warn(
          'EncryptionKeyManager: Legacy key has invalid length (%d bytes), ignoring',
          keyBytes.length
        );
        return null;
      }

      const hexKey = keyBytes.toString('hex');

      // Store in keystore
      await this.storeKeyInKeystore(hexKey);

      // Delete legacy file after successful migration
      try {
        fs.unlinkSync(legacyKeyPath);
        logger.info(
          'EncryptionKeyManager: Migrated legacy key and deleted file at %s',
          legacyKeyPath
        );

        // Try to remove empty keys directory
        const keysDir = path.dirname(legacyKeyPath);
        const remaining = fs.readdirSync(keysDir);
        if (remaining.length === 0) {
          fs.rmdirSync(keysDir);
          logger.debug('EncryptionKeyManager: Removed empty keys directory');
        }
      } catch (deleteError) {
        // Non-fatal - key was migrated successfully
        logger.warn('EncryptionKeyManager: Failed to delete legacy key file', {
          error: deleteError instanceof Error ? deleteError.message : deleteError,
        });
      }

      return hexKey;
    } catch (error) {
      logger.warn('EncryptionKeyManager: Failed to migrate legacy key', {
        error: error instanceof Error ? error.message : error,
        path: legacyKeyPath,
      });
      return null;
    }
  }

  /**
   * Get platform-specific help for keystore issues
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
}

/**
 * Singleton instance for application-wide use
 */
let encryptionKeyManagerInstance: EncryptionKeyManager | null = null;

/**
 * Get or create the EncryptionKeyManager singleton
 * @param baseDirOrDb - Required on first call: either baseDir string or IDatabaseManager
 */
export function getEncryptionKeyManager(
  baseDirOrDb?: string | IDatabaseManager
): EncryptionKeyManager {
  if (!encryptionKeyManagerInstance) {
    if (!baseDirOrDb) {
      throw new EncryptionKeyError(
        'baseDir or databaseManager is required to initialize EncryptionKeyManager',
        'getEncryptionKeyManager'
      );
    }

    let baseDir: string;
    if (typeof baseDirOrDb === 'string') {
      baseDir = baseDirOrDb;
    } else {
      // IDatabaseManager - derive baseDir from database path
      const dbPath = baseDirOrDb.getPath();
      baseDir = resolveBaseDirFromDbPath(dbPath);
    }

    encryptionKeyManagerInstance = new EncryptionKeyManager(baseDir);
  }
  return encryptionKeyManagerInstance;
}

/**
 * Create an EncryptionKeyManager from a DatabaseManager
 * (non-singleton, for cases where you need a fresh instance)
 */
export function createEncryptionKeyManager(
  databaseManager: IDatabaseManager
): EncryptionKeyManager {
  const dbPath = databaseManager.getPath();
  const baseDir = resolveBaseDirFromDbPath(dbPath);
  return new EncryptionKeyManager(baseDir);
}

/**
 * Reset the singleton (for testing)
 */
export function resetEncryptionKeyManager(): void {
  encryptionKeyManagerInstance = null;
}
