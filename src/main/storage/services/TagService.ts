import crypto from 'crypto';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { ITagService } from '../interfaces/ITagService';
import { IUserService } from '../interfaces/IUserService';
import type { NoteSummary } from '../types/entities';
import type { Tag, TagRow, NoteTagRow, CreateTagInput, UpdateTagInput } from '../types/tags';

import type { SyncItemsService } from './SyncItemsService';

/**
 * TagService - Tag and NoteTag CRUD operations
 */
export class TagService implements ITagService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager,
    private userService: IUserService,
    private syncItems?: SyncItemsService
  ) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  // ============================================
  // CRUD Operations
  // ============================================

  async create(input: CreateTagInput, userId?: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const tagId = await this.transactionManager.execute(() => {
      // Get next sort index
      const maxSort = this.db
        .prepare(
          'SELECT COALESCE(MAX(sort_index), -1) + 1 as next FROM tags WHERE deleted = 0 AND user_profile_id = ?'
        )
        .get(targetUserId) as { next: number };

      this.db
        .prepare(
          `
        INSERT INTO tags (id, user_profile_id, name, color, sort_index, created_at, updated_at, deleted, sync_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1)
      `
        )
        .run(id, targetUserId, input.name, input.color || null, maxSort.next, now, now);

      return id;
    });

    this.syncItems?.markDirty('tags', tagId);
    return tagId;
  }

  async list(userId?: string): Promise<Tag[]> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const rows = this.db
      .prepare(
        `
      SELECT t.*, COUNT(CASE WHEN nt.deleted = 0 AND n.deleted = 0 THEN 1 END) as note_count
      FROM tags t
      LEFT JOIN note_tags nt ON t.id = nt.tag_id
      LEFT JOIN notes n ON nt.note_id = n.id
      WHERE t.deleted = 0 AND t.user_profile_id = ?
      GROUP BY t.id
      ORDER BY t.sort_index ASC, t.name ASC
    `
      )
      .all(targetUserId) as (TagRow & { note_count: number })[];

    return rows.map((row) => this.mapRowToTag(row));
  }

  async get(tagId: string): Promise<Tag | null> {
    const row = this.db
      .prepare(
        `
      SELECT t.*, COUNT(CASE WHEN nt.deleted = 0 AND n.deleted = 0 THEN 1 END) as note_count
      FROM tags t
      LEFT JOIN note_tags nt ON t.id = nt.tag_id
      LEFT JOIN notes n ON nt.note_id = n.id
      WHERE t.id = ? AND t.deleted = 0
      GROUP BY t.id
    `
      )
      .get(tagId) as (TagRow & { note_count: number }) | undefined;

    return row ? this.mapRowToTag(row) : null;
  }

  async update(input: UpdateTagInput): Promise<void> {
    const current = this.db
      .prepare('SELECT name, color FROM tags WHERE id = ? AND deleted = 0')
      .get(input.id) as { name: string; color: string | null } | undefined;

    if (!current) {
      return;
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (input.name !== undefined && input.name !== current.name) {
      updates.push('name = ?');
      params.push(input.name);
    }

    if (input.color !== undefined && input.color !== current.color) {
      updates.push('color = ?');
      params.push(input.color);
    }

    if (updates.length === 0) {
      return;
    }

    const now = Date.now();
    updates.push('updated_at = ?');
    params.push(now);
    params.push(input.id);

    this.db
      .prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ? AND deleted = 0`)
      .run(...params);

    this.syncItems?.markDirty('tags', input.id);
  }

  async delete(tagId: string): Promise<void> {
    const now = Date.now();

    // Collect note_tag IDs before deletion so we can mark them dirty for sync
    const affectedNoteTags = this.db
      .prepare('SELECT id FROM note_tags WHERE tag_id = ? AND deleted = 0')
      .all(tagId) as Array<{ id: string }>;

    await this.transactionManager.execute(() => {
      // Soft delete the tag
      this.db.prepare('UPDATE tags SET deleted = 1, updated_at = ? WHERE id = ?').run(now, tagId);

      // Soft delete all note associations
      this.db
        .prepare('UPDATE note_tags SET deleted = 1, updated_at = ? WHERE tag_id = ?')
        .run(now, tagId);
    });

    this.syncItems?.markDirty('tags', tagId);

    // Mark each cascade-deleted note_tag as dirty so the deletion syncs to server
    for (const noteTag of affectedNoteTags) {
      this.syncItems?.markDirty('note_tags', noteTag.id);
    }
  }

  async reorder(tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) {
      return;
    }

    const now = Date.now();
    await this.transactionManager.execute(() => {
      const selectStmt = this.db.prepare(
        'SELECT sort_index FROM tags WHERE id = ? AND deleted = 0'
      );
      const stmt = this.db.prepare(
        'UPDATE tags SET sort_index = ?, updated_at = ? WHERE id = ? AND deleted = 0'
      );

      tagIds.forEach((id, index) => {
        const current = selectStmt.get(id) as { sort_index: number } | undefined;
        if (!current) {
          return;
        }

        if (current.sort_index === index) {
          return;
        }

        stmt.run(index, now, id);
      });
    });
  }

  // ============================================
  // Note-Tag Associations
  // ============================================

  async addToNote(noteId: string, tagId: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const userId = await this.userService.getCurrentUserId();

    // Check if soft-deleted association exists
    const existing = this.db
      .prepare('SELECT id FROM note_tags WHERE note_id = ? AND tag_id = ?')
      .get(noteId, tagId) as { id: string } | undefined;

    let noteTagId: string;

    if (existing) {
      // Restore if soft-deleted
      this.db
        .prepare('UPDATE note_tags SET deleted = 0, updated_at = ? WHERE id = ?')
        .run(now, existing.id);
      noteTagId = existing.id;
    } else {
      this.db
        .prepare(
          `
        INSERT INTO note_tags (id, note_id, tag_id, user_profile_id, created_at, updated_at, deleted, sync_version)
        VALUES (?, ?, ?, ?, ?, ?, 0, 1)
      `
        )
        .run(id, noteId, tagId, userId, now, now);
      noteTagId = id;
    }

    this.syncItems?.markDirty('note_tags', noteTagId);
    return noteTagId;
  }

  async removeFromNote(noteId: string, tagId: string): Promise<void> {
    const now = Date.now();

    // Get the note_tag ID
    const noteTag = this.db
      .prepare('SELECT id FROM note_tags WHERE note_id = ? AND tag_id = ?')
      .get(noteId, tagId) as { id: string } | undefined;

    this.db
      .prepare('UPDATE note_tags SET deleted = 1, updated_at = ? WHERE note_id = ? AND tag_id = ?')
      .run(now, noteId, tagId);

    if (noteTag) {
      this.syncItems?.markDirty('note_tags', noteTag.id);
    }
  }

  async setNoteTags(noteId: string, tagIds: string[]): Promise<void> {
    const now = Date.now();
    const userId = await this.userService.getCurrentUserId();

    // Collect existing note_tag IDs before bulk replacement so we can mark them dirty
    const existingNoteTags = this.db
      .prepare('SELECT id FROM note_tags WHERE note_id = ? AND deleted = 0')
      .all(noteId) as Array<{ id: string }>;

    await this.transactionManager.execute(() => {
      // Soft delete all existing tags for this note
      this.db
        .prepare(
          'UPDATE note_tags SET deleted = 1, updated_at = ? WHERE note_id = ? AND deleted = 0'
        )
        .run(now, noteId);

      // Add/restore the new tags
      const insertStmt = this.db.prepare(`
        INSERT INTO note_tags (id, note_id, tag_id, user_profile_id, created_at, updated_at, deleted, sync_version)
        VALUES (?, ?, ?, ?, ?, ?, 0, 1)
        ON CONFLICT(note_id, tag_id) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at
      `);

      tagIds.forEach((tagId) => {
        insertStmt.run(crypto.randomUUID(), noteId, tagId, userId, now, now);
      });
    });

    // Mark old note_tags as dirty so deletions sync to server
    for (const noteTag of existingNoteTags) {
      this.syncItems?.markDirty('note_tags', noteTag.id);
    }

    // Mark new/restored note_tags as dirty so additions sync to server
    const newNoteTags = this.db
      .prepare('SELECT id FROM note_tags WHERE note_id = ? AND deleted = 0')
      .all(noteId) as Array<{ id: string }>;
    for (const noteTag of newNoteTags) {
      this.syncItems?.markDirty('note_tags', noteTag.id);
    }
  }

  async getTagsByNote(noteId: string): Promise<Tag[]> {
    const rows = this.db
      .prepare(
        `
      SELECT t.*
      FROM tags t
      INNER JOIN note_tags nt ON t.id = nt.tag_id
      WHERE nt.note_id = ? AND nt.deleted = 0 AND t.deleted = 0
      ORDER BY t.sort_index ASC
    `
      )
      .all(noteId) as TagRow[];

    return rows.map((row) => this.mapRowToTag({ ...row, note_count: 0 }));
  }

  async getNotesByTag(tagId: string): Promise<NoteSummary[]> {
    return this.db
      .prepare(
        `
      SELECT n.*
      FROM notes n
      INNER JOIN note_tags nt ON n.id = nt.note_id
      WHERE nt.tag_id = ? AND nt.deleted = 0 AND n.deleted = 0
      ORDER BY n.updated_at DESC
    `
      )
      .all(tagId) as NoteSummary[];
  }

  async getNotesCountByTag(tagId: string): Promise<number> {
    const result = this.db
      .prepare(
        `
      SELECT COUNT(*) as count
      FROM note_tags nt
      INNER JOIN notes n ON nt.note_id = n.id
      WHERE nt.tag_id = ? AND nt.deleted = 0 AND n.deleted = 0
    `
      )
      .get(tagId) as { count: number };

    return result.count;
  }

  // ============================================
  // Bulk Operations
  // ============================================

  async getTagsForNotes(noteIds: string[]): Promise<Map<string, Tag[]>> {
    if (noteIds.length === 0) return new Map();

    const placeholders = noteIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `
      SELECT nt.note_id, t.*
      FROM tags t
      INNER JOIN note_tags nt ON t.id = nt.tag_id
      WHERE nt.note_id IN (${placeholders}) AND nt.deleted = 0 AND t.deleted = 0
      ORDER BY t.sort_index ASC
    `
      )
      .all(...noteIds) as (TagRow & { note_id: string })[];

    const result = new Map<string, Tag[]>();
    noteIds.forEach((id) => result.set(id, []));

    rows.forEach((row) => {
      const tags = result.get(row.note_id) || [];
      tags.push(this.mapRowToTag({ ...row, note_count: 0 }));
      result.set(row.note_id, tags);
    });

    return result;
  }

  // ============================================
  // Sync Support - Tags
  // ============================================

  async getAllTags(userId?: string): Promise<TagRow[]> {
    if (userId) {
      return this.db
        .prepare('SELECT * FROM tags WHERE user_profile_id = ?')
        .all(userId) as TagRow[];
    }
    return this.db.prepare('SELECT * FROM tags').all() as TagRow[];
  }

  async getTagById(tagId: string): Promise<TagRow | null> {
    return (this.db.prepare('SELECT * FROM tags WHERE id = ?').get(tagId) as TagRow | null) ?? null;
  }

  async createTagWithId(tag: Partial<TagRow>): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO tags (id, user_profile_id, name, color, sort_index, created_at, updated_at, deleted, sync_version, sync_checksum, server_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        color = excluded.color,
        sort_index = excluded.sort_index,
        updated_at = excluded.updated_at,
        deleted = excluded.deleted,
        sync_version = excluded.sync_version,
        sync_checksum = excluded.sync_checksum,
        server_updated_at = excluded.server_updated_at
    `
      )
      .run(
        tag.id,
        tag.user_profile_id,
        tag.name || 'Untitled Tag',
        tag.color || null,
        tag.sort_index || 0,
        tag.created_at || now,
        tag.updated_at || now,
        tag.deleted || 0,
        tag.sync_version || 1,
        tag.sync_checksum || null,
        tag.server_updated_at || null
      );
  }

  async updateTagFromSync(tag: Partial<TagRow>): Promise<void> {
    if (!tag.id) throw new Error('Tag id required for sync update');

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (tag.name !== undefined) {
      updates.push('name = ?');
      params.push(tag.name);
    }
    if (tag.color !== undefined) {
      updates.push('color = ?');
      params.push(tag.color);
    }
    if (tag.sort_index !== undefined) {
      updates.push('sort_index = ?');
      params.push(tag.sort_index);
    }
    if (tag.updated_at !== undefined) {
      updates.push('updated_at = ?');
      params.push(tag.updated_at);
    }
    if (tag.deleted !== undefined) {
      updates.push('deleted = ?');
      params.push(tag.deleted);
    }
    if (tag.sync_version !== undefined) {
      updates.push('sync_version = ?');
      params.push(tag.sync_version);
    }
    if (tag.sync_checksum !== undefined) {
      updates.push('sync_checksum = ?');
      params.push(tag.sync_checksum);
    }
    if (tag.server_updated_at !== undefined) {
      updates.push('server_updated_at = ?');
      params.push(tag.server_updated_at);
    }

    if (updates.length === 0) return;

    params.push(tag.id);
    this.db.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  async softDeleteTag(tagId: string): Promise<void> {
    const now = Date.now();
    this.db.prepare('UPDATE tags SET deleted = 1, updated_at = ? WHERE id = ?').run(now, tagId);
  }

  // ============================================
  // Sync Support - NoteTags
  // ============================================

  async getAllNoteTags(userId?: string): Promise<NoteTagRow[]> {
    if (userId) {
      return this.db
        .prepare('SELECT * FROM note_tags WHERE user_profile_id = ?')
        .all(userId) as NoteTagRow[];
    }
    return this.db.prepare('SELECT * FROM note_tags').all() as NoteTagRow[];
  }

  async getNoteTagById(noteTagId: string): Promise<NoteTagRow | null> {
    return (
      (this.db
        .prepare('SELECT * FROM note_tags WHERE id = ?')
        .get(noteTagId) as NoteTagRow | null) ?? null
    );
  }

  async createNoteTagWithId(noteTag: Partial<NoteTagRow>): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO note_tags (id, note_id, tag_id, user_profile_id, created_at, updated_at, deleted, sync_version, sync_checksum, server_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        updated_at = excluded.updated_at,
        deleted = excluded.deleted,
        sync_version = excluded.sync_version,
        sync_checksum = excluded.sync_checksum,
        server_updated_at = excluded.server_updated_at
    `
      )
      .run(
        noteTag.id,
        noteTag.note_id,
        noteTag.tag_id,
        noteTag.user_profile_id,
        noteTag.created_at || now,
        noteTag.updated_at || now,
        noteTag.deleted || 0,
        noteTag.sync_version || 1,
        noteTag.sync_checksum || null,
        noteTag.server_updated_at || null
      );
  }

  async updateNoteTagFromSync(noteTag: Partial<NoteTagRow>): Promise<void> {
    if (!noteTag.id) throw new Error('NoteTag id required for sync update');

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (noteTag.updated_at !== undefined) {
      updates.push('updated_at = ?');
      params.push(noteTag.updated_at);
    }
    if (noteTag.deleted !== undefined) {
      updates.push('deleted = ?');
      params.push(noteTag.deleted);
    }
    if (noteTag.sync_version !== undefined) {
      updates.push('sync_version = ?');
      params.push(noteTag.sync_version);
    }
    if (noteTag.sync_checksum !== undefined) {
      updates.push('sync_checksum = ?');
      params.push(noteTag.sync_checksum);
    }
    if (noteTag.server_updated_at !== undefined) {
      updates.push('server_updated_at = ?');
      params.push(noteTag.server_updated_at);
    }

    if (updates.length === 0) return;

    params.push(noteTag.id);
    this.db.prepare(`UPDATE note_tags SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  async softDeleteNoteTag(noteTagId: string): Promise<void> {
    const now = Date.now();
    this.db
      .prepare('UPDATE note_tags SET deleted = 1, updated_at = ? WHERE id = ?')
      .run(now, noteTagId);
  }

  // ============================================
  // Private Helpers
  // ============================================

  private mapRowToTag(row: TagRow & { note_count?: number }): Tag {
    return {
      id: row.id,
      userId: row.user_profile_id,
      name: row.name,
      color: row.color,
      sortIndex: row.sort_index,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      deleted: row.deleted === 1,
      noteCount: row.note_count ?? 0,
    };
  }
}
