/**
 * DatabaseManager - Core database connection and transaction management
 *
 * Supports SQLCipher encryption via better-sqlite3-multiple-ciphers.
 * When encryption is enabled, the database is encrypted at rest using
 * a key stored in the OS keystore.
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';

// Type alias for database instance
type DatabaseInstance = InstanceType<typeof Database>;
type Statement = Database.Statement;

import { logger } from '../../logger';
import { getPasswordProtectionService } from '../../services/security/PasswordProtectionService';
import type { IDatabaseManager, TransactionCallback } from '../interfaces/IDatabaseManager';

/**
 * Options for DatabaseManager
 */
export interface DatabaseManagerOptions {
  /** Enable SQLCipher encryption. Default: true */
  encryption?: boolean;
}

/**
 * Marker file indicating the database has been encrypted
 */
const ENCRYPTION_MARKER_FILE = '.db-encryption-complete';

export class DatabaseManager implements IDatabaseManager {
  private db: DatabaseInstance;
  private dbPath: string;
  private encrypted = false;
  private readonly encryptionEnabled: boolean;

  constructor(
    private baseDir: string,
    options: DatabaseManagerOptions = {}
  ) {
    // Enable encryption by default
    this.encryptionEnabled = options.encryption !== false;

    logger.debug('DatabaseManager: Initialized with encryption=%s', this.encryptionEnabled);
  }

