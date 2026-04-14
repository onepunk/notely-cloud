import crypto from 'crypto';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { TransactionManager } from '../core/TransactionManager';
import { IBinderService } from '../interfaces/IBinderService';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { IUserService } from '../interfaces/IUserService';
import {
  UNASSIGNED_BINDER_ID,
  BinderType,
  isSystemBinder,
} from '../migrations/seeds/defaultBinders';
import { BinderRow } from '../types/database';
import { Binder, UpdateBinderInput } from '../types/entities';

import type { SyncItemsService } from './SyncItemsService';

/**
 * BinderService - Binder CRUD operations
 */
export class BinderService implements IBinderService {
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

  /**
   * Security validation: Verify user owns the binder and it's not a system binder for protected operations
   * Implements o3's recommendation for (user_id, binder_id) pair validation
   */
  private async validateBinderOwnership(
    binderId: string,
    userId?: string,
    allowSystemBinder = false
  ): Promise<void> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const stmt = this.db.prepare(
      'SELECT user_profile_id, binder_type FROM binders WHERE id=? AND deleted=0'
    );

    const row = stmt.get(binderId) as { user_profile_id: string; binder_type: string } | undefined;

    if (!row) {
      throw new Error(`Binder with ID ${binderId} not found`);
    }

    // Validate user ownership
    if (row.user_profile_id !== targetUserId) {
      throw new Error(`Access denied: User ${targetUserId} does not own binder ${binderId}`);
    }

