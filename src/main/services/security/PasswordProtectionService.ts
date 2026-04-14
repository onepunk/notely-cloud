/**
 * PasswordProtectionService - Optional password protection for database encryption
 *
 * When password protection is enabled:
 * - The database encryption key is encrypted with a password-derived key (PBKDF2-SHA512 + AES-256-GCM)
 * - The encrypted key blob is stored in a config file (not in SQLite - needed before DB opens)
 * - The OS keystore copy is deleted when password mode is active
 * - A "remember password" feature temporarily caches the decrypted key in the OS keystore
 *
 * Key derivation: PBKDF2 with SHA-512, 600,000 iterations, 32-byte output
 * Encryption: AES-256-GCM with random 12-byte IV and 16-byte auth tag
 *
 * Config storage: <baseDir>/config/password-protection.json
 * This file is read BEFORE the SQLite database opens to determine if password is needed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../../logger';
import {
  getEncryptionKeyManager,
  type IEncryptionKeyManager,
  EncryptionKeyError,
} from '../../storage/core/EncryptionKeyManager';

import { getKeytar } from './keytar';

/**
 * Config file path for password protection settings
 * Stored outside SQLite so it can be read before DB opens
 */
const CONFIG_FILENAME = 'password-protection.json';

/**
 * Encrypted key blob structure stored in config file
 */
export interface EncryptedKeyBlob {
  /** PBKDF2 salt (32 bytes, hex) */
  salt: string;
  /** AES-GCM IV (12 bytes, hex) */
  iv: string;
  /** AES-GCM auth tag (16 bytes, hex) */
  authTag: string;
  /** Encrypted key (32 bytes encrypted, hex) */
  encryptedKey: string;
  /** PBKDF2 iteration count (for future-proofing) */
  iterations: number;
  /** Version for future schema changes */
  version: 1;
}

/**
 * Config file structure for password protection
 */
interface PasswordProtectionConfig {
  /** Whether password protection is enabled */
  enabled: boolean;
  /** Encrypted key blob */
  encryptedKeyBlob?: EncryptedKeyBlob;
  /** Timestamp when recovery key was shown to user (ISO string) */
  recoveryKeyShown?: string;
  /** Timestamp when password was last changed (ISO string) */
  passwordChangedAt?: string;
  /** Whether "remember password" is enabled */
  rememberEnabled?: boolean;
  /** Expiry timestamp for "remember password" (ISO string) */
  rememberUntil?: string;
}

/**
 * Password protection status
 */
export interface PasswordProtectionStatus {
  /** Whether password protection is enabled */
  enabled: boolean;
  /** Whether user needs to enter password (enabled but not unlocked) */
  locked: boolean;
  /** Whether "remember password" is active */
  rememberActive: boolean;
  /** When "remember password" expires (null if not active) */
  rememberUntil: Date | null;
  /** Whether recovery key has been shown to user */
  recoveryKeyShown: boolean;
  /** When password was last changed */
  passwordChangedAt: Date | null;
}

/**
 * Error thrown when password operations fail
 */
export class PasswordProtectionError extends Error {
  constructor(
    message: string,
    public readonly code: PasswordErrorCode,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'PasswordProtectionError';
  }
}

export type PasswordErrorCode =
  | 'WRONG_PASSWORD'
  | 'PASSWORD_TOO_WEAK'
  | 'NOT_ENABLED'
  | 'ALREADY_ENABLED'
  | 'KEY_NOT_FOUND'
  | 'DECRYPTION_FAILED'
  | 'ENCRYPTION_FAILED'
  | 'STORAGE_ERROR'
  | 'INVALID_STATE';

/**
 * PBKDF2 configuration
 * OWASP 2023 recommends 600,000 iterations for PBKDF2-SHA512
 */
const PBKDF2_CONFIG = {
  iterations: 600_000,
  keyLength: 32, // 256 bits for AES-256
  digest: 'sha512',
  saltLength: 32,
} as const;

/**
 * Remember password duration in days
 */
const REMEMBER_DURATION_DAYS = 7;

/**
 * Keystore account name for temporarily cached decrypted key
 */
const TEMP_KEY_ACCOUNT = 'database-encryption-key-temp';

/**
 * PasswordProtectionService manages optional password protection for database encryption
 *
 * Uses file-based config storage so it can check password status before SQLite DB opens.
 */
