/**
 * SafeStorageBackend - Secure credential storage using Electron's safeStorage API
 *
 * Drop-in replacement for keytar that uses Electron's built-in safeStorage API.
 * Provides the same interface as keytar but stores encrypted blobs in a JSON file.
 *
 * Storage location: <userData>/config/secure-storage.json
 *
 * Security:
 * - macOS: Uses Keychain for encryption keys
 * - Windows: Uses DPAPI (Data Protection API)
 * - Linux: Uses libsecret (GNOME Keyring / KWallet) when available
 *
 * Note: On Linux without a keyring, safeStorage may fall back to less secure storage.
 */

import fs from 'node:fs';
import path from 'node:path';

import { safeStorage, app } from 'electron';

import { logger } from '../../logger';

/**
 * Interface matching keytar's API for drop-in compatibility
 */
export interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials?(service: string): Promise<Array<{ account: string; password: string }>>;
}

/**
 * Storage entry for a single credential
 */
interface StorageEntry {
  /** Base64-encoded encrypted buffer */
  encrypted: string;
  /** ISO timestamp when entry was created */
  createdAt: string;
  /** ISO timestamp when entry was last updated */
  updatedAt: string;
}

/**
 * Structure of the secure storage JSON file
 */
interface SecureStorageFile {
  /** Schema version for future migrations */
  version: 1;
  /** Map of "service:account" keys to encrypted entries */
  entries: Record<string, StorageEntry>;
}

const STORAGE_VERSION = 1;
const CONFIG_FILENAME = 'secure-storage.json';

/**
 * SafeStorageBackend implements the KeytarModule interface using Electron's safeStorage API.
 * Encrypted credential blobs are stored in a JSON file in the user's config directory.
 */
export class SafeStorageBackend implements KeytarModule {
  private storagePath: string | null = null;
  private cache: SecureStorageFile | null = null;

