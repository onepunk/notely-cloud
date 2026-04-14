import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { logger } from '../../logger';
import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { ISettingsService } from '../interfaces/ISettingsService';
import { Setting } from '../types/entities';

/**
 * SettingsService - Settings key-value store management
 */
export class SettingsService implements ISettingsService {
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
   * Get a setting value by key
   */
  async get(key: string): Promise<string | null> {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key=?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Set a setting value
   */
  async set(key: string, value: string): Promise<void> {
    await this.transactionManager.execute(() => {
      const stmt = this.db.prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      );
      stmt.run(key, value);
    });
  }

  /**
   * Get multiple settings by keys
   */
  async getBatch(keys: string[]): Promise<Record<string, string | null>> {
    if (keys.length === 0) {
      return {};
    }

    const placeholders = keys.map(() => '?').join(',');
    const stmt = this.db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`);
    const rows = stmt.all(...keys) as Array<{ key: string; value: string }>;

    const result: Record<string, string | null> = {};

    // Initialize all keys with null
    for (const key of keys) {
      result[key] = null;
    }

    // Fill in actual values
    for (const row of rows) {
      result[row.key] = row.value;
    }

    return result;
  }

  /**
   * Set multiple settings at once
   */
  async setBatch(settings: Record<string, string>): Promise<void> {
    const entries = Object.entries(settings);
    if (entries.length === 0) {
      return;
    }

    await this.transactionManager.execute(() => {
      const stmt = this.db.prepare(
        'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      );

      for (const [key, value] of entries) {
        stmt.run(key, value);
      }
    });
  }

  /**
   * List settings by key prefix
   */
  async listByPrefix(prefix: string): Promise<Setting[]> {
    const stmt = this.db.prepare('SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key');
    const rows = stmt.all(`${prefix}%`) as Array<{ key: string; value: string }>;

    return rows.map((row) => ({
      key: row.key,
      value: row.value,
    }));
  }

  /**
   * Delete a setting
   */
  async delete(key: string): Promise<void> {
    await this.transactionManager.execute(() => {
      const stmt = this.db.prepare('DELETE FROM settings WHERE key=?');
      stmt.run(key);
    });
  }

  /**
   * Delete settings by prefix
   */
  async deleteByPrefix(prefix: string): Promise<number> {
    return await this.transactionManager.execute(() => {
      const stmt = this.db.prepare('DELETE FROM settings WHERE key LIKE ?');
      const result = stmt.run(`${prefix}%`);
      return result.changes;
    });
  }

  /**
   * Check if setting exists
   */
  async exists(key: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT 1 FROM settings WHERE key=? LIMIT 1');
    const row = stmt.get(key);
    return row !== undefined;
  }

  /**
   * Get all settings (use with caution)
   */
  async getAll(): Promise<Setting[]> {
    const stmt = this.db.prepare('SELECT key, value FROM settings ORDER BY key');
    const rows = stmt.all() as Array<{ key: string; value: string }>;

    return rows.map((row) => ({
      key: row.key,
      value: row.value,
    }));
  }

  /**
   * Get setting with default value
   */
  async getWithDefault(key: string, defaultValue: string): Promise<string> {
    const value = await this.get(key);
    return value !== null ? value : defaultValue;
  }

  /**
   * Get parsed JSON setting with type safety
   */
  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (value === null) {
      return null;
    }

    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.warn(
        `Failed to parse JSON setting '${key}': %s`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Set JSON setting with type safety
   */
  async setJson<T>(key: string, value: T): Promise<void> {
    try {
      const jsonString = JSON.stringify(value);
      await this.set(key, jsonString);
    } catch (error) {
      throw new Error(
        `Failed to serialize value for setting '${key}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
