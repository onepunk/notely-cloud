/**
 * Tag-related type definitions
 * Database row types and domain entities for tags and note-tag associations
 */

// ============================================
// Database row types (snake_case, matches SQL)
// ============================================

/**
 * Database row type for tags table
 * Added in migration 026
 */
export type TagRow = {
  id: string;
  user_profile_id: string;
  name: string;
  color: string | null;
  sort_index: number;
  created_at: number;
  updated_at: number;
  deleted: number;
  sync_version: number;
  sync_checksum: string | null;
  server_updated_at: number | null;
};

/**
 * Database row type for note_tags junction table
 * Added in migration 026
 */
export type NoteTagRow = {
  id: string;
  note_id: string;
  tag_id: string;
  user_profile_id: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  sync_version: number;
  sync_checksum: string | null;
  server_updated_at: number | null;
};

// ============================================
// Domain entity types (camelCase, for application layer)
// ============================================

/**
 * Domain entity for a tag
 */
export type Tag = {
  id: string;
  userId: string | null;
  name: string;
  color: string | null;
  sortIndex: number;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
  noteCount?: number;
};

/**
 * Domain entity for a note-tag association
 */
export type NoteTag = {
  id: string;
  noteId: string;
  tagId: string;
  userId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
};

// ============================================
// Input types for operations
// ============================================

/**
 * Input for creating a new tag
 */
export type CreateTagInput = {
  name: string;
  color?: string;
};

/**
 * Input for updating an existing tag
 */
export type UpdateTagInput = {
  id: string;
  name?: string;
  color?: string | null;
};
