/**
 * SyncItemsService - Joplin-style sync queue management
 *
 * Manages the sync_items table for cursor-based sync protocol.
 * Each entity that needs to be synced has a row in sync_items with sync_time=0.
 * After successful sync, sync_time is updated to the server timestamp.
 *
 * References:
 * - SYNC_JOPLIN.md#L224 (Sync queue semantics)
 * - SYNC_JOPLIN_PHASE0_SPEC.md Section 9 (Idempotency)
 */

import crypto from 'crypto';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { logger } from '../../logger';
import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';

/**
 * Valid entity types for sync
 * Matches server-side CollectionType and sync_items CHECK constraint
 */
export type SyncEntityType =
  | 'binders'
  | 'notes'
  | 'transcriptions'
  | 'summaries'
  | 'tags'
  | 'note_tags';

/**
 * Sync item row from database
 */
export interface SyncItemRow {
  entity_type: SyncEntityType;
  entity_id: string;
  sync_time: number;
  pending_mutation_id: string | null;
  sync_disabled: number;
  last_error: string | null;
  retry_count: number;
  updated_at: number;
}

/**
 * Sync item for API operations
 */
export interface SyncItem {
  entityType: SyncEntityType;
  entityId: string;
  syncTime: number;
  pendingMutationId: string | null;
  syncDisabled: boolean;
  lastError: string | null;
  retryCount: number;
  updatedAt: number;
}

/**
 * Options for marking an entity as dirty (needing sync)
 */
export interface MarkDirtyOptions {
  /** Reuse existing mutation_id if present (for retry scenarios) */
  preserveMutationId?: boolean;
}

/**
 * Batch of items to push to server
 */
export interface SyncBatch {
  items: SyncItem[];
  /** Map of entity_id -> mutation_id for idempotency */
  mutationIds: Map<string, string>;
}

/**
 * Service for managing the sync_items queue table
 */
