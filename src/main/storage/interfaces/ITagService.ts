/**
 * Tag service interface - Tag and NoteTag CRUD operations
 */

import type { NoteSummary } from '../types/entities';
import type { Tag, TagRow, NoteTagRow, CreateTagInput, UpdateTagInput } from '../types/tags';

export interface ITagService {
  // ============================================
  // CRUD Operations
  // ============================================

  /**
   * Create a new tag
   */
  create(input: CreateTagInput, userId?: string): Promise<string>;

  /**
   * List all tags for a user, ordered by sort_index
   */
  list(userId?: string): Promise<Tag[]>;

  /**
   * Get a single tag by ID
   */
  get(tagId: string): Promise<Tag | null>;

  /**
   * Update tag properties (name, color)
   */
  update(input: UpdateTagInput): Promise<void>;

  /**
   * Soft delete a tag (and all its note associations)
   */
  delete(tagId: string): Promise<void>;

  /**
   * Reorder tags by providing new order array
   */
  reorder(tagIds: string[]): Promise<void>;

  // ============================================
  // Note-Tag Associations
  // ============================================

  /**
   * Add a tag to a note (creates note_tag association)
   */
  addToNote(noteId: string, tagId: string): Promise<string>;

  /**
   * Remove a tag from a note (soft deletes note_tag association)
   */
  removeFromNote(noteId: string, tagId: string): Promise<void>;

  /**
   * Set all tags for a note (replaces existing tags)
   */
  setNoteTags(noteId: string, tagIds: string[]): Promise<void>;

  /**
   * Get all tags for a note
   */
  getTagsByNote(noteId: string): Promise<Tag[]>;

  /**
   * Get all notes with a specific tag
   */
  getNotesByTag(tagId: string): Promise<NoteSummary[]>;

  /**
   * Get count of notes with a specific tag
   */
  getNotesCountByTag(tagId: string): Promise<number>;

  // ============================================
  // Bulk Operations
  // ============================================

  /**
   * Get tags for multiple notes efficiently
   */
  getTagsForNotes(noteIds: string[]): Promise<Map<string, Tag[]>>;

  // ============================================
  // Sync Support - Tags
  // ============================================

  /**
   * Get all tags for sync operations
   */
  getAllTags(userId?: string): Promise<TagRow[]>;

  /**
   * Get tag by ID (raw row)
   */
  getTagById(tagId: string): Promise<TagRow | null>;

  /**
   * Create tag with specific ID
   */
  createTagWithId(tag: Partial<TagRow>): Promise<void>;

  /**
   * Update tag data
   */
  updateTagFromSync(tag: Partial<TagRow>): Promise<void>;

  /**
   * Soft delete a tag
   */
  softDeleteTag(tagId: string): Promise<void>;

  // ============================================
  // NoteTags Support
  // ============================================

  /**
   * Get all note_tags
   */
  getAllNoteTags(userId?: string): Promise<NoteTagRow[]>;

  /**
   * Get note_tag by ID (raw row)
   */
  getNoteTagById(noteTagId: string): Promise<NoteTagRow | null>;

  /**
   * Create note_tag with specific ID
   */
  createNoteTagWithId(noteTag: Partial<NoteTagRow>): Promise<void>;

  /**
   * Update note_tag data
   */
  updateNoteTagFromSync(noteTag: Partial<NoteTagRow>): Promise<void>;

  /**
   * Soft delete a note_tag
   */
  softDeleteNoteTag(noteTagId: string): Promise<void>;
}
