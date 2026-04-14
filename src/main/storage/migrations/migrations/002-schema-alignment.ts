/**
 * Migration 002: Align schema with service layer
 *
 * Adds missing columns (starred, archived, sync columns, sort_index, deleted)
 * and restructures note_tags, transcription_segments, and summaries tables
 * to match the service layer expectations.
 */

import type Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { Migration } from '../MigrationRunner';

export const migration002SchemaAlignment: Migration = {
  version: 2,
  description:
    'Align schema with service layer (starred, archived, sync columns, table restructures)',

  up: (db: DatabaseInstance) => {
    // ================================================================
    // 1. ALTER TABLE additions — simple column adds
    // ================================================================

    // notes table
    db.exec(`ALTER TABLE notes ADD COLUMN starred INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE notes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE notes ADD COLUMN sync_version INTEGER DEFAULT 1`);
    db.exec(`ALTER TABLE notes ADD COLUMN sync_checksum TEXT`);
    db.exec(`ALTER TABLE notes ADD COLUMN server_updated_at INTEGER`);

    // binders table
    db.exec(`ALTER TABLE binders ADD COLUMN sync_version INTEGER DEFAULT 1`);
    db.exec(`ALTER TABLE binders ADD COLUMN sync_checksum TEXT`);
    db.exec(`ALTER TABLE binders ADD COLUMN server_updated_at INTEGER`);

    // tags table
    db.exec(`ALTER TABLE tags ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0`);
    db.exec(`ALTER TABLE tags ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1`);
    db.exec(`ALTER TABLE tags ADD COLUMN sync_checksum TEXT`);
    db.exec(`ALTER TABLE tags ADD COLUMN server_updated_at INTEGER`);

    // transcription_sessions table
    db.exec(`ALTER TABLE transcription_sessions ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0`);
    db.exec(
      `ALTER TABLE transcription_sessions ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 1`
    );
    db.exec(`ALTER TABLE transcription_sessions ADD COLUMN sync_checksum TEXT`);
    db.exec(`ALTER TABLE transcription_sessions ADD COLUMN server_updated_at INTEGER`);

    // ================================================================
    // 2. Restructure note_tags (SQLite can't alter PKs, so recreate)
    // ================================================================

    db.exec(`
      CREATE TABLE note_tags_new (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        user_profile_id TEXT NOT NULL DEFAULT '1',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        sync_version INTEGER NOT NULL DEFAULT 1,
        sync_checksum TEXT,
        server_updated_at INTEGER,
        UNIQUE(note_id, tag_id)
      )
    `);

    // Migrate existing data — generate UUID v4 for id, set updated_at = created_at
    db.exec(`
      INSERT INTO note_tags_new (id, note_id, tag_id, user_profile_id, created_at, updated_at, deleted)
        SELECT
          lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
            substr(hex(randomblob(2)),2) || '-' ||
            substr('89ab', abs(random()) % 4 + 1, 1) ||
            substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),
          note_id, tag_id, '1', created_at, created_at, deleted
        FROM note_tags
    `);

    db.exec(`DROP TABLE note_tags`);
    db.exec(`ALTER TABLE note_tags_new RENAME TO note_tags`);

    // ================================================================
    // 3. Restructure transcription_segments
    // ================================================================

    db.exec(`
      CREATE TABLE transcription_segments_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES transcription_sessions(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL,
        text TEXT NOT NULL,
        start_time_seconds REAL NOT NULL DEFAULT 0,
        end_time_seconds REAL NOT NULL DEFAULT 0,
        sequence_order INTEGER NOT NULL DEFAULT 0,
        user_edited INTEGER NOT NULL DEFAULT 0,
        original_text TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        sync_version INTEGER NOT NULL DEFAULT 1,
        sync_checksum TEXT,
        server_updated_at INTEGER,
        UNIQUE(session_id, segment_id)
      )
    `);

    // Migrate: convert ms → seconds, map segment_index → sequence_order, generate segment_id
    db.exec(`
      INSERT INTO transcription_segments_new
        (id, session_id, segment_id, text, start_time_seconds, end_time_seconds, sequence_order, created_at, updated_at)
        SELECT
          id,
          session_id,
          'seg-' || segment_index,
          text,
          CAST(start_time_ms AS REAL) / 1000.0,
          CAST(end_time_ms AS REAL) / 1000.0,
          segment_index,
          created_at,
          created_at
        FROM transcription_segments
    `);

    db.exec(`DROP TABLE transcription_segments`);
    db.exec(`ALTER TABLE transcription_segments_new RENAME TO transcription_segments`);

    // ================================================================
    // 4. Restructure summaries
    // ================================================================

    db.exec(`
      CREATE TABLE summaries_new (
        id TEXT PRIMARY KEY,
        transcription_id TEXT NOT NULL,
        summary_text TEXT,
        summary_text_encrypted TEXT,
        is_summary_encrypted INTEGER NOT NULL DEFAULT 0,
        summary_type TEXT NOT NULL DEFAULT 'full',
        processing_time_ms INTEGER,
        model_used TEXT,
        backend_type TEXT,
        pipeline_used INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        sync_version INTEGER NOT NULL DEFAULT 1,
        checksum TEXT,
        server_updated_at INTEGER
      )
    `);

    // Migrate: map old column names to new
    db.exec(`
      INSERT INTO summaries_new
        (id, transcription_id, summary_text, summary_type, model_used, created_at, updated_at, deleted)
        SELECT
          id,
          COALESCE(transcription_session_id, ''),
          content,
          summary_type,
          model,
          created_at,
          updated_at,
          deleted
        FROM summaries
    `);

    db.exec(`DROP TABLE summaries`);
    db.exec(`ALTER TABLE summaries_new RENAME TO summaries`);

    // ================================================================
    // 5. Create indexes
    // ================================================================

    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(starred) WHERE starred = 1`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived) WHERE archived = 1`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_notes_sync_version ON notes(sync_version, server_updated_at)`
    );

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_binders_sync_version ON binders(sync_version, server_updated_at)`
    );

    db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_sort ON tags(user_profile_id, sort_index)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_sync ON tags(sync_version, server_updated_at)`);

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_trans_sessions_deleted ON transcription_sessions(deleted) WHERE deleted = 0`
    );

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_trans_segments_session ON transcription_segments(session_id, sequence_order)`
    );
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_trans_segments_unique ON transcription_segments(session_id, segment_id)`
    );

    db.exec(`CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_note_tags_sync ON note_tags(sync_version, server_updated_at)`
    );

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_summaries_transcription ON summaries(transcription_id)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_summaries_sync ON summaries(sync_version, server_updated_at)`
    );
  },
};