export class SyncItemsService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager
  ) {}

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Mark an entity as needing sync (dirty)
   * Called by storage services on create/update/delete operations
   *
   * @param entityType - Type of entity (binders, notes, etc.)
   * @param entityId - UUID of the entity
   * @param options - Optional settings for marking dirty
   */
  markDirty(entityType: SyncEntityType, entityId: string, options: MarkDirtyOptions = {}): void {
    const now = Date.now();

    // Generate new mutation_id unless preserving existing one
    const mutationId = options.preserveMutationId ? null : crypto.randomUUID();

    const query = `
      INSERT INTO sync_items (entity_type, entity_id, sync_time, pending_mutation_id, updated_at)
      VALUES (?, ?, 0, COALESCE(?, (SELECT pending_mutation_id FROM sync_items WHERE entity_type = ? AND entity_id = ?)), ?)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        sync_time = 0,
        pending_mutation_id = COALESCE(
          CASE WHEN ? THEN sync_items.pending_mutation_id ELSE excluded.pending_mutation_id END,
          excluded.pending_mutation_id
        ),
        retry_count = CASE WHEN sync_items.sync_time = 0 THEN sync_items.retry_count ELSE 0 END,
        last_error = NULL,
        updated_at = excluded.updated_at
    `;

    try {
      this.db
        .prepare(query)
        .run(
          entityType,
          entityId,
          mutationId,
          entityType,
          entityId,
          now,
          options.preserveMutationId ? 1 : 0
        );

      logger.debug('[SyncItems] Marked entity dirty', { entityType, entityId });
    } catch (error) {
      logger.error('[SyncItems] Failed to mark entity dirty', {
        entityType,
        entityId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Mark multiple entities as dirty in a single transaction
   */
  markDirtyBatch(
    items: Array<{ entityType: SyncEntityType; entityId: string }>,
    options: MarkDirtyOptions = {}
  ): void {
    if (items.length === 0) return;

    this.transactionManager.execute(() => {
      for (const item of items) {
        this.markDirty(item.entityType, item.entityId, options);
      }
    });

    logger.debug('[SyncItems] Marked batch dirty', { count: items.length });
  }

  /**
   * Get pending items that need to be synced (sync_time = 0)
   *
   * @param limit - Maximum number of items to return
   * @returns Batch of items ready for sync
   */
  getPendingItems(limit: number = 100): SyncBatch {
    const query = `
      SELECT entity_type, entity_id, sync_time, pending_mutation_id,
             sync_disabled, last_error, retry_count, updated_at
      FROM sync_items
      WHERE sync_time = 0 AND sync_disabled = 0
      ORDER BY updated_at ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(limit) as SyncItemRow[];

    const items: SyncItem[] = [];
    const mutationIds = new Map<string, string>();

    for (const row of rows) {
      // Generate mutation_id if not present
      let mutationId = row.pending_mutation_id;
      if (!mutationId) {
        mutationId = crypto.randomUUID();
        // Update the row with the new mutation_id
        this.db
          .prepare(
            'UPDATE sync_items SET pending_mutation_id = ? WHERE entity_type = ? AND entity_id = ?'
          )
          .run(mutationId, row.entity_type, row.entity_id);
      }

      items.push(this.mapRowToItem(row));
      mutationIds.set(row.entity_id, mutationId);
    }

    return { items, mutationIds };
  }

  /**
   * Get pending items by entity type
   */
  getPendingItemsByType(entityType: SyncEntityType, limit: number = 100): SyncItem[] {
    const query = `
      SELECT entity_type, entity_id, sync_time, pending_mutation_id,
             sync_disabled, last_error, retry_count, updated_at
      FROM sync_items
      WHERE entity_type = ? AND sync_time = 0 AND sync_disabled = 0
      ORDER BY updated_at ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(entityType, limit) as SyncItemRow[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  /**
   * Mark an item as successfully synced
   *
   * @param entityType - Type of entity
   * @param entityId - UUID of the entity
   * @param serverTime - Server timestamp from sync response
   */
  markSynced(entityType: SyncEntityType, entityId: string, serverTime: number): void {
    const query = `
      UPDATE sync_items
      SET sync_time = ?, pending_mutation_id = NULL, last_error = NULL, retry_count = 0, updated_at = ?
      WHERE entity_type = ? AND entity_id = ?
    `;

    this.db.prepare(query).run(serverTime, Date.now(), entityType, entityId);

    logger.debug('[SyncItems] Marked entity synced', {
      entityType,
      entityId,
      serverTime,
    });
  }

  /**
   * Mark multiple items as synced in a single transaction
   */
  markSyncedBatch(
    items: Array<{ entityType: SyncEntityType; entityId: string }>,
    serverTime: number
  ): void {
    if (items.length === 0) return;

    this.transactionManager.execute(() => {
      for (const item of items) {
        this.markSynced(item.entityType, item.entityId, serverTime);
      }
    });

    logger.debug('[SyncItems] Marked batch synced', { count: items.length });
  }

  /**
   * Record a sync error for an item
   */
  recordError(entityType: SyncEntityType, entityId: string, error: string): void {
    const query = `
      UPDATE sync_items
      SET last_error = ?, retry_count = retry_count + 1, updated_at = ?
      WHERE entity_type = ? AND entity_id = ?
    `;

    this.db.prepare(query).run(error, Date.now(), entityType, entityId);

    logger.warn('[SyncItems] Recorded sync error', {
      entityType,
      entityId,
      error,
    });
  }

  /**
   * Disable sync for an entity (e.g., after too many failures)
   */
  disableSync(entityType: SyncEntityType, entityId: string, reason: string): void {
    const query = `
      UPDATE sync_items
      SET sync_disabled = 1, last_error = ?, updated_at = ?
      WHERE entity_type = ? AND entity_id = ?
    `;

    this.db.prepare(query).run(reason, Date.now(), entityType, entityId);

    logger.warn('[SyncItems] Disabled sync for entity', {
      entityType,
      entityId,
      reason,
    });
  }

  /**
   * Re-enable sync for an entity
   */
  enableSync(entityType: SyncEntityType, entityId: string): void {
    const query = `
      UPDATE sync_items
      SET sync_disabled = 0, last_error = NULL, retry_count = 0, updated_at = ?
      WHERE entity_type = ? AND entity_id = ?
    `;

    this.db.prepare(query).run(Date.now(), entityType, entityId);

    logger.info('[SyncItems] Re-enabled sync for entity', { entityType, entityId });
  }

  /**
   * Remove a sync item (e.g., when entity is permanently deleted)
   */
  remove(entityType: SyncEntityType, entityId: string): void {
    const query = 'DELETE FROM sync_items WHERE entity_type = ? AND entity_id = ?';
    this.db.prepare(query).run(entityType, entityId);

    logger.debug('[SyncItems] Removed sync item', { entityType, entityId });
  }

  /**
   * Get sync item by entity
   */
  getItem(entityType: SyncEntityType, entityId: string): SyncItem | null {
    const query = `
      SELECT entity_type, entity_id, sync_time, pending_mutation_id,
             sync_disabled, last_error, retry_count, updated_at
      FROM sync_items
      WHERE entity_type = ? AND entity_id = ?
    `;

    const row = this.db.prepare(query).get(entityType, entityId) as SyncItemRow | undefined;
    return row ? this.mapRowToItem(row) : null;
  }

  /**
   * Get count of pending items
   */
  getPendingCount(): number {
    const query =
      'SELECT COUNT(*) as count FROM sync_items WHERE sync_time = 0 AND sync_disabled = 0';
    const result = this.db.prepare(query).get() as { count: number };
    return result.count;
  }

  /**
   * Get count of pending items by entity type
   */
  getPendingCountByType(): Record<SyncEntityType, number> {
    const query = `
      SELECT entity_type, COUNT(*) as count
      FROM sync_items
      WHERE sync_time = 0 AND sync_disabled = 0
      GROUP BY entity_type
    `;

    const rows = this.db.prepare(query).all() as Array<{
      entity_type: SyncEntityType;
      count: number;
    }>;

    const counts: Record<SyncEntityType, number> = {
      binders: 0,
      notes: 0,
      transcriptions: 0,
      summaries: 0,
      tags: 0,
      note_tags: 0,
    };

    for (const row of rows) {
      counts[row.entity_type] = row.count;
    }

    return counts;
  }

  /**
   * Get count of disabled items
   */
  getDisabledCount(): number {
    const query = 'SELECT COUNT(*) as count FROM sync_items WHERE sync_disabled = 1';
    const result = this.db.prepare(query).get() as { count: number };
    return result.count;
  }

  /**
   * Get items with errors (for debugging/admin)
   */
  getItemsWithErrors(limit: number = 50): SyncItem[] {
    const query = `
      SELECT entity_type, entity_id, sync_time, pending_mutation_id,
             sync_disabled, last_error, retry_count, updated_at
      FROM sync_items
      WHERE last_error IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(limit) as SyncItemRow[];
    return rows.map((row) => this.mapRowToItem(row));
  }

  /**
   * Reset all sync items to pending (for full re-sync)
   */
  resetAllToPending(): void {
    const query = `
      UPDATE sync_items
      SET sync_time = 0, pending_mutation_id = NULL, last_error = NULL,
          retry_count = 0, sync_disabled = 0, updated_at = ?
    `;

    this.db.prepare(query).run(Date.now());

    logger.info('[SyncItems] Reset all items to pending');
  }

  /**
   * Clean up successfully synced items older than a threshold
   * Keeps the table size manageable
   */
  cleanupOldSyncedItems(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const query = 'DELETE FROM sync_items WHERE sync_time > 0 AND sync_time < ?';
    const result = this.db.prepare(query).run(cutoff);
    return result.changes;
  }

  /**
   * Get statistics about sync items
   */
  getStatistics(): {
    total: number;
    pending: number;
    synced: number;
    disabled: number;
    withErrors: number;
    byType: Record<SyncEntityType, { pending: number; synced: number }>;
  } {
    const totalQuery = 'SELECT COUNT(*) as count FROM sync_items';
    const pendingQuery =
      'SELECT COUNT(*) as count FROM sync_items WHERE sync_time = 0 AND sync_disabled = 0';
    const syncedQuery = 'SELECT COUNT(*) as count FROM sync_items WHERE sync_time > 0';
    const disabledQuery = 'SELECT COUNT(*) as count FROM sync_items WHERE sync_disabled = 1';
    const errorsQuery = 'SELECT COUNT(*) as count FROM sync_items WHERE last_error IS NOT NULL';

    const byTypeQuery = `
      SELECT entity_type,
             SUM(CASE WHEN sync_time = 0 AND sync_disabled = 0 THEN 1 ELSE 0 END) as pending,
             SUM(CASE WHEN sync_time > 0 THEN 1 ELSE 0 END) as synced
      FROM sync_items
      GROUP BY entity_type
    `;

    const total = (this.db.prepare(totalQuery).get() as { count: number }).count;
    const pending = (this.db.prepare(pendingQuery).get() as { count: number }).count;
    const synced = (this.db.prepare(syncedQuery).get() as { count: number }).count;
    const disabled = (this.db.prepare(disabledQuery).get() as { count: number }).count;
    const withErrors = (this.db.prepare(errorsQuery).get() as { count: number }).count;

    const byTypeRows = this.db.prepare(byTypeQuery).all() as Array<{
      entity_type: SyncEntityType;
      pending: number;
      synced: number;
    }>;

    const byType: Record<SyncEntityType, { pending: number; synced: number }> = {
      binders: { pending: 0, synced: 0 },
      notes: { pending: 0, synced: 0 },
      transcriptions: { pending: 0, synced: 0 },
      summaries: { pending: 0, synced: 0 },
      tags: { pending: 0, synced: 0 },
      note_tags: { pending: 0, synced: 0 },
    };

    for (const row of byTypeRows) {
      byType[row.entity_type] = { pending: row.pending, synced: row.synced };
    }

    return { total, pending, synced, disabled, withErrors, byType };
  }

  /**
   * Map database row to SyncItem interface
   */
  private mapRowToItem(row: SyncItemRow): SyncItem {
    return {
      entityType: row.entity_type,
      entityId: row.entity_id,
      syncTime: row.sync_time,
      pendingMutationId: row.pending_mutation_id,
      syncDisabled: row.sync_disabled === 1,
      lastError: row.last_error,
      retryCount: row.retry_count,
      updatedAt: row.updated_at,
    };
  }
}
