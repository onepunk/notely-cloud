/**
 * SyncService - Minimal sync configuration management for cursor-based sync
 *
 * This service provides access to sync_config table for storing:
 * - cursor: The current sync cursor position
 * - lastPushAt: Timestamp of last successful push
 * - lastPullAt: Timestamp of last successful pull
 *
 * NOTE: Auth fields are NOT stored here - use AuthService for auth-related data.
 * NOTE: Merkle-based sync has been removed - this is cursor-based sync only.
 */

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { ISyncService } from '../interfaces/ISyncService';
import type {
  SyncConfig,
  UpdateSyncConfigInput,
  SyncOperation,
  SyncStatus,
  SyncLogOptions,
} from '../types/sync';

/**
 * Helper to read a value from the sync_config key-value table.
 */
function getConfigValue(db: DatabaseInstance, key: string): string | null {
  const row = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Helper to upsert a value in the sync_config key-value table.
 */
function setConfigValue(db: DatabaseInstance, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(key, value);
}

/**
 * SyncService - Sync configuration management
 *
 * The sync_config table is a key-value store: (key TEXT PRIMARY KEY, value TEXT NOT NULL).
 * Known keys: cursor, last_push_at, last_pull_at, updated_at
 */
export class SyncService implements ISyncService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager
  ) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Get sync configuration
   */
  async getConfig(): Promise<SyncConfig | null> {
    const cursor = getConfigValue(this.db, 'cursor');
    if (cursor === null) {
      return null;
    }

    const lastPushAt = getConfigValue(this.db, 'last_push_at');
    const lastPullAt = getConfigValue(this.db, 'last_pull_at');
    const updatedAt = getConfigValue(this.db, 'updated_at');

    return {
      id: 1, // Retained for interface compatibility
      lastPushAt: lastPushAt ? Number(lastPushAt) : null,
      lastPullAt: lastPullAt ? Number(lastPullAt) : null,
      createdAt: new Date(0),
      updatedAt: updatedAt ? new Date(Number(updatedAt)) : new Date(0),
    };
  }

  /**
   * Update sync configuration
   */
  async setConfig(updates: UpdateSyncConfigInput): Promise<void> {
    await this.transactionManager.execute(() => {
      const now = Date.now();

      if (updates.lastPushAt !== undefined) {
        setConfigValue(this.db, 'last_push_at', String(updates.lastPushAt ?? ''));
      }

      if (updates.lastPullAt !== undefined) {
        setConfigValue(this.db, 'last_pull_at', String(updates.lastPullAt ?? ''));
      }

      setConfigValue(this.db, 'updated_at', String(now));
    });
  }

  /**
   * Get the current sync cursor value
   */
  async getCursor(): Promise<number> {
    const value = getConfigValue(this.db, 'cursor');
    return value ? Number(value) : 0;
  }

  /**
   * Update the sync cursor value
   */
  async setCursor(cursor: number): Promise<void> {
    await this.transactionManager.execute(() => {
      setConfigValue(this.db, 'cursor', String(cursor));
      setConfigValue(this.db, 'updated_at', String(Date.now()));
    });
  }

  /**
   * Log a sync operation start
   * @returns The log entry ID
   */
  async logOperation(operation: SyncOperation, status: SyncStatus): Promise<number> {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO sync_log (operation, status, started_at, entity_count)
         VALUES (?, ?, ?, 0)`
      )
      .run(operation, status, now);

    return Number(result.lastInsertRowid);
  }

  /**
   * Update a sync operation log entry status
   */
  async updateLogStatus(
    logId: number,
    status: SyncStatus,
    options?: SyncLogOptions
  ): Promise<void> {
    await this.transactionManager.execute(() => {
      const now = Date.now();
      const setParts: string[] = ['status = ?', 'completed_at = ?'];
      const values: (string | number | null)[] = [status, now];

      if (options?.entityType !== undefined) {
        setParts.push('entity_type = ?');
        values.push(options.entityType);
      }

      if (options?.entityCount !== undefined) {
        setParts.push('entity_count = ?');
        values.push(options.entityCount);
      }

      if (options?.errorMessage !== undefined) {
        setParts.push('error_message = ?');
        values.push(options.errorMessage);
      }

      if (options?.sessionId !== undefined) {
        setParts.push('session_id = ?');
        values.push(options.sessionId);
      }

      values.push(logId);
      const sql = `UPDATE sync_log SET ${setParts.join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...values);
    });
  }
}
