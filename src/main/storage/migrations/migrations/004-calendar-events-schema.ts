/**
 * Migration 004: Rebuild calendar cache tables
 *
 * The original calendar_events and calendar_event_sync_ranges tables
 * had column names that didn't match CalendarEventService (e.g.
 * user_profile_id vs account_id, external_id vs event_id, raw_data vs
 * raw_payload, missing is_cancelled / last_modified / synced_at).
 *
 * Since these are cache tables (data is re-fetched from the remote
 * calendar API), dropping and recreating them is safe.
 */

import type Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { Migration } from '../MigrationRunner';

export const migration004CalendarEventsSchema: Migration = {
  version: 4,
  description: 'Rebuild calendar cache tables to match CalendarEventService columns',

  up: (db: DatabaseInstance) => {
    // Drop old tables (cache data only — will be re-fetched from remote API)
    db.exec(`DROP TABLE IF EXISTS calendar_event_sync_ranges`);
    db.exec(`DROP TABLE IF EXISTS calendar_events`);

    // Recreate with correct columns
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        account_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        provider TEXT,
        calendar_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        is_all_day INTEGER NOT NULL DEFAULT 0,
        is_cancelled INTEGER NOT NULL DEFAULT 0,
        last_modified INTEGER,
        raw_payload TEXT,
        synced_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, event_id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_event_sync_ranges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        range_start INTEGER NOT NULL,
        range_end INTEGER NOT NULL,
        synced_at INTEGER NOT NULL,
        UNIQUE(account_id, range_start, range_end)
      )
    `);
  },
};