  async open(): Promise<void> {
    if (this.db && this.db.open) {
      return; // Already open
    }
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      const dataDir = path.join(this.baseDir, 'data');
      fs.mkdirSync(dataDir, { recursive: true });

      // Ensure objects directory exists for file storage
      fs.mkdirSync(path.join(this.baseDir, 'objects'), { recursive: true });

      // Initialize database
      this.dbPath = path.join(dataDir, 'notes.sqlite');
      this.db = new Database(this.dbPath);

      if (!this.db) {
        throw new Error('Failed to create database connection');
      }

      // Apply encryption key FIRST if encryption is enabled
      if (this.encryptionEnabled) {
        await this.applyEncryptionKey();
      }

      // Configure database for optimal performance and consistency
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('synchronous = NORMAL'); // Good balance of performance and durability
      this.db.pragma('cache_size = 10000'); // 10MB cache
      this.db.pragma('temp_store = memory'); // Use memory for temporary storage

      // Verify foreign key constraints are enabled
      const foreignKeysResult = this.db.pragma('foreign_keys', { simple: true }) as number;
      logger.info(
        'Database initialized successfully at: %s (foreign_keys=%d, encrypted=%s)',
        this.dbPath,
        foreignKeysResult,
        this.encrypted
      );
      if (foreignKeysResult !== 1) {
        logger.warn(
          'Foreign key constraints are NOT enabled! This may lead to data integrity issues.'
        );
      }
    } catch (error) {
      logger.error(
        'Failed to initialize database: %s',
        error instanceof Error ? error.stack || error.message : String(error)
      );
      throw error;
    }
  }

  /**
   * Apply the SQLCipher encryption key to the database.
   * Must be called immediately after opening the database, before any other operations.
   *
   * Uses PasswordProtectionService.getDecryptedKey() which handles both:
   * - Auto-unlock mode: Gets key from OS keystore via EncryptionKeyManager
   * - Password mode: Gets key from in-memory cache after password verification
   */
  private async applyEncryptionKey(): Promise<void> {
    const markerPath = path.join(path.dirname(this.dbPath), ENCRYPTION_MARKER_FILE);
    const isMarked = fs.existsSync(markerPath);

    // Check if the database file exists and has content
    const dbExists = fs.existsSync(this.dbPath);
    const dbSize = dbExists ? fs.statSync(this.dbPath).size : 0;

    // Get the encryption key via PasswordProtectionService
    // This handles both auto-unlock mode (keystore) and password mode (memory cache)
    const passwordService = getPasswordProtectionService(this.baseDir);
    const encryptionKey = await passwordService.getDecryptedKey();

    if (!encryptionKey) {
      // This should only happen if:
      // 1. Password protection is enabled AND
      // 2. Password hasn't been verified yet
      throw new Error(
        'Database encryption key not available. Password protection is enabled but database is locked.'
      );
    }

    // Format key for SQLCipher as a quoted literal to avoid PRAGMA parse errors
    const sqlCipherKey = this.formatSqlCipherKey(encryptionKey);

    if (!dbExists || dbSize === 0) {
      // New database - apply key to create encrypted
      logger.debug('DatabaseManager: Creating new encrypted database');
      this.db.pragma(`key = ${sqlCipherKey}`);
      this.encrypted = true;

      // Create marker file
      fs.writeFileSync(markerPath, new Date().toISOString(), { mode: 0o600 });
      return;
    }

    if (isMarked) {
      // Database should be encrypted - apply key
      logger.debug('DatabaseManager: Opening encrypted database');
      this.db.pragma(`key = ${sqlCipherKey}`);

      // Verify we can read the database (key is correct)
      try {
        this.db.prepare('SELECT 1').get();
        this.encrypted = true;
        logger.debug('DatabaseManager: Encryption key verified successfully');
      } catch (error) {
        logger.error('DatabaseManager: Failed to decrypt database - wrong key?', {
          error: error instanceof Error ? error.message : error,
        });
        throw new Error(
          'Failed to open encrypted database. The encryption key may be incorrect or the database may be corrupted.'
        );
      }
    } else {
      // Existing unencrypted database - needs migration
      // For now, operate without encryption until migration runs
      logger.warn(
        'DatabaseManager: Existing unencrypted database detected. ' +
          'Run encryption migration to secure the database.'
      );
      this.encrypted = false;
    }
  }

  private formatSqlCipherKey(hexKey: string): string {
    return `'x''${hexKey}'''`;
  }

  /**
   * Check if the database is currently encrypted
   */
  isEncrypted(): boolean {
    return this.encrypted;
  }

  /**
   * Check if the database needs encryption migration
   */
  needsEncryptionMigration(): boolean {
    if (!this.encryptionEnabled) {
      return false;
    }

    const markerPath = path.join(path.dirname(this.dbPath), ENCRYPTION_MARKER_FILE);
    const isMarked = fs.existsSync(markerPath);
    const dbExists = fs.existsSync(this.dbPath);
    const dbSize = dbExists ? fs.statSync(this.dbPath).size : 0;

    // Needs migration if: DB exists, has content, and is not marked as encrypted
    return dbExists && dbSize > 0 && !isMarked;
  }

  getDatabase(): DatabaseInstance {
    if (!this.db) {
      throw new Error(`Database not initialized. this.db is ${this.db}. Call open() first.`);
    }
    if (!this.db.open) {
      throw new Error(
        `Database connection is closed. this.db.open is ${this.db.open}. Call open() first.`
      );
    }
    return this.db;
  }

  transaction<T>(callback: TransactionCallback<T>): T {
    const tx = this.db.transaction(callback);
    return tx();
  }

  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  isHealthy(): boolean {
    try {
      // Simple query to test database connectivity
      this.db.prepare('SELECT 1').get();
      return true;
    } catch (error) {
      logger.error(
        'Database health check failed: %s',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  async getHealthStatus(): Promise<{
    connected: boolean;
    walMode: boolean;
    foreignKeysEnabled: boolean;
    encrypted: boolean;
  }> {
    try {
      const connected = this.isHealthy();
      if (!connected) {
        return {
          connected: false,
          walMode: false,
          foreignKeysEnabled: false,
          encrypted: false,
        };
      }

      const journalMode = this.getPragma('journal_mode') as string;
      const foreignKeys = this.getPragma('foreign_keys') as number;

      return {
        connected: true,
        walMode: journalMode?.toLowerCase() === 'wal',
        foreignKeysEnabled: foreignKeys === 1,
        encrypted: this.encrypted,
      };
    } catch (error) {
      logger.error(
        'Failed to get health status: %s',
        error instanceof Error ? error.message : String(error)
      );
      return {
        connected: false,
        walMode: false,
        foreignKeysEnabled: false,
        encrypted: false,
      };
    }
  }

  getPragma(name: string): unknown {
    const result = this.db.pragma(name);
    return result;
  }

  setPragma(name: string, value: string | number): void {
    this.db.pragma(`${name} = ${value}`);
  }

  close(): void {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  getPath(): string {
    return this.dbPath;
  }

  /**
   * Get database statistics for monitoring
   */
  getStats(): {
    path: string;
    size: number;
    walSize: number;
    pageCount: number;
    pageSize: number;
    cacheSize: number;
    journalMode: string;
    synchronous: string;
    foreignKeys: boolean;
    encrypted: boolean;
  } {
    const stats = fs.statSync(this.dbPath);
    const walPath = `${this.dbPath}-wal`;
    let walSize = 0;

    try {
      const walStats = fs.statSync(walPath);
      walSize = walStats.size;
    } catch {
      // WAL file may not exist
    }

    return {
      path: this.dbPath,
      size: stats.size,
      walSize,
      pageCount: this.db.pragma('page_count', { simple: true }) as number,
      pageSize: this.db.pragma('page_size', { simple: true }) as number,
      cacheSize: this.db.pragma('cache_size', { simple: true }) as number,
      journalMode: this.db.pragma('journal_mode', { simple: true }) as string,
      synchronous: this.db.pragma('synchronous', { simple: true }) as string,
      foreignKeys: Boolean(this.db.pragma('foreign_keys', { simple: true })),
      encrypted: this.encrypted,
    };
  }

  /**
   * Optimize database performance (useful for maintenance)
   */
  optimize(): void {
    // Analyze query planner statistics
    this.db.pragma('analyze');

    // Optimize database structure
    this.db.pragma('optimize');

    // Checkpoint WAL file to main database
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * Verify database integrity
   */
  checkIntegrity(): { ok: boolean; errors: string[] } {
    try {
      const result = this.db.pragma('integrity_check');
      const errors: string[] = [];

      if (Array.isArray(result)) {
        for (const row of result) {
          if (typeof row === 'object' && 'integrity_check' in row) {
            const message = (row as { integrity_check: string }).integrity_check;
            if (message !== 'ok') {
              errors.push(message);
            }
          }
        }
      }

      return { ok: errors.length === 0, errors };
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : 'Unknown integrity check error'],
      };
    }
  }
}
