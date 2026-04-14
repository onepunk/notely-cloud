-- Notely Desktop - Baseline Schema
-- Standalone/Offline-Only Application
-- Version: 2

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = memory;

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Binders table
CREATE TABLE IF NOT EXISTS binders (
  id TEXT PRIMARY KEY,
  user_profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_index INTEGER NOT NULL DEFAULT 0,
  color TEXT,
  icon TEXT,
  is_team_shared INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  binder_type TEXT NOT NULL DEFAULT 'USER' CHECK (binder_type IN ('USER', 'SYSTEM')),
  is_conflicts INTEGER NOT NULL DEFAULT 0,
  sync_version INTEGER DEFAULT 1,
  sync_checksum TEXT,
  server_updated_at INTEGER
);

-- Notes table
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  binder_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  is_conflict INTEGER NOT NULL DEFAULT 0,
  conflict_of_id TEXT,
  conflict_created_at INTEGER,
  starred INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  sync_version INTEGER DEFAULT 1,
  sync_checksum TEXT,
  server_updated_at INTEGER,
  FOREIGN KEY (binder_id) REFERENCES binders(id) ON UPDATE CASCADE
);

-- Note content tracking
CREATE TABLE IF NOT EXISTS note_content_head (
  note_id TEXT PRIMARY KEY,
  revision_id INTEGER NOT NULL
);

-- Note revisions
CREATE TABLE IF NOT EXISTS note_revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  lexical_json TEXT NOT NULL,
  plaintext TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Transcription sessions
CREATE TABLE IF NOT EXISTS transcription_sessions (
  id TEXT PRIMARY KEY,
  binder_id TEXT NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('recording','completing','completed')),
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  duration_ms INTEGER,
  char_count INTEGER DEFAULT 0,
  word_count INTEGER DEFAULT 0,
  full_text TEXT NOT NULL DEFAULT '',
  original_text TEXT,
  user_edited INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  sync_version INTEGER NOT NULL DEFAULT 1,
  sync_checksum TEXT,
  server_updated_at INTEGER
);

-- Transcription segments
CREATE TABLE IF NOT EXISTS transcription_segments (
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
);

-- Audio recordings (local-only)
CREATE TABLE IF NOT EXISTS audio_recordings (
  id TEXT PRIMARY KEY,
  transcription_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size_bytes INTEGER,
  duration_ms INTEGER,
  mime_type TEXT DEFAULT 'audio/webm',
  created_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (transcription_id) REFERENCES transcription_sessions(id) ON DELETE CASCADE
);

-- Summaries table
CREATE TABLE IF NOT EXISTS summaries (
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
);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  user_profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER NOT NULL DEFAULT 0,
  sync_version INTEGER NOT NULL DEFAULT 1,
  sync_checksum TEXT,
  server_updated_at INTEGER,
  UNIQUE(user_profile_id, name)
);

-- Note-Tag junction table
CREATE TABLE IF NOT EXISTS note_tags (
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
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- User profiles table
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  server_user_id TEXT,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  avatar_path TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Calendar events cache (external calendar integration, not Notely sync)
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
);

-- Calendar sync ranges (tracks which date ranges have been fetched)
CREATE TABLE IF NOT EXISTS calendar_event_sync_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  synced_at INTEGER NOT NULL,
  UNIQUE(account_id, range_start, range_end)
);

-- ============================================================================
-- FULL-TEXT SEARCH TABLES
-- ============================================================================

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  content
);

CREATE VIRTUAL TABLE IF NOT EXISTS transcriptions_fts USING fts5(
  session_id UNINDEXED,
  content
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Binder indexes
CREATE INDEX IF NOT EXISTS idx_binders_sort ON binders(deleted, sort_index, created_at);
CREATE INDEX IF NOT EXISTS idx_binders_type ON binders(binder_type);
CREATE INDEX IF NOT EXISTS idx_binders_user_type ON binders(user_profile_id, binder_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_binders_conflicts_unique ON binders(user_profile_id) WHERE is_conflicts = 1 AND deleted = 0;
CREATE INDEX IF NOT EXISTS idx_binders_sync_version ON binders(sync_version, server_updated_at);

-- Note indexes
CREATE INDEX IF NOT EXISTS idx_notes_by_binder ON notes(binder_id, deleted, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_conflicts ON notes(is_conflict) WHERE is_conflict = 1;
CREATE INDEX IF NOT EXISTS idx_notes_conflict_of ON notes(conflict_of_id) WHERE conflict_of_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(starred) WHERE starred = 1;
CREATE INDEX IF NOT EXISTS idx_notes_archived ON notes(archived) WHERE archived = 1;
CREATE INDEX IF NOT EXISTS idx_notes_sync_version ON notes(sync_version, server_updated_at);

-- Revision indexes
CREATE INDEX IF NOT EXISTS idx_revisions_note ON note_revisions(note_id, created_at DESC);

-- Transcription indexes
CREATE INDEX IF NOT EXISTS idx_trans_sessions_note ON transcription_sessions(note_id);
CREATE INDEX IF NOT EXISTS idx_trans_sessions_binder ON transcription_sessions(binder_id);
CREATE INDEX IF NOT EXISTS idx_trans_sessions_status ON transcription_sessions(status);
CREATE INDEX IF NOT EXISTS idx_transcription_sessions_edited ON transcription_sessions(user_edited) WHERE user_edited = 1;
CREATE INDEX IF NOT EXISTS idx_trans_sessions_deleted ON transcription_sessions(deleted) WHERE deleted = 0;

-- Transcription segment indexes
CREATE INDEX IF NOT EXISTS idx_trans_segments_session ON transcription_segments(session_id, sequence_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trans_segments_unique ON transcription_segments(session_id, segment_id);

-- Audio recording indexes
CREATE INDEX IF NOT EXISTS idx_audio_recordings_transcription ON audio_recordings(transcription_id);
CREATE INDEX IF NOT EXISTS idx_audio_recordings_deleted ON audio_recordings(deleted) WHERE deleted = 0;

-- Summary indexes
CREATE INDEX IF NOT EXISTS idx_summaries_transcription ON summaries(transcription_id);
CREATE INDEX IF NOT EXISTS idx_summaries_sync ON summaries(sync_version, server_updated_at);

-- Tag indexes
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_profile_id, deleted);
CREATE INDEX IF NOT EXISTS idx_tags_sort ON tags(user_profile_id, sort_index);
CREATE INDEX IF NOT EXISTS idx_tags_sync ON tags(sync_version, server_updated_at);

-- Note-tag indexes
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_note_tags_sync ON note_tags(sync_version, server_updated_at);

-- User profile indexes
CREATE INDEX IF NOT EXISTS idx_user_profiles_active ON user_profiles(is_active) WHERE is_active = 1;

-- Calendar event indexes
CREATE INDEX IF NOT EXISTS idx_calendar_events_account ON calendar_events(account_id);
CREATE INDEX IF NOT EXISTS idx_calendar_events_time ON calendar_events(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_ranges_account ON calendar_event_sync_ranges(account_id);

-- ============================================================================
-- INITIAL DATA SEEDING
-- ============================================================================

-- Record baseline schema version for migration runner compatibility
INSERT OR REPLACE INTO settings(key, value) VALUES('schema_version', '2');
