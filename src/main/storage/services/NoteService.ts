import crypto from 'crypto';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { INoteService } from '../interfaces/INoteService';
import type { ISearchService } from '../interfaces/ISearchService';
import { NoteMetaRow, NoteRevisionRow } from '../types/database';
import {
  NoteFull,
  NoteSummary,
  SaveNoteInput,
  NoteRevision,
  NoteMeta,
  NoteContent,
} from '../types/entities';

import type { SyncItemsService } from './SyncItemsService';

/**
 * NoteService - Note and revision management
 */
export class NoteService implements INoteService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager,
    private searchService: ISearchService,
    private syncItems?: SyncItemsService
  ) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  private mapRowToSummary(row: {
    id: string;
    binder_id: string;
    title: string;
    created_at: number;
    updated_at: number;
    deleted: number;
    pinned: number;
    starred?: number;
    archived?: number;
  }): NoteSummary {
    return {
      id: row.id,
      binder_id: row.binder_id,
      title: row.title,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted: row.deleted,
      pinned: row.pinned,
      starred: row.starred,
      archived: row.archived,
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Create a new empty note in a binder
   */
  async create(binderId: string): Promise<string> {
    const id = crypto.randomUUID();

    const noteId = await this.transactionManager.execute(() => {
      const now = Date.now();
      const title = '';

      // Insert the note
      this.db
        .prepare('INSERT INTO notes(id,binder_id,title,created_at,updated_at) VALUES (?,?,?,?,?)')
        .run(id, binderId, title, now, now);

      // Create initial empty revision
      const hash = crypto.createHash('sha256').update('null').digest('hex');
      const revisionInfo = this.db
        .prepare(
          'INSERT INTO note_revisions(note_id,lexical_json,plaintext,hash,created_at) VALUES (?,?,?,?,?)'
        )
        .run(id, 'null', '', hash, now);

      const revisionId = Number(revisionInfo.lastInsertRowid);

      // Point head to the initial revision
      this.db
        .prepare('INSERT INTO note_content_head(note_id,revision_id) VALUES (?,?)')
        .run(id, revisionId);

      return id;
    });

    this.syncItems?.markDirty('notes', noteId);
    return noteId;
  }

  /**
   * Create a new note with a specific ID (for sync operations)
   * This method is primarily used by the sync engine to create notes
   * with IDs that match the server records
   */
  async createWithId(
    id: string,
    binderId: string,
    title: string,
    content: string = 'null',
    createdAt?: number,
    updatedAt?: number,
    pinned: boolean = false,
    starred: boolean = false,
    archived: boolean = false
  ): Promise<void> {
    // Extract plain text from content (simplified - in reality might need better parsing)
    // Must be declared outside transaction to be available for FTS indexing
    let plainText = '';
    try {
      if (content && content !== 'null') {
        const _parsed = JSON.parse(content);
        // This is a simplified extraction - real implementation would need proper Lexical parsing
        plainText = content;
      }
    } catch {
      plainText = title; // Fallback to title if content parsing fails
    }

    await this.transactionManager.execute(() => {
      const now = Date.now();
      const finalCreatedAt = createdAt || now;
      const finalUpdatedAt = updatedAt || now;

      // Insert the note with specific ID or update if exists
      // Use INSERT ... ON CONFLICT to avoid DELETE CASCADE issues
      this.db
        .prepare(
          `INSERT INTO notes(id,binder_id,title,created_at,updated_at,deleted,pinned,starred,archived,server_updated_at)
           VALUES (?,?,?,?,?,0,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             binder_id=excluded.binder_id,
             title=excluded.title,
             updated_at=excluded.updated_at,
             pinned=excluded.pinned,
             starred=excluded.starred,
             archived=excluded.archived,
             server_updated_at=excluded.server_updated_at`
        )
        .run(
          id,
          binderId,
          title,
          finalCreatedAt,
          finalUpdatedAt,
          pinned ? 1 : 0,
          starred ? 1 : 0,
          archived ? 1 : 0,
          now
        );

      // Create initial revision with provided content
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      const revisionInfo = this.db
        .prepare(
          'INSERT INTO note_revisions(note_id,lexical_json,plaintext,hash,created_at) VALUES (?,?,?,?,?)'
        )
        .run(id, content, plainText, hash, finalCreatedAt);

      const revisionId = Number(revisionInfo.lastInsertRowid);

      // Point head to the initial revision
      this.db
        .prepare('INSERT OR REPLACE INTO note_content_head(note_id,revision_id) VALUES (?,?)')
        .run(id, revisionId);
    });

    // Update FTS index via SearchService (same as in save() method)
    this.searchService.indexNote(id, title, plainText).catch(() => {
      /* non-fatal */
    });
  }

  /**
   * Get full note data (metadata + content)
   */
  async get(noteId: string): Promise<NoteFull> {
    // Get note metadata
    const metaStmt = this.db.prepare('SELECT * FROM notes WHERE id=?');
    const metaRow = metaStmt.get(noteId) as NoteMetaRow | undefined;

    if (!metaRow) {
      throw new Error(`Note with ID ${noteId} not found`);
    }

    // Get current content
    const contentStmt = this.db.prepare(`
      SELECT r.lexical_json, r.plaintext 
      FROM note_content_head h
      JOIN note_revisions r ON r.revision_id = h.revision_id 
      WHERE h.note_id = ?
    `);
    const contentRow = contentStmt.get(noteId) as
      | { lexical_json: string; plaintext: string }
      | undefined;

    if (!contentRow) {
      throw new Error(`Content for note ${noteId} not found`);
    }

    const meta: NoteMeta = {
      id: metaRow.id,
      binderId: metaRow.binder_id,
      title: metaRow.title,
      createdAt: new Date(metaRow.created_at),
      updatedAt: new Date(metaRow.updated_at),
      deleted: metaRow.deleted === 1,
      pinned: metaRow.pinned === 1,
      starred: metaRow.starred === 1, // Return starred from database
      archived: metaRow.archived === 1, // Return archived from database
    };

    const content: NoteContent = {
      lexicalJson: contentRow.lexical_json,
      plainText: contentRow.plaintext,
    };

    return { meta, content };
  }

  /**
   * Save note content and optionally update title
   */
  async save(input: SaveNoteInput): Promise<boolean> {
    const { noteId, lexicalJson, plainText, title } = input;
    let didChange = false;

    await this.transactionManager.execute(() => {
      const now = Date.now();

      const currentMetaRow = this.db.prepare('SELECT title FROM notes WHERE id=?').get(noteId) as
        | { title: string }
        | undefined;

      if (!currentMetaRow) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      const titleChanged = title !== undefined && title !== currentMetaRow.title;

      // Handle title-only update (lexicalJson === 'null')
      if (lexicalJson === 'null') {
        // Avoid spurious sync if title didn't actually change
        if (!titleChanged) {
          return;
        }

        // Update note metadata
        this.db
          .prepare('UPDATE notes SET title=?, updated_at=? WHERE id=?')
          .run(title, now, noteId);

        // Re-index search with new title and existing content
        if (title !== undefined) {
          const currentContent = this.db
            .prepare(
              `
              SELECT r.plaintext
              FROM note_content_head h
              JOIN note_revisions r ON r.revision_id = h.revision_id
              WHERE h.note_id = ?
            `
            )
            .get(noteId) as { plaintext: string } | undefined;

          this.searchService.indexNote(noteId, title, currentContent?.plaintext ?? '').catch(() => {
            /* non-fatal */
          });
        }

        didChange = true;
        return;
      }

      const hash = crypto.createHash('sha256').update(lexicalJson).digest('hex');

      // Check if content has changed by comparing hashes
      const lastHashRow = this.db
        .prepare(
          `
        SELECT r.hash
        FROM note_content_head h
        JOIN note_revisions r ON r.revision_id = h.revision_id
        WHERE h.note_id = ?
      `
        )
        .get(noteId) as { hash: string } | undefined;

      const contentChanged = !lastHashRow || lastHashRow.hash !== hash;

      if (!titleChanged && !contentChanged) {
        return;
      }

      // Update note metadata (only if something changed)
      if (titleChanged) {
        this.db
          .prepare('UPDATE notes SET title=?, updated_at=? WHERE id=?')
          .run(title, now, noteId);
      } else {
        this.db.prepare('UPDATE notes SET updated_at=? WHERE id=?').run(now, noteId);
      }

      // Only create new revision if content has changed
      if (contentChanged) {
        // Insert new revision
        const revisionInfo = this.db
          .prepare(
            'INSERT INTO note_revisions(note_id,lexical_json,plaintext,hash,created_at) VALUES (?,?,?,?,?)'
          )
          .run(noteId, lexicalJson, plainText, hash, now);

        const revisionId = Number(revisionInfo.lastInsertRowid);

        // Update head pointer
        this.db
          .prepare(
            'INSERT INTO note_content_head(note_id,revision_id) VALUES (?,?) ON CONFLICT(note_id) DO UPDATE SET revision_id=excluded.revision_id'
          )
          .run(noteId, revisionId);

        // Clean up old revisions (keep only latest 20)
        this.db
          .prepare(
            `
          DELETE FROM note_revisions
          WHERE note_id=? AND revision_id NOT IN (
            SELECT revision_id FROM note_revisions
            WHERE note_id=?
            ORDER BY revision_id DESC
            LIMIT 20
          )
        `
          )
          .run(noteId, noteId);
      }

      // Update FTS index if title or content changed
      const currentContent = this.db
        .prepare(
          `
          SELECT r.plaintext
          FROM note_content_head h
          JOIN note_revisions r ON r.revision_id = h.revision_id
          WHERE h.note_id = ?
        `
        )
        .get(noteId) as { plaintext: string } | undefined;

      const titleForIndex = titleChanged ? title : currentMetaRow.title;
      const plaintextForIndex = contentChanged
        ? plainText
        : (currentContent?.plaintext ?? plainText);

      this.searchService
        .indexNote(noteId, titleForIndex ?? '', plaintextForIndex ?? '')
        .catch(() => {
          /* non-fatal */
        });

      didChange = true;
    });

    if (didChange) {
      this.syncItems?.markDirty('notes', noteId);
    }
    return didChange;
  }

  /**
   * Soft delete a note
   */
  async delete(noteId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      const now = Date.now();

      // Soft delete the note
      const result = this.db
        .prepare('UPDATE notes SET deleted=1, updated_at=? WHERE id=?')
        .run(now, noteId);

      if (result.changes === 0) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      // Remove from FTS index via SearchService
      this.searchService.removeNoteFromIndex(noteId).catch(() => {
        /* non-fatal */
      });
    });

    this.syncItems?.markDirty('notes', noteId);
  }

  /**
   * Move note to different binder
   */
  async move(noteId: string, binderId: string): Promise<void> {
    let didChange = false;

    await this.transactionManager.execute(() => {
      const current = this.db.prepare('SELECT binder_id FROM notes WHERE id=?').get(noteId) as
        | { binder_id: string }
        | undefined;

      if (!current) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      if (current.binder_id === binderId) {
        return;
      }

      const now = Date.now();
      const result = this.db
        .prepare('UPDATE notes SET binder_id=?, updated_at=? WHERE id=?')
        .run(binderId, now, noteId);

      if (result.changes === 0) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      didChange = true;
    });

    if (didChange) {
      this.syncItems?.markDirty('notes', noteId);
    }
  }

  /**
   * List notes in a binder (summary view)
   * Excludes conflict copies - they are only shown in the Conflicts binder via listConflicts()
   */
  async listByBinder(binderId: string): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived
       FROM notes
       WHERE binder_id=? AND deleted=0 AND archived=0 AND is_conflict=0
       ORDER BY pinned DESC, updated_at DESC`
    );

    const rows = stmt.all(binderId) as Array<{
      id: string;
      binder_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      pinned: number;
      starred?: number;
      archived?: number;
    }>;

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * List all non-deleted notes
   * Excludes conflict copies - they are only shown in the Conflicts binder via listConflicts()
   */
  async listAll(): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived
       FROM notes
       WHERE deleted=0 AND archived=0 AND is_conflict=0
       ORDER BY pinned DESC, updated_at DESC`
    );

    const rows = stmt.all() as Array<{
      id: string;
      binder_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      pinned: number;
      starred?: number;
      archived?: number;
    }>;

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * List non-deleted notes created within a range
   * Excludes conflict copies - they are only shown in the Conflicts binder via listConflicts()
   */
  async listByCreatedBetween(start: number, end: number): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived
       FROM notes
       WHERE deleted=0 AND archived=0 AND is_conflict=0 AND created_at BETWEEN ? AND ?
       ORDER BY pinned DESC, updated_at DESC`
    );

    const rows = stmt.all(start, end) as Array<{
      id: string;
      binder_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      pinned: number;
      starred?: number;
      archived?: number;
    }>;

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * List notes that are soft deleted (trash)
   */
  async listDeleted(): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived
       FROM notes
       WHERE deleted=1
       ORDER BY updated_at DESC`
    );

    const rows = stmt.all() as Array<{
      id: string;
      binder_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      pinned: number;
      starred?: number;
      archived?: number;
    }>;

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Permanently remove soft-deleted notes.
   * Only removes notes whose soft-deletion has already been synced to the server
   * (sync_time != 0 in sync_items). Unsynced deletions are left in place so the
   * sync engine can still push them.
   */
  async emptyTrash(): Promise<number> {
    const { ids, count } = await this.transactionManager.execute(() => {
      // Only permanently delete notes whose soft-deletion has already been synced.
      // Notes with pending sync (sync_time = 0) or no sync_items entry yet are kept
      // so the sync engine can push the deletion to the server first.
      const rows = this.db
        .prepare(
          `SELECT n.id FROM notes n
           LEFT JOIN sync_items si ON si.entity_type = 'notes' AND si.entity_id = n.id
           WHERE n.deleted = 1
             AND (si.sync_time IS NOT NULL AND si.sync_time != 0)`
        )
        .all() as Array<{ id: string }>;

      if (rows.length === 0) {
        return { ids: [] as string[], count: 0 };
      }

      const idList = rows.map((r) => r.id);
      const placeholders = idList.map(() => '?').join(',');

      // Clear dependent tables before removing notes
      this.db
        .prepare(`DELETE FROM note_content_head WHERE note_id IN (${placeholders})`)
        .run(...idList);
      this.db
        .prepare(`DELETE FROM note_revisions WHERE note_id IN (${placeholders})`)
        .run(...idList);

      const deleteResult = this.db
        .prepare(`DELETE FROM notes WHERE id IN (${placeholders})`)
        .run(...idList);

      // Clean up sync_items entries for permanently deleted notes
      this.db
        .prepare(
          `DELETE FROM sync_items WHERE entity_type = 'notes' AND entity_id IN (${placeholders})`
        )
        .run(...idList);

      return { ids: idList, count: deleteResult.changes ?? idList.length };
    });

    await Promise.allSettled(
      ids.map((id) =>
        this.searchService.removeNoteFromIndex(id).catch(() => {
          /* ignore */
        })
      )
    );

    return count;
  }

  /**
   * Get note revision history
   */
  async getRevisions(noteId: string, limit: number = 20): Promise<NoteRevision[]> {
    const stmt = this.db.prepare(`
      SELECT revision_id, note_id, lexical_json, plaintext, hash, created_at
      FROM note_revisions 
      WHERE note_id=? 
      ORDER BY revision_id DESC 
      LIMIT ?
    `);

    const rows = stmt.all(noteId, limit) as NoteRevisionRow[];

    return rows.map((row) => ({
      revisionId: row.revision_id,
      noteId: row.note_id,
      lexicalJson: row.lexical_json,
      plainText: row.plaintext,
      hash: row.hash,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Get specific revision content
   */
  async getRevision(
    revisionId: number
  ): Promise<{ lexicalJson: string; plainText: string } | null> {
    const stmt = this.db.prepare(
      'SELECT lexical_json, plaintext FROM note_revisions WHERE revision_id=?'
    );

    const row = stmt.get(revisionId) as { lexical_json: string; plaintext: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      lexicalJson: row.lexical_json,
      plainText: row.plaintext,
    };
  }

  /**
   * Check if note exists and is not deleted
   */
  async exists(noteId: string): Promise<boolean> {
    const stmt = this.db.prepare('SELECT 1 FROM notes WHERE id=? AND deleted=0 LIMIT 1');
    const row = stmt.get(noteId);
    return row !== undefined;
  }

  /**
   * Pin or unpin a note
   */
  async setPinned(noteId: string, pinned: boolean): Promise<void> {
    let didChange = false;

    await this.transactionManager.execute(() => {
      const current = this.db.prepare('SELECT pinned FROM notes WHERE id=?').get(noteId) as
        | { pinned: number }
        | undefined;

      if (!current) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      const nextPinned = pinned ? 1 : 0;
      if (current.pinned === nextPinned) {
        return;
      }

      const now = Date.now();
      const result = this.db
        .prepare('UPDATE notes SET pinned=?, updated_at=? WHERE id=?')
        .run(nextPinned, now, noteId);

      if (result.changes === 0) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      didChange = true;
    });

    if (didChange) {
      this.syncItems?.markDirty('notes', noteId);
    }
  }

  /**
   * Star or unstar a note
   */
  async setStarred(noteId: string, starred: boolean): Promise<void> {
    let didChange = false;

    await this.transactionManager.execute(() => {
      const current = this.db.prepare('SELECT starred FROM notes WHERE id=?').get(noteId) as
        | { starred: number }
        | undefined;

      if (!current) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      const nextStarred = starred ? 1 : 0;
      if (current.starred === nextStarred) {
        return;
      }

      const now = Date.now();
      const result = this.db
        .prepare('UPDATE notes SET starred=?, updated_at=? WHERE id=?')
        .run(nextStarred, now, noteId);

      if (result.changes === 0) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      didChange = true;
    });

    if (didChange) {
      this.syncItems?.markDirty('notes', noteId);
    }
  }

  /**
   * List starred notes
   * Excludes conflict copies - they are only shown in the Conflicts binder via listConflicts()
   */
  async listStarred(): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived
       FROM notes
       WHERE deleted=0 AND archived=0 AND starred=1 AND is_conflict=0
       ORDER BY updated_at DESC`
    );
    const rows = stmt.all() as NoteMetaRow[];
    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Archive or unarchive a note
   */
  async setArchived(noteId: string, archived: boolean): Promise<void> {
    let didChange = false;

    await this.transactionManager.execute(() => {
      const current = this.db.prepare('SELECT archived FROM notes WHERE id=?').get(noteId) as
        | { archived: number }
        | undefined;

      if (!current) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      const nextArchived = archived ? 1 : 0;
      if (current.archived === nextArchived) {
        return;
      }

      const now = Date.now();
      const result = this.db
        .prepare('UPDATE notes SET archived=?, updated_at=? WHERE id=?')
        .run(nextArchived, now, noteId);

      if (result.changes === 0) {
        throw new Error(`Note with ID ${noteId} not found`);
      }

      didChange = true;
    });

    if (didChange) {
      this.syncItems?.markDirty('notes', noteId);
    }
  }

  /**
   * List archived notes
   * Excludes conflict copies - they are only shown in the Conflicts binder via listConflicts()
   */
  async listArchived(): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived
       FROM notes
       WHERE deleted=0 AND archived=1 AND is_conflict=0
       ORDER BY updated_at DESC`
    );
    const rows = stmt.all() as NoteMetaRow[];
    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Get note count for a binder
   */
  async getCountByBinder(binderId: string): Promise<number> {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM notes WHERE binder_id=? AND deleted=0'
    );
    const row = stmt.get(binderId) as { count: number };
    return row.count;
  }

  /**
   * Get multiple notes by their IDs
   * Returns note summaries for efficiency
   */
  async getByIds(ids: string[]): Promise<NoteSummary[]> {
    if (ids.length === 0) {
      return [];
    }

    // Create placeholders for SQL IN clause
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT * FROM notes WHERE id IN (${placeholders}) AND deleted=0 ORDER BY updated_at DESC`
    );

    const rows = stmt.all(...ids) as NoteMetaRow[];
    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Get all notes for sync operations
   * Used by Merkle tree sync to enumerate all notes for hash computation
   * Returns note metadata (not content) for efficient hashing
   */
  async getAllNotes(): Promise<NoteMetaRow[]> {
    const stmt = this.db.prepare('SELECT * FROM notes WHERE deleted=0 ORDER BY id');
    return stmt.all() as NoteMetaRow[];
  }

  // ============================================
  // Conflict Management Methods (Phase 5)
  // ============================================

  /**
   * List all conflict copy notes
   * Returns notes where is_conflict=1, ordered by conflict_created_at DESC
   */
  async listConflicts(): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived,
              is_conflict, conflict_of_id, conflict_created_at
       FROM notes
       WHERE is_conflict = 1 AND deleted = 0
       ORDER BY conflict_created_at DESC`
    );

    const rows = stmt.all() as Array<{
      id: string;
      binder_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      pinned: number;
      starred?: number;
      archived?: number;
      is_conflict: number;
      conflict_of_id: string | null;
      conflict_created_at: number | null;
    }>;

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Get conflict copies for a specific canonical note
   * @param canonicalNoteId - The ID of the canonical (server-winning) note
   */
  async getConflictsForNote(canonicalNoteId: string): Promise<NoteSummary[]> {
    const stmt = this.db.prepare(
      `SELECT id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived,
              is_conflict, conflict_of_id, conflict_created_at
       FROM notes
       WHERE conflict_of_id = ? AND is_conflict = 1 AND deleted = 0
       ORDER BY conflict_created_at DESC`
    );

    const rows = stmt.all(canonicalNoteId) as Array<{
      id: string;
      binder_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      deleted: number;
      pinned: number;
      starred?: number;
      archived?: number;
      is_conflict: number;
      conflict_of_id: string | null;
      conflict_created_at: number | null;
    }>;

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Count total conflict copies
   */
  async countConflicts(): Promise<number> {
    const stmt = this.db.prepare(
      'SELECT COUNT(*) as count FROM notes WHERE is_conflict = 1 AND deleted = 0'
    );
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Check if a canonical note has any conflict copies
   * @param canonicalNoteId - The ID of the canonical note
   */
  async hasConflicts(canonicalNoteId: string): Promise<boolean> {
    const stmt = this.db.prepare(
      'SELECT 1 FROM notes WHERE conflict_of_id = ? AND is_conflict = 1 AND deleted = 0 LIMIT 1'
    );
    const row = stmt.get(canonicalNoteId);
    return row !== undefined;
  }

  /**
   * Get canonical note IDs that have conflicts
   * Used to show conflict indicators in the note list
   */
  async getNotesWithConflicts(): Promise<string[]> {
    const stmt = this.db.prepare(
      `SELECT DISTINCT conflict_of_id
       FROM notes
       WHERE is_conflict = 1 AND deleted = 0 AND conflict_of_id IS NOT NULL`
    );
    const rows = stmt.all() as Array<{ conflict_of_id: string }>;
    return rows.map((row) => row.conflict_of_id);
  }

  /**
   * Create a conflict copy note
   * Used by the sync engine when a conflict occurs
   * @param canonicalNoteId - The ID of the canonical (server-winning) note
   * @param losingContent - The content that lost the conflict
   * @param losingTitle - The title of the losing version
   * @param conflictBinderId - The ID of the Conflicts binder
   * @param sourceType - Optional: the type of entity that caused the conflict (note, transcription, summary)
   */
  async createConflictCopy(
    canonicalNoteId: string,
    losingContent: string,
    losingTitle: string,
    conflictBinderId: string,
    sourceType: string = 'note'
  ): Promise<string> {
    const id = crypto.randomUUID();

    const noteId = await this.transactionManager.execute(() => {
      const now = Date.now();

      // Create title with conflict indicator
      const conflictTitle =
        sourceType === 'note'
          ? `[Conflict] ${losingTitle || 'Untitled'}`
          : `[${sourceType.charAt(0).toUpperCase() + sourceType.slice(1)} Conflict] ${losingTitle || 'Untitled'}`;

      // Insert the conflict copy note
      this.db
        .prepare(
          `INSERT INTO notes(
            id, binder_id, title, created_at, updated_at, deleted, pinned, starred, archived,
            is_conflict, conflict_of_id, conflict_created_at
          ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 1, ?, ?)`
        )
        .run(id, conflictBinderId, conflictTitle, now, now, canonicalNoteId, now);

      // Create revision with losing content
      const hash = crypto
        .createHash('sha256')
        .update(losingContent || 'null')
        .digest('hex');
      const revisionInfo = this.db
        .prepare(
          'INSERT INTO note_revisions(note_id,lexical_json,plaintext,hash,created_at) VALUES (?,?,?,?,?)'
        )
        .run(id, losingContent || 'null', losingTitle || '', hash, now);

      const revisionId = Number(revisionInfo.lastInsertRowid);

      // Point head to the revision
      this.db
        .prepare('INSERT INTO note_content_head(note_id,revision_id) VALUES (?,?)')
        .run(id, revisionId);

      return id;
    });

    return noteId;
  }

  /**
   * Resolve a conflict by replacing the canonical note with conflict copy content
   * @param conflictNoteId - The ID of the conflict copy note
   * @param canonicalNoteId - The ID of the canonical note to update
   */
  async resolveConflictUseConflictVersion(
    conflictNoteId: string,
    canonicalNoteId: string
  ): Promise<void> {
    await this.transactionManager.execute(() => {
      const now = Date.now();

      // Get conflict copy content
      const conflictContent = this.db
        .prepare(
          `SELECT r.lexical_json, r.plaintext, n.title
           FROM note_content_head h
           JOIN note_revisions r ON r.revision_id = h.revision_id
           JOIN notes n ON n.id = h.note_id
           WHERE h.note_id = ?`
        )
        .get(conflictNoteId) as
        | { lexical_json: string; plaintext: string; title: string }
        | undefined;

      if (!conflictContent) {
        throw new Error(`Conflict note ${conflictNoteId} not found`);
      }

      // Clean up the title (remove [Conflict] prefix)
      const cleanTitle = conflictContent.title.replace(/^\[(?:Conflict|.+ Conflict)\]\s*/, '');

      // Update canonical note with conflict copy content
      this.db
        .prepare('UPDATE notes SET title = ?, updated_at = ? WHERE id = ?')
        .run(cleanTitle, now, canonicalNoteId);

      // Create new revision for canonical note
      const hash = crypto.createHash('sha256').update(conflictContent.lexical_json).digest('hex');
      const revisionInfo = this.db
        .prepare(
          'INSERT INTO note_revisions(note_id,lexical_json,plaintext,hash,created_at) VALUES (?,?,?,?,?)'
        )
        .run(canonicalNoteId, conflictContent.lexical_json, conflictContent.plaintext, hash, now);

      const revisionId = Number(revisionInfo.lastInsertRowid);

      // Update head pointer
      this.db
        .prepare(
          'INSERT INTO note_content_head(note_id,revision_id) VALUES (?,?) ON CONFLICT(note_id) DO UPDATE SET revision_id=excluded.revision_id'
        )
        .run(canonicalNoteId, revisionId);

      // Soft delete the conflict copy
      this.db
        .prepare('UPDATE notes SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(now, conflictNoteId);
    });

    // Mark both entities as dirty so sync pushes the resolution
    this.syncItems?.markDirty('notes', canonicalNoteId);
    this.syncItems?.markDirty('notes', conflictNoteId);
  }

  /**
   * Resolve a conflict by deleting the conflict copy (keep canonical)
   * @param conflictNoteId - The ID of the conflict copy to delete
   */
  async resolveConflictKeepCanonical(conflictNoteId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      const now = Date.now();

      // Soft delete the conflict copy
      const result = this.db
        .prepare('UPDATE notes SET deleted = 1, updated_at = ? WHERE id = ? AND is_conflict = 1')
        .run(now, conflictNoteId);

      if (result.changes === 0) {
        throw new Error(`Conflict note ${conflictNoteId} not found or not a conflict copy`);
      }
    });

    // Mark conflict copy as dirty so sync pushes the deletion
    this.syncItems?.markDirty('notes', conflictNoteId);
  }

  /**
   * Get full content of a note including conflict metadata
   */
  async getWithConflictMeta(noteId: string): Promise<{
    meta: NoteMeta & {
      isConflict: boolean;
      conflictOfId: string | null;
      conflictCreatedAt: number | null;
    };
    content: NoteContent;
    conflictCopies: NoteSummary[];
  }> {
    // Get note metadata including conflict fields
    const metaStmt = this.db.prepare(
      `SELECT *, is_conflict, conflict_of_id, conflict_created_at FROM notes WHERE id=?`
    );
    const metaRow = metaStmt.get(noteId) as
      | (NoteMetaRow & {
          is_conflict: number;
          conflict_of_id: string | null;
          conflict_created_at: number | null;
        })
      | undefined;

    if (!metaRow) {
      throw new Error(`Note with ID ${noteId} not found`);
    }

    // Get current content
    const contentStmt = this.db.prepare(`
      SELECT r.lexical_json, r.plaintext
      FROM note_content_head h
      JOIN note_revisions r ON r.revision_id = h.revision_id
      WHERE h.note_id = ?
    `);
    const contentRow = contentStmt.get(noteId) as
      | { lexical_json: string; plaintext: string }
      | undefined;

    if (!contentRow) {
      throw new Error(`Content for note ${noteId} not found`);
    }

    // Get conflict copies if this is a canonical note
    const conflictCopies = metaRow.is_conflict === 0 ? await this.getConflictsForNote(noteId) : [];

    const meta = {
      id: metaRow.id,
      binderId: metaRow.binder_id,
      title: metaRow.title,
      createdAt: new Date(metaRow.created_at),
      updatedAt: new Date(metaRow.updated_at),
      deleted: metaRow.deleted === 1,
      pinned: metaRow.pinned === 1,
      starred: metaRow.starred === 1,
      archived: metaRow.archived === 1,
      isConflict: metaRow.is_conflict === 1,
      conflictOfId: metaRow.conflict_of_id,
      conflictCreatedAt: metaRow.conflict_created_at,
    };

    const content: NoteContent = {
      lexicalJson: contentRow.lexical_json,
      plainText: contentRow.plaintext,
    };

    return { meta, content, conflictCopies };
  }
}
