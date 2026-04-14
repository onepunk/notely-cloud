/**
 * Database manager interface - Core database operations and connection management
 */

import Database from 'better-sqlite3-multiple-ciphers';

// Type aliases for better-sqlite3-multiple-ciphers
type DatabaseInstance = InstanceType<typeof Database>;
type Statement = Database.Statement;

export type TransactionCallback<T> = () => T;

/**
 * Database manager interface for low-level database operations
 */
export interface IDatabaseManager {
  /**
   * Get the raw database instance (use with caution)
   */
  getDatabase(): DatabaseInstance;

  /**
   * Execute a transaction with automatic rollback on error
   */
  transaction<T>(callback: TransactionCallback<T>): T;

  /**
   * Execute a prepared statement
   */
  prepare(sql: string): Statement;

  /**
   * Execute raw SQL (for migrations and setup)
   */
  exec(sql: string): void;

  /**
   * Open the database connection
   */
  open(): Promise<void>;

  /**
   * Check if database connection is healthy
   */
  isHealthy(): boolean;

  /**
   * Get detailed health status
   */
  getHealthStatus(): Promise<{
    connected: boolean;
    walMode: boolean;
    foreignKeysEnabled: boolean;
    encrypted?: boolean;
  }>;

  /**
   * Get database pragma values
   */
  getPragma(name: string): unknown;

  /**
   * Set database pragma values
   */
  setPragma(name: string, value: string | number): void;

  /**
   * Close the database connection
   */
  close(): void;

  /**
   * Get database file path
   */
  getPath(): string;

  /**
   * Check if the database is currently encrypted
   */
  isEncrypted?(): boolean;

  /**
   * Check if the database needs encryption migration
   */
  needsEncryptionMigration?(): boolean;
}