    // Validate system binder access if not allowed
    if (!allowSystemBinder && row.binder_type === BinderType.SYSTEM) {
      throw new Error(`Access denied: Cannot modify system binder ${binderId}`);
    }
  }

  /**
   * Security validation: Prevent system binder modification/deletion
   * Implements o3's recommendation for preventing system binder tampering
   */
  private validateNotSystemBinder(binderId: string): void {
    if (isSystemBinder(binderId)) {
      throw new Error(`Access denied: Cannot modify system binder ${binderId}`);
    }
  }

  /**
   * List all binders for a user, ordered by sort_index
   */
  async list(userId?: string): Promise<BinderRow[]> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const stmt = this.db.prepare(
      'SELECT * FROM binders WHERE user_profile_id=? AND deleted=0 ORDER BY sort_index ASC, created_at ASC'
    );

    return stmt.all(targetUserId) as BinderRow[];
  }

  /**
   * Create a new binder
   */
  async create(name: string, userId?: string): Promise<string> {
    const id = crypto.randomUUID();
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const binderId = await this.transactionManager.execute(() => {
      const now = Date.now();

      // Get the next sort_index
      const maxRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sort_index), -1) AS m FROM binders WHERE user_profile_id=? AND deleted=0'
        )
        .get(targetUserId) as { m: number } | undefined;

      const sortIndex = ((maxRow?.m ?? -1) as number) + 1;

      // Insert the new binder (always USER type for user-created binders)
      const stmt = this.db.prepare(`
        INSERT INTO binders(
          id, user_profile_id, name, sort_index, color, icon,
          is_team_shared, remote_id, created_at, updated_at, deleted, binder_type
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      stmt.run(
        id,
        targetUserId,
        name,
        sortIndex,
        null, // color
        null, // icon
        0, // is_team_shared
        null, // remote_id
        now, // created_at
        now, // updated_at
        0, // deleted
        BinderType.USER // All user-created binders are USER type
      );

      return id;
    });

    this.syncItems?.markDirty('binders', binderId);
    return binderId;
  }

  /**
   * Create a new binder with a specific ID (for sync operations)
   * This method is primarily used by the sync engine to create binders
   * with IDs that match the server records
   */
  async createWithId(
    id: string,
    name: string,
    sortIndex: number,
    color: string | null,
    icon: string | null,
    isTeamShared: boolean,
    binderType: string,
    userId?: string,
    createdAt?: number,
    updatedAt?: number
  ): Promise<void> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());
    const now = Date.now();

    await this.transactionManager.execute(() => {
      const stmt = this.db.prepare(`
        INSERT INTO binders (
          id, user_profile_id, name, sort_index, color, icon,
          is_team_shared, remote_id, created_at, updated_at, deleted, binder_type,
          server_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,
          sort_index=excluded.sort_index,
          color=excluded.color,
          icon=excluded.icon,
          is_team_shared=excluded.is_team_shared,
          updated_at=excluded.updated_at,
          binder_type=excluded.binder_type,
          server_updated_at=excluded.server_updated_at
      `);

      stmt.run(
        id,
        targetUserId,
        name,
        sortIndex,
        color,
        icon,
        isTeamShared ? 1 : 0,
        null, // remote_id
        createdAt || now,
        updatedAt || now,
        0, // deleted
        binderType,
        now // server_updated_at - mark when we received this from server
      );
    });
  }

  /**
   * Update binder properties
   * Enhanced with security validations per o3's recommendations
   */
  async update(input: UpdateBinderInput): Promise<void> {
    // Security validation: Prevent system binder modification
    await this.validateBinderOwnership(input.id);

    let didChange = false;

    await this.transactionManager.execute(() => {
      const { id, name, color, icon, isTeamShared } = input;
      const now = Date.now();
      const updates: string[] = [];
      const values: Array<string | number | null> = [];

      const current = this.db
        .prepare(
          'SELECT name, color, icon, is_team_shared FROM binders WHERE id = ? AND deleted = 0'
        )
        .get(id) as
        | { name: string; color: string | null; icon: string | null; is_team_shared: number }
        | undefined;

      if (!current) {
        throw new Error(`Binder with ID ${id} not found`);
      }

      if (name !== undefined) {
        if (name !== current.name) {
          updates.push('name=?');
          values.push(name);
        }
      }
      if (color !== undefined) {
        if (color !== current.color) {
          updates.push('color=?');
          values.push(color);
        }
      }
      if (icon !== undefined) {
        if (icon !== current.icon) {
          updates.push('icon=?');
          values.push(icon);
        }
      }
      if (isTeamShared !== undefined) {
        const nextIsTeamShared = isTeamShared ? 1 : 0;
        if (nextIsTeamShared !== current.is_team_shared) {
          updates.push('is_team_shared=?');
          values.push(nextIsTeamShared);
        }
      }

      if (updates.length === 0) {
        return; // No updates to perform
      }

      updates.push('updated_at=?');
      values.push(now);
      values.push(id); // For WHERE clause

      const stmt = this.db.prepare(`UPDATE binders SET ${updates.join(', ')} WHERE id=?`);
      const result = stmt.run(...values);

      if (result.changes === 0) {
        throw new Error(`Binder with ID ${id} not found`);
      }

      didChange = true;
    });

    if (didChange) {
      this.syncItems?.markDirty('binders', input.id);
    }
  }

  /**
   * Rename a binder
   */
  async rename(id: string, name: string): Promise<void> {
    await this.update({ id, name });
  }

  /**
   * Soft delete a binder (and all its notes)
   * Enhanced with security validations per o3's recommendations
   */
  async delete(id: string): Promise<void> {
    // Security validation: Prevent system binder deletion
    await this.validateBinderOwnership(id);

    // Collect note IDs before the transaction so we can mark them dirty for sync
    const affectedNotes = this.db
      .prepare('SELECT id FROM notes WHERE binder_id = ? AND deleted = 0')
      .all(id) as Array<{ id: string }>;

    await this.transactionManager.execute(() => {
      const now = Date.now();

      // Soft delete the binder
      const binderStmt = this.db.prepare('UPDATE binders SET deleted=1, updated_at=? WHERE id=?');
      const binderResult = binderStmt.run(now, id);

      if (binderResult.changes === 0) {
        throw new Error(`Binder with ID ${id} not found`);
      }

      // Soft delete all notes in the binder
      const notesStmt = this.db.prepare(
        'UPDATE notes SET deleted=1, updated_at=? WHERE binder_id=?'
      );
      notesStmt.run(now, id);
    });

    this.syncItems?.markDirty('binders', id);

    // Mark each cascade-deleted note as dirty so the deletion syncs to server
    for (const note of affectedNotes) {
      this.syncItems?.markDirty('notes', note.id);
    }
  }

  /**
   * Reorder binders by providing new order array
   * Enhanced with security validations per o3's recommendations
   */
  async reorder(order: string[]): Promise<void> {
    if (order.length === 0) {
      return;
    }

    // Security validation: Ensure all binders belong to current user and none are system binders
    const currentUserId = await this.userService.getCurrentUserId();
    for (const binderId of order) {
      await this.validateBinderOwnership(binderId, currentUserId);
    }

    const changedBinderIds: string[] = [];

    await this.transactionManager.execute(() => {
      const now = Date.now();
      const selectStmt = this.db.prepare('SELECT sort_index FROM binders WHERE id=?');
      const stmt = this.db.prepare('UPDATE binders SET sort_index=?, updated_at=? WHERE id=?');

      for (let i = 0; i < order.length; i++) {
        const binderId = order[i];
        const current = selectStmt.get(binderId) as { sort_index: number } | undefined;

        if (!current) {
          throw new Error(`Binder with ID ${binderId} not found during reorder`);
        }

        if (current.sort_index === i) {
          continue;
        }

        const result = stmt.run(i, now, binderId);
        if (result.changes === 0) {
          throw new Error(`Binder with ID ${binderId} not found during reorder`);
        }

        changedBinderIds.push(binderId);
      }
    });
  }

  /**
   * Get the system "Unassigned" binder ID
   * This method now returns the hardcoded UUID for the Unassigned binder
   * @deprecated The name parameter is ignored; this always returns the Unassigned binder ID
   */
  async getDefaultBinderId(_name: string = 'Unassigned'): Promise<string> {
    // Always return the hardcoded Unassigned binder ID
    // This ensures consistency across installations and eliminates sync conflicts
    return UNASSIGNED_BINDER_ID;
  }

  /**
   * List user-created binders only (excludes system binders)
   * Enhanced to use binder_type column per o3's recommendations
   * This method should be used for UI display where system binders should be hidden
   */
  async listUserBinders(userId?: string): Promise<BinderRow[]> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const stmt = this.db.prepare(`
      SELECT * FROM binders 
      WHERE user_profile_id=? AND deleted=0 AND binder_type=?
      ORDER BY sort_index ASC, created_at ASC
    `);

    return stmt.all(targetUserId, BinderType.USER) as BinderRow[];
  }

  /**
   * Get binder by ID
   * Enhanced with ownership validation per o3's recommendations
   */
  async getById(id: string, userId?: string): Promise<Binder | null> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const stmt = this.db.prepare(
      'SELECT * FROM binders WHERE id=? AND user_profile_id=? AND deleted=0'
    );

    const row = stmt.get(id, targetUserId) as BinderRow | undefined;

    if (!row) {
      return null;
    }

    return this.mapRowToBinder(row);
  }

  /**
   * Check if binder exists and is accessible to user
   */
  async exists(id: string, userId?: string): Promise<boolean> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const stmt = this.db.prepare(
      'SELECT 1 FROM binders WHERE id=? AND user_profile_id=? AND deleted=0 LIMIT 1'
    );

    const row = stmt.get(id, targetUserId);
    return row !== undefined;
  }

  /**
   * Get multiple binders by their IDs
   * More efficient than multiple getById calls
   */
  async getByIds(ids: string[]): Promise<BinderRow[]> {
    if (ids.length === 0) {
      return [];
    }

    // Create placeholders for SQL IN clause
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT * FROM binders WHERE id IN (${placeholders}) AND deleted=0`
    );

    return stmt.all(...ids) as BinderRow[];
  }

  /**
   * Get all binders for sync operations
   * Used by Merkle tree sync to enumerate all binders for hash computation
   */
  async getAllBinders(userId?: string): Promise<BinderRow[]> {
    // Delegate to existing list() method which already gets all binders
    return await this.list(userId);
  }

  /**
   * Map database row to domain entity
   */
  private mapRowToBinder(row: BinderRow): Binder {
    return {
      id: row.id,
      userId: row.user_profile_id,
      name: row.name,
      sortIndex: row.sort_index,
      color: row.color,
      icon: row.icon,
      isTeamShared: row.is_team_shared === 1,
      remoteId: row.remote_id,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      deleted: row.deleted === 1,
    };
  }

  // ============================================
  // Conflicts Binder Methods (Phase 5)
  // ============================================

  /**
   * Get the Conflicts binder for the current user
   * Returns null if no conflicts binder exists
   */
  async getConflictsBinder(userId?: string): Promise<BinderRow | null> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const stmt = this.db.prepare(
      'SELECT * FROM binders WHERE user_profile_id = ? AND is_conflicts = 1 AND deleted = 0 LIMIT 1'
    );

    const row = stmt.get(targetUserId) as BinderRow | undefined;
    return row || null;
  }

  /**
   * Ensure a Conflicts binder exists for the current user
   * Creates one if it doesn't exist, returns the existing one otherwise
   * @returns The Conflicts binder ID
   */
  async ensureConflictsBinder(userId?: string): Promise<string> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    // Check if conflicts binder already exists
    const existing = await this.getConflictsBinder(targetUserId);
    if (existing) {
      return existing.id;
    }

    // Create a new conflicts binder
    const id = crypto.randomUUID();

    const binderId = await this.transactionManager.execute(() => {
      const now = Date.now();

      // Get the next sort_index (place at end)
      const maxRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sort_index), -1) AS m FROM binders WHERE user_profile_id=? AND deleted=0'
        )
        .get(targetUserId) as { m: number } | undefined;

      const sortIndex = ((maxRow?.m ?? -1) as number) + 1;

      // Insert the conflicts binder with SYSTEM type and is_conflicts=1
      const stmt = this.db.prepare(`
        INSERT INTO binders(
          id, user_profile_id, name, sort_index, color, icon,
          is_team_shared, remote_id, created_at, updated_at, deleted, binder_type, is_conflicts
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);

      stmt.run(
        id,
        targetUserId,
        'Conflicts', // name
        sortIndex,
        '#DC2626', // color (red for conflicts)
        'AlertTriangle', // icon (Lucide warning icon)
        0, // is_team_shared
        null, // remote_id
        now, // created_at
        now, // updated_at
        0, // deleted
        BinderType.SYSTEM, // binder_type - system binder
        1 // is_conflicts = true
      );

      return id;
    });

    return binderId;
  }

  /**
   * Get the count of conflict notes in the Conflicts binder
   * @returns Number of unresolved conflicts
   */
  async getConflictsCount(userId?: string): Promise<number> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    const stmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM notes n
       JOIN binders b ON n.binder_id = b.id
       WHERE b.user_profile_id = ? AND b.is_conflicts = 1 AND n.is_conflict = 1 AND n.deleted = 0`
    );

    const row = stmt.get(targetUserId) as { count: number };
    return row.count;
  }

  /**
   * Check if the Conflicts binder has any unresolved conflicts
   * @returns true if there are unresolved conflicts
   */
  async hasUnresolvedConflicts(userId?: string): Promise<boolean> {
    const count = await this.getConflictsCount(userId);
    return count > 0;
  }

  /**
   * List binders including the Conflicts binder if it exists and has content
   * This is the method that should be used by the UI to get the full binder list
   */
  async listWithConflicts(userId?: string): Promise<BinderRow[]> {
    const targetUserId = userId || (await this.userService.getCurrentUserId());

    // Get all user binders (excludes system binders)
    const userBinders = await this.listUserBinders(targetUserId);

    // Check if there's a conflicts binder with content
    const conflictsBinder = await this.getConflictsBinder(targetUserId);
    if (conflictsBinder) {
      const conflictsCount = await this.getConflictsCount(targetUserId);
      if (conflictsCount > 0) {
        // Include conflicts binder at the beginning (or end, depending on UX preference)
        return [conflictsBinder, ...userBinders];
      }
    }

    return userBinders;
  }
}
