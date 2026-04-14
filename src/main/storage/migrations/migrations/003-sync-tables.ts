/**
 * Migration 003: Add sync infrastructure tables
 *
 * Creates sync_config, sync_items, and sync_log tables needed by
 * the cursor-based sync engine. Seeds the default cursor at '0'.
 */

import type Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { Migration } from '../MigrationRunner';

export const migration003SyncTables: Migration = {
  version: 3,
  description: 'Add sync infrastructure tables (sync_config, sync_items, sync_log)',

  up: (db: DatabaseInstance) => {
    // ================================================================
    // 1. sync_config — key-value store for sync state (cursor, etc.)
    // ================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    // ================================================================
    // 2. sync_items — tracks per-entity sync state
    // ================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_items (
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        sync_time INTEGER NOT NULL DEFAULT 0,
        pending_mutation_id TEXT,
        sync_disabled INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (entity_type, entity_id)
      )
    `);

    // ================================================================
    // 3. sync_log — audit log of sync operations
    // ================================================================
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operation TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'started',
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        entity_type TEXT,
        entity_count INTEGER DEFAULT 0,
        error_message TEXT,
        session_id TEXT
      )
    `);

    // ================================================================
    // 4. Indexes
    // ================================================================
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sync_items_pending ON sync_items(sync_time) WHERE sync_time = 0`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_items_type ON sync_items(entity_type, sync_time)`);

    // ================================================================
    // 5. Seed default cursor
    // ================================================================
    db.exec(`INSERT OR IGNORE INTO sync_config (key, value) VALUES ('cursor', '0')`);
  },
};
