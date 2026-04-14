/**
 * Database row types - Direct mappings to SQLite table schemas
 */

export type BinderRow = {
  id: string;
  user_profile_id: string | null;
  name: string;
  sort_index: number;
  color: string | null;
  icon: string | null;
  is_team_shared: number;
  remote_id: string | null;
  created_at: number;
  updated_at: number;
  deleted: number;
  binder_type: string; // 'USER' | 'SYSTEM' (added in migration 8)
  // Sync metadata (added in migration 5)
  sync_version?: number;
  sync_checksum?: string | null;
  server_updated_at?: number | null;
};

export type NoteMetaRow = {
  id: string;
  binder_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  pinned: number;
  starred: number; // Added in migration 019 (required, defaults to 0)
  archived: number; // Added in migration 020 (required, defaults to 0)
  // Sync metadata (added in migration 5)
  sync_version?: number;
  sync_checksum?: string | null;
  server_updated_at?: number | null;
};

export type NoteContentRow = {
  lexical_json: string;
  plaintext: string;
};

export type NoteRevisionRow = {
  revision_id: number;
  note_id: string;
  lexical_json: string;
  plaintext: string;
  hash: string;
  created_at: number;
  // Sync metadata (added in migration 5)
  sync_version?: number;
  server_updated_at?: number | null;
};

export type NoteContentHeadRow = {
  note_id: string;
  revision_id: number;
};

export type SettingsRow = {
  key: string;
  value: string;
};

export type UserProfileRow = {
  id: number; // Always 1
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar_path: string | null;
  updated_at: number;
};

export type TranscriptionSessionRow = {
  id: string;
  binder_id: string;
  note_id: string;
  language: string;
  status: 'recording' | 'completing' | 'completed';
  start_time: number;
  end_time: number | null;
  duration_ms: number | null;
  char_count: number;
  word_count: number;
  full_text: string;
  created_at: number;
  updated_at: number;
  deleted: number; // Added in migration 013
  // Sync metadata (added in migration 5)
  sync_version?: number;
  sync_checksum?: string | null;
  server_updated_at?: number | null;
};

/**
 * Row type for transcription_segments table
 * Added in migration 023
 * Stores individual segments with timestamps for user edit tracking
 */
export type TranscriptionSegmentRow = {
  id: string;
  session_id: string;
  segment_id: string;
  text: string;
  start_time_seconds: number;
  end_time_seconds: number;
  sequence_order: number;
  user_edited: number;
  original_text: string | null;
  created_at: number;
  updated_at: number;
  deleted: number;
  // Sync metadata
  sync_version?: number;
  sync_checksum?: string | null;
  server_updated_at?: number | null;
};

export type NoteFtsRow = {
  note_id: string;
  title: string;
  content: string;
};

export type SummaryRow = {
  id: string;
  transcription_id: string;
  summary_text: string | null;
  summary_text_encrypted: string | null;
  is_summary_encrypted: number;
  summary_type: string;
  processing_time_ms: number | null;
  model_used: string | null;
  backend_type: string | null;
  pipeline_used: number;
  sync_version: number;
  checksum: string | null;
  deleted: number;
  created_at: number;
  updated_at: number;
  server_updated_at: number | null;
};

export type TranscriptionFtsRow = {
  session_id: string;
  content: string;
};

export type AudioRecordingRow = {
  id: string;
  transcription_id: string;
  file_name: string;
  file_path: string;
  file_size_bytes: number | null;
  duration_ms: number | null;
  mime_type: string;
  created_at: number;
  deleted: number;
};
