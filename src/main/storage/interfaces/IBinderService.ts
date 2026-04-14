/**
 * Binder service interface - Binder CRUD operations
 */

import type { BinderRow } from '../types/database';
import type { Binder, UpdateBinderInput } from '../types/entities';

export interface IBinderService {
  /**
   * List all binders for a user, ordered by sort_index
   */
  list(userId?: string): Promise<BinderRow[]>;

  /**
   * List user-created binders only (excludes the system Unassigned binder)
   * This method should be used for UI display where the system binder should be hidden
   */
  listUserBinders(userId?: string): Promise<BinderRow[]>;

  /**
   * Create a new binder
   */
  create(name: string, userId?: string): Promise<string>;

  /**
   * Create a new binder with a specific ID (for sync operations)
   * This method is primarily used by the sync engine to create binders
   * with IDs that match the server records
   */
  createWithId(
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
  ): Promise<void>;

  /**
   * Update binder properties
   */
  update(input: UpdateBinderInput): Promise<void>;

  /**
   * Rename a binder
   */
  rename(id: string, name: string): Promise<void>;

  /**
   * Soft delete a binder (and all its notes)
   */
  delete(id: string): Promise<void>;

  /**
   * Reorder binders by providing new order array
   */
  reorder(order: string[]): Promise<void>;

  /**
   * Get default binder ID by name (usually "General")
   */
  getDefaultBinderId(name?: string): Promise<string>;

  /**
   * Get binder by ID
   */
  getById(id: string): Promise<Binder | null>;

  /**
   * Check if binder exists and is accessible to user
   */
  exists(id: string, userId?: string): Promise<boolean>;

  /**
   * Get multiple binders by their IDs
   * More efficient than multiple getById calls
   */
  getByIds(ids: string[]): Promise<BinderRow[]>;

  /**
   * Get all binders for sync operations
   * Used by Merkle tree sync to enumerate all binders for hash computation
   */
  getAllBinders(userId?: string): Promise<BinderRow[]>;

  // ============================================
  // Conflicts Binder Methods (Phase 5)
  // ============================================

  /**
   * Get the Conflicts binder for the current user
   * Returns null if no conflicts binder exists
   */
  getConflictsBinder(userId?: string): Promise<BinderRow | null>;

  /**
   * Ensure a Conflicts binder exists for the current user
   * Creates one if it doesn't exist, returns the existing one otherwise
   */
  ensureConflictsBinder(userId?: string): Promise<string>;

  /**
   * Get the count of conflict notes in the Conflicts binder
   */
  getConflictsCount(userId?: string): Promise<number>;

  /**
   * Check if the Conflicts binder has any unresolved conflicts
   */
  hasUnresolvedConflicts(userId?: string): Promise<boolean>;

  /**
   * List binders including the Conflicts binder if it exists and has content
   */
  listWithConflicts(userId?: string): Promise<BinderRow[]>;
}