export class PasswordProtectionService {
  private readonly serviceName = 'com.notely.desktop';
  private readonly configPath: string;
  private decryptedKeyCache: string | null = null;

  constructor(private readonly baseDir: string) {
    // Config stored in <baseDir>/config/password-protection.json
    this.configPath = path.join(baseDir, 'config', CONFIG_FILENAME);
  }

  /**
   * Read the config file
   */
  private readConfig(): PasswordProtectionConfig {
    try {
      if (!fs.existsSync(this.configPath)) {
        return { enabled: false };
      }
      const content = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(content) as PasswordProtectionConfig;
    } catch (error) {
      logger.warn('PasswordProtectionService: Failed to read config file', {
        error: error instanceof Error ? error.message : error,
        path: this.configPath,
      });
      return { enabled: false };
    }
  }

  /**
   * Write the config file
   */
  private writeConfig(config: PasswordProtectionConfig): void {
    try {
      // Ensure config directory exists
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }
      // Write with restricted permissions (owner read/write only)
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } catch (error) {
      throw new PasswordProtectionError(
        'Failed to write config file',
        'STORAGE_ERROR',
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get current password protection status
   * This can be called BEFORE the SQLite database is opened.
   */
  async getStatus(): Promise<PasswordProtectionStatus> {
    const config = this.readConfig();

    const enabled = config.enabled === true;
    const rememberEnabled = config.rememberEnabled === true;
    const rememberUntil = config.rememberUntil ? new Date(config.rememberUntil) : null;
    const rememberActive =
      rememberEnabled && rememberUntil !== null && rememberUntil.getTime() > Date.now();

    // Check if locked (enabled but no decrypted key available)
    let locked = false;
    if (enabled) {
      locked = !(await this.hasDecryptedKey());
    }

    return {
      enabled,
      locked,
      rememberActive,
      rememberUntil: rememberActive ? rememberUntil : null,
      recoveryKeyShown: config.recoveryKeyShown === 'true' || !!config.recoveryKeyShown,
      passwordChangedAt: config.passwordChangedAt ? new Date(config.passwordChangedAt) : null,
    };
  }

  /**
   * Quick synchronous check if password protection is enabled
   * Used by startup flow to decide whether to show password prompt
   */
  isPasswordProtectionEnabled(): boolean {
    const config = this.readConfig();
    return config.enabled === true;
  }

  /**
   * Check if a decrypted key is available (in memory or temp keystore)
   */
  private async hasDecryptedKey(): Promise<boolean> {
    // Check in-memory cache first
    if (this.decryptedKeyCache) {
      return true;
    }

    // Check temp keystore if "remember" is active
    try {
      const keytar = await getKeytar();
      const tempKey = await keytar.getPassword(this.serviceName, TEMP_KEY_ACCOUNT);
      if (tempKey && /^[0-9a-f]{64}$/i.test(tempKey)) {
        // Validate remember hasn't expired
        const config = this.readConfig();
        if (config.rememberUntil) {
          const rememberUntil = new Date(config.rememberUntil);
          if (rememberUntil.getTime() > Date.now()) {
            this.decryptedKeyCache = tempKey.toLowerCase();
            return true;
          }
        }
        // Expired or no expiry set - clean up
        await this.clearRememberPassword();
      }
    } catch {
      // Keystore error - not available
    }

    return false;
  }

  /**
   * Enable password protection
   *
   * @param password - User's chosen password
   * @param confirmPassword - Password confirmation
   * @throws PasswordProtectionError if already enabled, passwords don't match, or password is weak
   */
  async enablePasswordProtection(password: string, confirmPassword: string): Promise<void> {
    // Validate status
    const status = await this.getStatus();
    if (status.enabled) {
      throw new PasswordProtectionError(
        'Password protection is already enabled',
        'ALREADY_ENABLED'
      );
    }

    // Validate password match
    if (password !== confirmPassword) {
      throw new PasswordProtectionError('Passwords do not match', 'PASSWORD_TOO_WEAK');
    }

    // Validate password strength (minimum 8 characters)
    if (password.length < 8) {
      throw new PasswordProtectionError(
        'Password must be at least 8 characters',
        'PASSWORD_TOO_WEAK'
      );
    }

    // Get the current encryption key from keystore
    const keyManager = getEncryptionKeyManager(this.baseDir);
    let encryptionKey: string;
    try {
      encryptionKey = await keyManager.getOrCreateKey();
    } catch (error) {
      throw new PasswordProtectionError(
        'Failed to get encryption key',
        'KEY_NOT_FOUND',
        error instanceof Error ? error : undefined
      );
    }

    // Encrypt the key with the password
    const encryptedBlob = await this.encryptKeyWithPassword(encryptionKey, password);

    // Store encrypted blob in config file
    const config = this.readConfig();
    config.enabled = true;
    config.encryptedKeyBlob = encryptedBlob;
    config.passwordChangedAt = new Date().toISOString();
    this.writeConfig(config);

    // Delete the key from keystore (password mode means no keystore storage)
    try {
      await keyManager.deleteKey();
      logger.info('PasswordProtectionService: Deleted encryption key from keystore');
    } catch (error) {
      logger.warn('PasswordProtectionService: Failed to delete key from keystore', {
        error: error instanceof Error ? error.message : error,
      });
    }

    // Cache the decrypted key in memory for this session
    this.decryptedKeyCache = encryptionKey;

    logger.info('PasswordProtectionService: Password protection enabled');
  }

  /**
   * Verify password and unlock the database
   *
   * @param password - User's password
   * @param remember - Whether to enable "remember for 7 days"
   * @returns true if password is correct
   */
  async verifyPassword(password: string, remember: boolean = false): Promise<boolean> {
    const config = this.readConfig();
    if (!config.enabled) {
      throw new PasswordProtectionError('Password protection is not enabled', 'NOT_ENABLED');
    }

    // Get encrypted blob from config
    const blob = config.encryptedKeyBlob;
    if (!blob) {
      throw new PasswordProtectionError('Encrypted key blob not found', 'KEY_NOT_FOUND');
    }

    // Attempt decryption
    let decryptedKey: string;
    try {
      decryptedKey = await this.decryptKeyWithPassword(blob, password);
    } catch (error) {
      if (error instanceof PasswordProtectionError && error.code === 'WRONG_PASSWORD') {
        return false;
      }
      throw error;
    }

    // Cache the decrypted key
    this.decryptedKeyCache = decryptedKey;

    // Handle "remember password" if requested
    if (remember) {
      await this.enableRememberPassword(decryptedKey);
    }

    logger.info('PasswordProtectionService: Password verified successfully', { remember });
    return true;
  }

  /**
   * Change the password
   *
   * @param currentPassword - Current password for verification
   * @param newPassword - New password
   * @param confirmPassword - New password confirmation
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    confirmPassword: string
  ): Promise<void> {
    const status = await this.getStatus();
    if (!status.enabled) {
      throw new PasswordProtectionError('Password protection is not enabled', 'NOT_ENABLED');
    }

    // Validate new passwords match
    if (newPassword !== confirmPassword) {
      throw new PasswordProtectionError('New passwords do not match', 'PASSWORD_TOO_WEAK');
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      throw new PasswordProtectionError(
        'Password must be at least 8 characters',
        'PASSWORD_TOO_WEAK'
      );
    }

    // Verify current password and get decrypted key
    const verified = await this.verifyPassword(currentPassword, false);
    if (!verified) {
      throw new PasswordProtectionError('Current password is incorrect', 'WRONG_PASSWORD');
    }

    const decryptedKey = this.decryptedKeyCache;
    if (!decryptedKey) {
      throw new PasswordProtectionError('No decrypted key available', 'INVALID_STATE');
    }

    // Encrypt with new password
    const newBlob = await this.encryptKeyWithPassword(decryptedKey, newPassword);

    // Store new encrypted blob in config
    const config = this.readConfig();
    config.encryptedKeyBlob = newBlob;
    config.passwordChangedAt = new Date().toISOString();
    this.writeConfig(config);

    // Clear remember password (force re-auth with new password)
    await this.clearRememberPassword();

    logger.info('PasswordProtectionService: Password changed successfully');
  }

  /**
   * Disable password protection
   *
   * @param password - Current password for verification
   */
  async disablePasswordProtection(password: string): Promise<void> {
    const status = await this.getStatus();
    if (!status.enabled) {
      throw new PasswordProtectionError('Password protection is not enabled', 'NOT_ENABLED');
    }

    // Verify password
    const verified = await this.verifyPassword(password, false);
    if (!verified) {
      throw new PasswordProtectionError('Password is incorrect', 'WRONG_PASSWORD');
    }

    const decryptedKey = this.decryptedKeyCache;
    if (!decryptedKey) {
      throw new PasswordProtectionError('No decrypted key available', 'INVALID_STATE');
    }

    // Store key back in keystore
    const keyManager = getEncryptionKeyManager(this.baseDir);
    try {
      await keyManager.importRecoveryKey(decryptedKey);
      logger.info('PasswordProtectionService: Restored encryption key to keystore');
    } catch (error) {
      throw new PasswordProtectionError(
        'Failed to restore key to keystore',
        'STORAGE_ERROR',
        error instanceof Error ? error : undefined
      );
    }

    // Clear password protection config
    const config = this.readConfig();
    config.enabled = false;
    delete config.encryptedKeyBlob;
    delete config.rememberEnabled;
    delete config.rememberUntil;
    // Keep recoveryKeyShown and passwordChangedAt for audit purposes
    this.writeConfig(config);

    // Clear remember password from keystore
    await this.clearRememberPassword();

    // Clear memory cache
    this.decryptedKeyCache = null;

    logger.info('PasswordProtectionService: Password protection disabled');
  }

  /**
   * Get the decrypted encryption key (for use by DatabaseManager)
   *
   * @returns The decrypted key, or null if locked
   */
  async getDecryptedKey(): Promise<string | null> {
    const status = await this.getStatus();

    if (!status.enabled) {
      // Not using password protection - delegate to regular key manager
      const keyManager = getEncryptionKeyManager(this.baseDir);
      return keyManager.getOrCreateKey();
    }

    if (status.locked) {
      return null;
    }

    // Return cached key (populated by hasDecryptedKey or verifyPassword)
    return this.decryptedKeyCache;
  }

  /**
   * Mark that the recovery key has been shown to the user
   */
  async markRecoveryKeyShown(): Promise<void> {
    const config = this.readConfig();
    config.recoveryKeyShown = new Date().toISOString();
    this.writeConfig(config);
    logger.info('PasswordProtectionService: Recovery key marked as shown');
  }

  /**
   * Verify a recovery key matches the encrypted key
   *
   * @param recoveryKey - 64-character hex recovery key
   * @returns true if recovery key is valid
   */
  async verifyRecoveryKey(recoveryKey: string): Promise<boolean> {
    const status = await this.getStatus();
    if (!status.enabled) {
      // When not in password mode, verify against keystore
      const keyManager = getEncryptionKeyManager(this.baseDir);
      const storedKey = await keyManager.exportRecoveryKey();
      return storedKey.toLowerCase() === recoveryKey.toLowerCase().trim();
    }

    // When in password mode, we can't verify without the password
    // This is a security limitation - recovery key can only be verified
    // by attempting to use it with the database
    logger.warn(
      'PasswordProtectionService: Cannot verify recovery key in password mode without password'
    );
    return false;
  }

  /**
   * Reset password using recovery key
   *
   * @param recoveryKey - 64-character hex recovery key
   * @param newPassword - New password
   * @param confirmPassword - New password confirmation
   */
  async resetPasswordWithRecoveryKey(
    recoveryKey: string,
    newPassword: string,
    confirmPassword: string
  ): Promise<void> {
    const status = await this.getStatus();
    if (!status.enabled) {
      throw new PasswordProtectionError('Password protection is not enabled', 'NOT_ENABLED');
    }

    // Validate recovery key format
    const trimmedKey = recoveryKey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(trimmedKey)) {
      throw new PasswordProtectionError(
        'Invalid recovery key format. Expected 64 hexadecimal characters.',
        'WRONG_PASSWORD'
      );
    }

    // Validate new passwords match
    if (newPassword !== confirmPassword) {
      throw new PasswordProtectionError('New passwords do not match', 'PASSWORD_TOO_WEAK');
    }

    // Validate new password strength
    if (newPassword.length < 8) {
      throw new PasswordProtectionError(
        'Password must be at least 8 characters',
        'PASSWORD_TOO_WEAK'
      );
    }

    // The recovery key IS the encryption key - encrypt it with new password
    const newBlob = await this.encryptKeyWithPassword(trimmedKey, newPassword);

    // Store new encrypted blob in config
    const config = this.readConfig();
    config.encryptedKeyBlob = newBlob;
    config.passwordChangedAt = new Date().toISOString();
    this.writeConfig(config);

    // Cache the decrypted key
    this.decryptedKeyCache = trimmedKey;

    // Clear remember password
    await this.clearRememberPassword();

    logger.info('PasswordProtectionService: Password reset with recovery key');
  }

  /**
   * Enable "remember password for 7 days"
   */
  private async enableRememberPassword(decryptedKey: string): Promise<void> {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + REMEMBER_DURATION_DAYS);

    try {
      // Store decrypted key in temp keystore location
      const keytar = await getKeytar();
      await keytar.setPassword(this.serviceName, TEMP_KEY_ACCOUNT, decryptedKey);

      // Store remember settings in config
      const config = this.readConfig();
      config.rememberEnabled = true;
      config.rememberUntil = expiryDate.toISOString();
      this.writeConfig(config);

      logger.info('PasswordProtectionService: Remember password enabled', {
        expiresAt: expiryDate.toISOString(),
      });
    } catch (error) {
      logger.warn('PasswordProtectionService: Failed to enable remember password', {
        error: error instanceof Error ? error.message : error,
      });
      // Non-fatal - user just won't get the remember feature
    }
  }

