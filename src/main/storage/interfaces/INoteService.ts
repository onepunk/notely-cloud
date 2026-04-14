/**
 * Note service interface - Note and revision management
 */

import type { NoteFull, NoteSummary, SaveNoteInput, NoteRevision } from '../types/entities';

export interface INoteService {
  /**
   * Create a new empty note in a binder
   */
  create(binderId: string): Promise<string>;

  /**
   * Create a new note with a specific ID (for sync operations)
   * This method is primarily used by the sync engine to create notes
   * with IDs that match the server records
   */
  createWithId(
    id: string,
    binderId: string,
    title: string,
    content?: string,
    createdAt?: number,
    updatedAt?: number,
    pinned?: boolean
  ): Promise<void>;

  /**
   * Get full note data (metadata + content)
   */
  get(noteId: string): Promise<NoteFull>;

  /**
   * Save note content and optionally update title
   */
  save(input: SaveNoteInput): Promise<boolean>;

  /**
   * Soft delete a note
   */
  delete(noteId: string): Promise<void>;

  /**
   * Move note to different binder
   */
  move(noteId: string, binderId: string): Promise<void>;

  /**
   * List notes in a binder (summary view)
   */
  listByBinder(binderId: string): Promise<NoteSummary[]>;

  /**
   * List all non-deleted notes regardless of binder
   */
  listAll(): Promise<NoteSummary[]>;

  /**
   * List non-deleted notes created within the provided range (inclusive)
   */
  listByCreatedBetween(start: number, end: number): Promise<NoteSummary[]>;

  /**
   * List notes that are currently in the trash (soft deleted)
   */
  listDeleted(): Promise<NoteSummary[]>;

  /**
   * Permanently delete all notes that are currently in the trash
   */
  emptyTrash(): Promise<number>;

  /**
   * Get note revision history
   */
  getRevisions(noteId: string, limit?: number): Promise<NoteRevision[]>;

  /**
   * Get specific revision content
   */
  getRevision(revisionId: number): Promise<{ lexicalJson: string; plainText: string } | null>;

  /**
   * Check if note exists and is not deleted
   */
  exists(noteId: string): Promise<boolean>;

  /**
   * Pin or unpin a note
   */
  setPinned(noteId: string, pinned: boolean): Promise<void>;

  /**
   * Star or unstar a note
   */
  setStarred(noteId: string, starred: boolean): Promise<void>;

  /**
   * List all starred notes
   */
  listStarred(): Promise<NoteSummary[]>;

  /**
   * Archive or unarchive a note
   */
  setArchived(noteId: string, archived: boolean): Promise<void>;

  /**
   * List all archived notes
   */
  listArchived(): Promise<NoteSummary[]>;

  /**
   * Get note count for a binder
   */
  getCountByBinder(binderId: string): Promise<number>;

  /**
   * Get multiple notes by their IDs
   * Returns note summaries for efficiency
   */
  getByIds(ids: string[]): Promise<NoteSummary[]>;

  /**
   * Get all notes for sync operations
   * Used by Merkle tree sync to enumerate all notes for hash computation
   * Returns note metadata (not content) for efficient hashing
   */
  getAllNotes(): Promise<import('../types/database').NoteMetaRow[]>;

  // ============================================
  // Conflict Management Methods (Phase 5)
  // ============================================

  /**
   * List all conflict copy notes
   */
  listConflicts(): Promise<NoteSummary[]>;

  /**
   * Get conflict copies for a specific canonical note
   */
  getConflictsForNote(canonicalNoteId: string): Promise<NoteSummary[]>;

  /**
   * Count total conflict copies
   */
  countConflicts(): Promise<number>;

  /**
   * Check if a canonical note has any conflict copies
   */
  hasConflicts(canonicalNoteId: string): Promise<boolean>;

  /**
   * Get canonical note IDs that have conflicts
   */
  getNotesWithConflicts(): Promise<string[]>;

  /**
   * Create a conflict copy note
   */
  createConflictCopy(
    canonicalNoteId: string,
    losingContent: string,
    losingTitle: string,
    conflictBinderId: string,
    sourceType?: string
  ): Promise<string>;

  /**
   * Resolve a conflict by replacing the canonical note with conflict copy content
   */
  resolveConflictUseConflictVersion(conflictNoteId: string, canonicalNoteId: string): Promise<void>;

  /**
   * Resolve a conflict by deleting the conflict copy (keep canonical)
   */
  resolveConflictKeepCanonical(conflictNoteId: string): Promise<void>;

  /**
   * Get full content of a note including conflict metadata
   */
  getWithConflictMeta(noteId: string): Promise<{
    meta: import('../types/entities').NoteMeta & {
      isConflict: boolean;
      conflictOfId: string | null;
      conflictCreatedAt: number | null;
    };
    content: import('../types/entities').NoteContent;
    conflictCopies: NoteSummary[];
  }>;
}