  /**
   * Get the path to the secure storage file, creating the config directory if needed
   */
  private getStoragePath(): string {
    if (!this.storagePath) {
      const userDataPath = app.getPath('userData');
      const configDir = path.join(userDataPath, 'config');

      // Ensure config directory exists with restricted permissions
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      }

      this.storagePath = path.join(configDir, CONFIG_FILENAME);
    }
    return this.storagePath;
  }

  /**
   * Create a unique key from service and account names
   */
  private makeKey(service: string, account: string): string {
    return `${service}:${account}`;
  }

  /**
   * Parse a key back into service and account
   */
  private parseKey(key: string): { service: string; account: string } | null {
    const colonIndex = key.indexOf(':');
    if (colonIndex === -1) return null;
    return {
      service: key.substring(0, colonIndex),
      account: key.substring(colonIndex + 1),
    };
  }

  /**
   * Read and parse the storage file, creating an empty structure if it doesn't exist
   */
  private readStorage(): SecureStorageFile {
    if (this.cache) {
      return this.cache;
    }

    const storagePath = this.getStoragePath();

    try {
      if (fs.existsSync(storagePath)) {
        const content = fs.readFileSync(storagePath, 'utf-8');
        const parsed = JSON.parse(content) as SecureStorageFile;

        if (parsed.version !== STORAGE_VERSION) {
          logger.warn('SafeStorageBackend: Unknown storage version, creating fresh', {
            found: parsed.version,
            expected: STORAGE_VERSION,
          });
          this.cache = { version: STORAGE_VERSION, entries: {} };
        } else {
          this.cache = parsed;
        }
      } else {
        this.cache = { version: STORAGE_VERSION, entries: {} };
      }
    } catch (error) {
      logger.error('SafeStorageBackend: Failed to read storage file', {
        error: error instanceof Error ? error.message : error,
        path: storagePath,
      });
      this.cache = { version: STORAGE_VERSION, entries: {} };
    }

    return this.cache;
  }

  /**
   * Write the storage file with restricted permissions
   */
  private writeStorage(data: SecureStorageFile): void {
    const storagePath = this.getStoragePath();

    try {
      fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: 0o600, // Owner read/write only
      });
      this.cache = data;
    } catch (error) {
      logger.error('SafeStorageBackend: Failed to write storage file', {
        error: error instanceof Error ? error.message : error,
        path: storagePath,
      });
      throw error;
    }
  }

  /**
   * Get a stored password/credential
   * @param service - Service name (e.g., 'com.notely.desktop')
   * @param account - Account name (e.g., 'database-encryption-key')
   * @returns The decrypted password or null if not found
   */
  async getPassword(service: string, account: string): Promise<string | null> {
    if (!safeStorage.isEncryptionAvailable()) {
      logger.warn('SafeStorageBackend: Encryption not available');
      return null;
    }

    const storage = this.readStorage();
    const key = this.makeKey(service, account);
    const entry = storage.entries[key];

    if (!entry) {
      return null;
    }

    try {
      const encryptedBuffer = Buffer.from(entry.encrypted, 'base64');
      const decrypted = safeStorage.decryptString(encryptedBuffer);
      return decrypted;
    } catch (error) {
      logger.error('SafeStorageBackend: Failed to decrypt value', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Store a password/credential
   * @param service - Service name (e.g., 'com.notely.desktop')
   * @param account - Account name (e.g., 'database-encryption-key')
   * @param password - The password/credential to store
   */
  async setPassword(service: string, account: string, password: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('SafeStorage encryption is not available on this system');
    }

    const storage = this.readStorage();
    const key = this.makeKey(service, account);
    const now = new Date().toISOString();

    try {
      const encryptedBuffer = safeStorage.encryptString(password);
      const encrypted = encryptedBuffer.toString('base64');

      const existingEntry = storage.entries[key];
      storage.entries[key] = {
        encrypted,
        createdAt: existingEntry?.createdAt ?? now,
        updatedAt: now,
      };

      this.writeStorage(storage);

      logger.debug('SafeStorageBackend: Stored value', { key });
    } catch (error) {
      logger.error('SafeStorageBackend: Failed to encrypt/store value', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Delete a stored password/credential
   * @param service - Service name
   * @param account - Account name
   * @returns true if deleted, false if not found
   */
  async deletePassword(service: string, account: string): Promise<boolean> {
    const storage = this.readStorage();
    const key = this.makeKey(service, account);

    if (!(key in storage.entries)) {
      return false;
    }

    delete storage.entries[key];
    this.writeStorage(storage);

    logger.debug('SafeStorageBackend: Deleted value', { key });
    return true;
  }

  /**
   * Find all credentials for a service
   * Used for migration from keytar
   * @param service - Service name to search for
   * @returns Array of account/password pairs
   */
  async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
    if (!safeStorage.isEncryptionAvailable()) {
      return [];
    }

    const storage = this.readStorage();
    const results: Array<{ account: string; password: string }> = [];
    const prefix = `${service}:`;

    for (const key of Object.keys(storage.entries)) {
      if (key.startsWith(prefix)) {
        const parsed = this.parseKey(key);
        if (parsed && parsed.service === service) {
          try {
            const password = await this.getPassword(service, parsed.account);
            if (password) {
              results.push({ account: parsed.account, password });
            }
          } catch {
            // Skip entries that fail to decrypt
          }
        }
      }
    }

    return results;
  }

  /**
   * Check if safeStorage encryption is available
   */
  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  /**
   * Get the storage backend being used on Linux
   * Returns the backend type: 'basic_text', 'gnome_libsecret', 'kwallet', etc.
   */
  getSelectedStorageBackend(): string {
    if (
      process.platform === 'linux' &&
      typeof safeStorage.getSelectedStorageBackend === 'function'
    ) {
      return safeStorage.getSelectedStorageBackend();
    }
    return process.platform === 'linux' ? 'unknown' : 'native';
  }

  /**
   * Check if we're using a secure backend (not plaintext)
   */
  isUsingSecureBackend(): boolean {
    if (process.platform !== 'linux') {
      // macOS and Windows always use secure storage
      return safeStorage.isEncryptionAvailable();
    }

    const backend = this.getSelectedStorageBackend();
    // basic_text means plaintext fallback on Linux
    return backend !== 'basic_text' && backend !== 'unknown';
  }

  /**
   * Clear the in-memory cache (for testing)
   */
  clearCache(): void {
    this.cache = null;
  }
}

// Singleton instance
let instance: SafeStorageBackend | null = null;

/**
 * Get the singleton SafeStorageBackend instance
 */
export function getSafeStorageBackend(): SafeStorageBackend {
  if (!instance) {
    instance = new SafeStorageBackend();
  }
  return instance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetSafeStorageBackend(): void {
  if (instance) {
    instance.clearCache();
  }
  instance = null;
}