  /**
   * Clear "remember password" cache
   */
  async clearRememberPassword(): Promise<void> {
    try {
      const keytar = await getKeytar();
      await keytar.deletePassword(this.serviceName, TEMP_KEY_ACCOUNT);
    } catch {
      // Ignore keystore errors
    }

    try {
      const config = this.readConfig();
      delete config.rememberEnabled;
      delete config.rememberUntil;
      this.writeConfig(config);
    } catch {
      // Ignore config errors
    }

    logger.debug('PasswordProtectionService: Remember password cleared');
  }

  /**
   * Lock the database (clear cached key)
   */
  lock(): void {
    this.decryptedKeyCache = null;
    logger.info('PasswordProtectionService: Database locked');
  }

  /**
   * Encrypt the encryption key with a password
   */
  private async encryptKeyWithPassword(key: string, password: string): Promise<EncryptedKeyBlob> {
    // Generate random salt
    const salt = crypto.randomBytes(PBKDF2_CONFIG.saltLength);

    // Derive key from password
    const derivedKey = await this.deriveKey(password, salt);

    // Generate random IV for AES-GCM
    const iv = crypto.randomBytes(12);

    // Encrypt
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    const keyBuffer = Buffer.from(key, 'hex');
    const encrypted = Buffer.concat([cipher.update(keyBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      encryptedKey: encrypted.toString('hex'),
      iterations: PBKDF2_CONFIG.iterations,
      version: 1,
    };
  }

  /**
   * Decrypt the encryption key with a password
   */
  private async decryptKeyWithPassword(blob: EncryptedKeyBlob, password: string): Promise<string> {
    const salt = Buffer.from(blob.salt, 'hex');
    const iv = Buffer.from(blob.iv, 'hex');
    const authTag = Buffer.from(blob.authTag, 'hex');
    const encryptedKey = Buffer.from(blob.encryptedKey, 'hex');

    // Derive key from password
    const derivedKey = await this.deriveKey(password, salt, blob.iterations);

    // Decrypt
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encryptedKey), decipher.final()]);
      return decrypted.toString('hex');
    } catch (error) {
      throw new PasswordProtectionError('Incorrect password', 'WRONG_PASSWORD');
    }
  }

  /**
   * Derive an AES key from password using PBKDF2
   */
  private deriveKey(
    password: string,
    salt: Buffer,
    iterations: number = PBKDF2_CONFIG.iterations
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        password,
        salt,
        iterations,
        PBKDF2_CONFIG.keyLength,
        PBKDF2_CONFIG.digest,
        (err, key) => {
          if (err) {
            reject(new PasswordProtectionError('Key derivation failed', 'ENCRYPTION_FAILED', err));
          } else {
            resolve(key);
          }
        }
      );
    });
  }
}

/**
 * Singleton instance for application-wide use
 */
let passwordProtectionServiceInstance: PasswordProtectionService | null = null;

/**
 * Get or create the PasswordProtectionService singleton
 * @param baseDir - Required on first call: app base directory
 */
export function getPasswordProtectionService(baseDir?: string): PasswordProtectionService {
  if (!passwordProtectionServiceInstance) {
    if (!baseDir) {
      throw new Error('PasswordProtectionService requires baseDir for initialization');
    }
    passwordProtectionServiceInstance = new PasswordProtectionService(baseDir);
  }
  return passwordProtectionServiceInstance;
}

/**
 * Reset the singleton (for testing)
 */
export function resetPasswordProtectionService(): void {
  passwordProtectionServiceInstance = null;
}
