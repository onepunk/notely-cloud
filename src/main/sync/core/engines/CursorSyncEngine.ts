/**
 * CursorSyncEngine - Cursor-based sync orchestrator
 *
 * Implements the cursor-based sync protocol with:
 * - Push queue via sync_items table
 * - Cursor-based delta pull
 * - Conflict handling with conflict copies
 * - Snapshot support for cursor expiry
 *
 * References:
 * - SYNC_JOPLIN.md#L363 (Client algorithm)
 * - SYNC_JOPLIN.md#L372 (Create vs update rule)
 * - SYNC_JOPLIN.md#L412 (Apply ordering)
 * - SYNC_JOPLIN.md#L397 (Conflicts)
 */

import crypto from 'node:crypto';

import { logger } from '../../../logger';
import type { IStorageService } from '../../../storage/interfaces';
import { SyncItemsService, type SyncEntityType } from '../../../storage/services/SyncItemsService';
import { CursorSyncApiClient } from '../../services/network/CursorSyncApiClient';
import type {
  CursorSyncConfiguration,
  CursorSyncResult,
  CursorSyncRequest,
  SyncPushItem,
  SyncDeltaItem,
  SyncPushResult,
} from '../protocol/cursor-sync-types';

/**
 * Dependencies for CursorSyncEngine
 */
export interface CursorSyncEngineDependencies {
  storage: IStorageService;
  syncItemsService: SyncItemsService;
}

/**
 * Cursor-based sync engine implementation
 */
export class CursorSyncEngine {
  private isInitialized = false;
  private isSyncing = false;
  private currentRunId: string | null = null;
  private apiClient: CursorSyncApiClient;

  /** Dependency order for applying entities */
  private static readonly APPLY_ORDER: SyncEntityType[] = [
    'binders',
    'notes',
    'transcriptions',
    'summaries',
    'tags',
    'note_tags',
  ];

  /**
   * Increment this to force a one-time snapshot + orphan reconciliation
   * on all existing clients during their next sync cycle.
   */
  private static readonly ORPHAN_RECONCILIATION_VERSION = 1;

  /**
   * Extract plaintext from a Lexical editor JSON string.
   * Used when the server returns content without a separate plaintext field.
   */
  private static extractPlaintextFromLexical(lexicalJson: string): string {
    try {
      const doc = JSON.parse(lexicalJson);
      return CursorSyncEngine.extractTextFromNode(doc.root).trimEnd();
    } catch {
      return '';
    }
  }

  private static extractTextFromNode(node: Record<string, unknown>): string {
    if (!node) return '';
    if (node.type === 'text') return (node.text as string) || '';
    const children = node.children as Record<string, unknown>[] | undefined;
    if (!children) return '';
    const parts: string[] = [];
    for (const child of children) {
      parts.push(CursorSyncEngine.extractTextFromNode(child));
    }
    const isBlock = ['paragraph', 'heading', 'quote', 'list-item', 'code'].includes(
      node.type as string
    );
    return parts.join('') + (isBlock ? '\n' : '');
  }

  constructor(
    private config: CursorSyncConfiguration,
    private deps: CursorSyncEngineDependencies
  ) {
    this.apiClient = CursorSyncApiClient.fromConfiguration(config);
  }

  /**
   * Initialize the sync engine
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    logger.info('[CursorSync] Initializing engine', {
      userId: this.config.userId,
      deviceId: this.config.deviceId,
      syncServiceUrl: this.config.syncServiceUrl,
    });

    this.isInitialized = true;
  }

  /**
   * Perform a complete sync operation
   *
   * Algorithm:
   * 1. Collect pending items from sync_items (sync_time = 0)
   * 2. Build push payload with entity data
   * 3. Send POST /api/sync with push + cursor
   * 4. Process push results (mark synced, handle conflicts)
   * 5. Apply pulled items in dependency order
   * 6. Update cursor
   * 7. Loop while has_more = true
   */
  async performSync(): Promise<CursorSyncResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (this.isSyncing) {
      logger.warn('[CursorSync] Sync already in progress');
      return {
        success: false,
        operation: 'push',
        duration_ms: 0,
        entities_pushed: 0,
        entities_pulled: 0,
        conflicts_resolved: 0,
        new_cursor: await this.getCursor(),
        error: 'SYNC_IN_PROGRESS',
        userMessage: 'Sync operation already in progress',
      };
    }

    const startTime = Date.now();
    this.currentRunId = crypto.randomUUID();
    this.isSyncing = true;

    let totalPushed = 0;
    let totalPulled = 0;
    let totalConflicts = 0;
    let newCursor = await this.getCursor();
    let snapshotTriggered = false;
    let totalOrphansReconciled = 0;

    // Check if orphan reconciliation is needed (forces a snapshot)
    const reconVersion = await this.getReconciliationVersion();
    const needsReconciliation = reconVersion < CursorSyncEngine.ORPHAN_RECONCILIATION_VERSION;

    try {
      if (needsReconciliation) {
        logger.info('[CursorSync] Orphan reconciliation required — forcing snapshot');
        newCursor = 0;
        await this.setCursor(0);
      }

      logger.info('[CursorSync] Starting sync', {
        runId: this.currentRunId,
        cursor: newCursor,
      });

      // Sync loop - continues while there's more data
      let hasMore = true;
      let snapshotToken: string | null = null;

      // Track if we're in snapshot mode (server-initiated: cursor expired)
      // Only enters true when server returns requires_snapshot — NOT for reconciliation.
      // Reconciliation uses cursor=0 which the server treats as a valid snapshot request,
      // but pushes are still safe to include alongside the pull.
      let inSnapshotMode = false;

      // During reconciliation, collect all entity IDs the server knows about.
      // This map is non-null only while reconciliation is in progress.
      let snapshotServerIds: Map<SyncEntityType, Set<string>> | null = needsReconciliation
        ? new Map()
        : null;

      while (hasMore) {
        // In snapshot mode (server-initiated): don't push until snapshot is complete
        // This prevents conflicts during snapshot pull
        const pushItems = inSnapshotMode ? [] : await this.collectPushItems();

        // Build sync request
        const request: CursorSyncRequest = {
          device_id: this.config.deviceId,
          device_name: this.config.deviceName,
          cursor: newCursor,
          client_time_ms: Date.now(),
          push: pushItems,
          limit: this.config.maxPullLimit,
          snapshot_token: snapshotToken,
        };

        // Send sync request
        const response = await this.apiClient.sync(request, this.currentRunId);

        // Handle snapshot requirement (server says our cursor is stale/expired)
        if (response.requires_snapshot) {
          logger.warn('[CursorSync] Server requires snapshot - entering snapshot mode', {
            oldestAvailableCursor: response.oldest_available_cursor,
            currentCursor: newCursor,
          });

          // Enter snapshot mode: reset cursor to 0 and pause pushes
          newCursor = 0;
          snapshotTriggered = true;
          snapshotToken = null;
          inSnapshotMode = true;
          hasMore = true; // Force another iteration to start snapshot pull
          continue;
        }

        // Check if server-initiated snapshot is complete (no more snapshot pages)
        if (inSnapshotMode && !response.snapshot_token && !response.has_more) {
          logger.info('[CursorSync] Snapshot complete, resuming normal sync');
          inSnapshotMode = false;
        }

        // Process push results
        const pushStats = await this.processPushResults(response.results);
        totalPushed += pushStats.applied;
        totalConflicts += pushStats.conflicts;

        // Apply pulled items
        const pullStats = await this.applyPulledItems(response.items);
        totalPulled += pullStats.applied;

        // During reconciliation, track which entity IDs the server sent
        // (uses snapshotServerIds as the guard — independent of inSnapshotMode)
        if (snapshotServerIds) {
          for (const item of response.items) {
            let typeSet = snapshotServerIds.get(item.entity_type);
            if (!typeSet) {
              typeSet = new Set();
              snapshotServerIds.set(item.entity_type, typeSet);
            }
            typeSet.add(item.entity_id);
          }
        }

        // Complete orphan reconciliation when the full pull finishes
        if (snapshotServerIds && !response.snapshot_token && !response.has_more) {
          const reconStats = await this.reconcileOrphansAfterSnapshot(snapshotServerIds);
          logger.info('[CursorSync] Orphan reconciliation complete', reconStats);
          totalOrphansReconciled = reconStats.orphansFound;
          await this.setReconciliationVersion(CursorSyncEngine.ORPHAN_RECONCILIATION_VERSION);
          snapshotServerIds = null;
        }

        // Update cursor
        newCursor = response.cursor;
        await this.setCursor(newCursor);

        // Check for more data
        hasMore = response.has_more;
        snapshotToken = response.snapshot_token || null;

        logger.debug('[CursorSync] Sync iteration complete', {
          newCursor,
          hasMore,
          pushed: pushStats.applied,
          pulled: pullStats.applied,
          conflicts: pushStats.conflicts,
        });
      }

      // Update last sync time
      await this.deps.storage.sync.setConfig({
        lastPullAt: Date.now(),
        lastPushAt: totalPushed > 0 ? Date.now() : undefined,
      });

      const result: CursorSyncResult = {
        success: true,
        operation: totalPushed > 0 ? 'push' : totalPulled > 0 ? 'pull' : 'up_to_date',
        duration_ms: Date.now() - startTime,
        entities_pushed: totalPushed,
        entities_pulled: totalPulled,
        conflicts_resolved: totalConflicts,
        new_cursor: newCursor,
        snapshot_triggered: snapshotTriggered,
        orphans_reconciled: totalOrphansReconciled > 0 ? totalOrphansReconciled : undefined,
      };

      logger.info('[CursorSync] Sync completed', result);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('[CursorSync] Sync failed', {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        runId: this.currentRunId,
        duration: Date.now() - startTime,
      });

      return {
        success: false,
        operation: 'push',
        duration_ms: Date.now() - startTime,
        entities_pushed: totalPushed,
        entities_pulled: totalPulled,
        conflicts_resolved: totalConflicts,
        new_cursor: newCursor,
        error: errorMessage,
        userMessage: `Sync failed: ${errorMessage}`,
      };
    } finally {
      this.isSyncing = false;
      this.currentRunId = null;
    }
  }

  /**
   * Collect pending items and build push payload
   */
  private async collectPushItems(): Promise<SyncPushItem[]> {
    const batch = this.deps.syncItemsService.getPendingItems(this.config.maxPushBatchSize);

    if (batch.items.length === 0) {
      return [];
    }

    const pushItems: SyncPushItem[] = [];

    for (const item of batch.items) {
      try {
        const entityData = await this.getEntityData(item.entityType, item.entityId);

        if (!entityData) {
          // Entity was deleted - create delete push
          pushItems.push({
            mutation_id: batch.mutationIds.get(item.entityId) || crypto.randomUUID(),
            entity_type: item.entityType,
            entity_id: item.entityId,
            op: 'delete',
            base_version: await this.getEntityBaseVersion(item.entityType, item.entityId),
          });
          continue;
        }

        // Determine operation type based on server_updated_at
        // Reference: SYNC_JOPLIN.md#L372
        const isCreate =
          entityData.server_updated_at === null || entityData.server_updated_at === undefined;
        const baseVersion = isCreate ? null : (entityData.sync_version as number) || null;

        pushItems.push({
          mutation_id: batch.mutationIds.get(item.entityId) || crypto.randomUUID(),
          entity_type: item.entityType,
          entity_id: item.entityId,
          op: 'upsert',
          base_version: baseVersion,
          entity: entityData,
        });
      } catch (error) {
        logger.error('[CursorSync] Failed to collect entity for push', {
          entityType: item.entityType,
          entityId: item.entityId,
          error: error instanceof Error ? error.message : String(error),
        });

        // Record error but continue with other items
        this.deps.syncItemsService.recordError(
          item.entityType,
          item.entityId,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    return pushItems;
  }

  /**
   * Get entity data from storage
   */
  private async getEntityData(
    entityType: SyncEntityType,
    entityId: string
  ): Promise<Record<string, unknown> | null> {
    const db = this.deps.storage.database.getDatabase();

    switch (entityType) {
      case 'binders': {
        const row = db.prepare('SELECT * FROM binders WHERE id = ?').get(entityId);
        return row ? (row as Record<string, unknown>) : null;
      }
      case 'notes': {
        const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(entityId) as
          | (Record<string, unknown> & { id: string })
          | undefined;
        if (!row) return null;

        // Pull latest revision so we send full content to the server
        const revision = db
          .prepare(
            `SELECT nr.lexical_json, nr.plaintext
             FROM note_revisions nr
             JOIN note_content_head nch ON nr.revision_id = nch.revision_id
             WHERE nch.note_id = ?`
          )
          .get(entityId) as { lexical_json?: string; plaintext?: string } | undefined;

        // Convert internal 'null' string to actual null for server
        // The string 'null' is used internally to represent empty content,
        // but the server expects either null or valid Lexical JSON object
        const lexicalContent = revision?.lexical_json;
        const contentForSync = lexicalContent && lexicalContent !== 'null' ? lexicalContent : null;

        return {
          ...row,
          content: contentForSync,
          notes: revision?.plaintext ?? null,
        };
      }
      case 'transcriptions': {
        const row = db
          .prepare('SELECT * FROM transcription_sessions WHERE id = ?')
          .get(entityId) as (Record<string, unknown> & { full_text?: string }) | undefined;
        if (!row) return null;

        return {
          ...row,
          transcription_text: row.full_text ?? '',
          text: row.full_text ?? '',
        };
      }
      case 'summaries': {
        // Join with transcription_sessions to get note_id
        // A summary belongs to a transcription, which belongs to a note
        const row = db
          .prepare(
            `SELECT s.*, t.note_id
             FROM summaries s
             JOIN transcription_sessions t ON s.transcription_id = t.id
             WHERE s.id = ?`
          )
          .get(entityId) as Record<string, unknown> | undefined;
        return row ?? null;
      }
      case 'tags': {
        const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(entityId);
        return row ? (row as Record<string, unknown>) : null;
      }
      case 'note_tags': {
        const row = db.prepare('SELECT * FROM note_tags WHERE id = ?').get(entityId);
        return row ? (row as Record<string, unknown>) : null;
      }
      default:
        return null;
    }
  }

  /**
   * Get base version for an entity (for updates/deletes)
   */
  private async getEntityBaseVersion(
    entityType: SyncEntityType,
    entityId: string
  ): Promise<number | null> {
    const entityData = await this.getEntityData(entityType, entityId);
    if (!entityData) return null;
    return (entityData.sync_version as number) || null;
  }

  /**
   * Process push results from server
   */
  private async processPushResults(
    results: SyncPushResult[]
  ): Promise<{ applied: number; conflicts: number; rejected: number }> {
    let applied = 0;
    let conflicts = 0;
    let rejected = 0;

    for (const result of results) {
      switch (result.status) {
        case 'applied':
        case 'ignored': {
          // Update entity with server version/timestamp
          if (result.version !== undefined && result.server_updated_at !== undefined) {
            await this.updateEntitySyncMetadata(
              result.entity_type,
              result.entity_id,
              result.version,
              result.server_updated_at
            );
          }

          // Mark sync item as synced
          this.deps.syncItemsService.markSynced(
            result.entity_type,
            result.entity_id,
            result.server_updated_at || Date.now()
          );

          // Handle canonical remapping when server deduplicates entities
          if (result.canonical_entity_id && result.canonical_entity_id !== result.entity_id) {
            await this.handleCanonicalRemap(
              result.entity_type,
              result.entity_id,
              result.canonical_entity_id
            );
          }

          applied++;
          break;
        }

        case 'conflict': {
          // Create conflict copy and apply server version
          await this.handleConflict(result);
          conflicts++;
          break;
        }

        case 'rejected': {
          // Log and mark for retry (with backoff)
          logger.warn('[CursorSync] Push rejected', {
            entityType: result.entity_type,
            entityId: result.entity_id,
            reason: result.reason,
          });

          this.deps.syncItemsService.recordError(
            result.entity_type,
            result.entity_id,
            result.reason || 'Push rejected by server'
          );

          rejected++;
          break;
        }
      }
    }

    return { applied, conflicts, rejected };
  }

  /**
   * Apply pulled items from server in dependency order
   */
  private async applyPulledItems(items: SyncDeltaItem[]): Promise<{ applied: number }> {
    if (items.length === 0) {
      return { applied: 0 };
    }

    // Group items by entity type
    const byType = new Map<SyncEntityType, SyncDeltaItem[]>();
    for (const item of items) {
      const list = byType.get(item.entity_type) || [];
      list.push(item);
      byType.set(item.entity_type, list);
    }

    let applied = 0;

    // Apply in dependency order
    for (const entityType of CursorSyncEngine.APPLY_ORDER) {
      const typeItems = byType.get(entityType);
      if (!typeItems || typeItems.length === 0) continue;

      for (const item of typeItems) {
        try {
          await this.applyDeltaItem(item);
          applied++;
        } catch (error) {
          logger.error('[CursorSync] Failed to apply delta item', {
            entityType: item.entity_type,
            entityId: item.entity_id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { applied };
  }

  /**
   * Apply a single delta item from server
   */
  private async applyDeltaItem(item: SyncDeltaItem): Promise<void> {
    const db = this.deps.storage.database.getDatabase();

    if (item.op === 'delete') {
      // Soft delete the entity with version metadata
      await this.softDeleteEntity(
        item.entity_type,
        item.entity_id,
        item.version,
        item.server_updated_at
      );
      return;
    }

    // Upsert the entity with version from the SyncItem (not from entity object)
    switch (item.entity_type) {
      case 'binders':
        await this.upsertBinder(item.entity, item.version, item.server_updated_at);
        break;
      case 'notes':
        await this.upsertNote(item.entity, item.version, item.server_updated_at);
        break;
      case 'transcriptions':
        await this.upsertTranscription(item.entity, item.version, item.server_updated_at);
        break;
      case 'summaries':
        await this.upsertSummary(item.entity, item.version, item.server_updated_at);
        break;
      case 'tags':
        await this.upsertTag(item.entity, item.version, item.server_updated_at);
        break;
      case 'note_tags':
        await this.upsertNoteTag(item.entity, item.version, item.server_updated_at);
        break;
    }

    // Mark as synced in sync_items (so we don't push it back)
    this.deps.syncItemsService.markSynced(item.entity_type, item.entity_id, item.server_updated_at);
  }

  /**
   * Update entity sync metadata after successful push
   */
  private async updateEntitySyncMetadata(
    entityType: SyncEntityType,
    entityId: string,
    version: number,
    serverUpdatedAt: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();

    const tableMap: Record<SyncEntityType, string> = {
      binders: 'binders',
      notes: 'notes',
      transcriptions: 'transcription_sessions',
      summaries: 'summaries',
      tags: 'tags',
      note_tags: 'note_tags',
    };

    const table = tableMap[entityType];
    if (!table) return;

    db.prepare(`UPDATE ${table} SET sync_version = ?, server_updated_at = ? WHERE id = ?`).run(
      version,
      serverUpdatedAt,
      entityId
    );
  }

  /**
   * Handle canonical remapping for entities the server deduplicates
   */
  private async handleCanonicalRemap(
    entityType: SyncEntityType,
    localId: string,
    canonicalId: string
  ): Promise<void> {
    if (entityType === 'tags') {
      await this.handleTagRemap(localId, canonicalId);
      return;
    }

    if (entityType === 'binders') {
      await this.handleBinderRemap(localId, canonicalId);
    }
  }

  /**
   * Handle tag remapping (when server deduplicates case-insensitive tags)
   */
  private async handleTagRemap(localId: string, canonicalId: string): Promise<void> {
    const db = this.deps.storage.database.getDatabase();

    logger.info('[CursorSync] Remapping tag', { localId, canonicalId });

    // Update all note_tags to point to canonical tag
    db.prepare('UPDATE note_tags SET tag_id = ? WHERE tag_id = ?').run(canonicalId, localId);

    // Remove the duplicate local tag
    db.prepare('DELETE FROM tags WHERE id = ?').run(localId);

    // Remove sync item for old tag
    this.deps.syncItemsService.remove('tags', localId);
  }

  /**
   * Handle conflicts binder deduplication (server canonical binder already exists)
   *
   * Strategy: soft-delete the local binder first to clear the partial unique index
   * (idx_binders_conflicts_unique), then create/verify the canonical binder, repoint
   * children, and hard-delete the old local binder.
   */
  private async handleBinderRemap(localId: string, canonicalId: string): Promise<void> {
    const db = this.deps.storage.database.getDatabase();

    logger.info('[CursorSync] Remapping binder', { localId, canonicalId });

    // Step 1: Soft-delete local binder to clear the unique index
    // (sets deleted=1 and is_conflicts=0 so the partial unique index no longer matches)
    db.prepare('UPDATE binders SET deleted = 1, is_conflicts = 0, updated_at = ? WHERE id = ?').run(
      Date.now(),
      localId
    );

    // Step 2: Create canonical binder if not yet present (now safe — unique index is clear)
    const canonicalExists = db.prepare('SELECT 1 FROM binders WHERE id = ?').get(canonicalId);
    if (!canonicalExists) {
      const userProfileId = this.getLocalUserProfileId();
      db.prepare(
        `INSERT INTO binders (id, user_profile_id, name, color, binder_type, is_conflicts, deleted, sync_version, server_updated_at, created_at, updated_at)
         VALUES (?, ?, 'Conflicts', NULL, 'SYSTEM', 1, 0, 1, ?, ?, ?)`
      ).run(canonicalId, userProfileId, Date.now(), Date.now(), Date.now());
    }

    // Step 3: Repoint children to canonical binder
    db.prepare('UPDATE notes SET binder_id = ? WHERE binder_id = ?').run(canonicalId, localId);
    db.prepare('UPDATE transcription_sessions SET binder_id = ? WHERE binder_id = ?').run(
      canonicalId,
      localId
    );
    // NOTE: summaries table has NO binder_id column — removed invalid UPDATE

    // Step 4: Hard-delete old local binder + remove sync item
    db.prepare('DELETE FROM binders WHERE id = ?').run(localId);
    this.deps.syncItemsService.remove('binders', localId);
  }

  /**
   * Handle conflict - create conflict copy and apply server version
   * Reference: SYNC_JOPLIN.md#L397, SYNC_JOPLIN.md#L427
   *
   * For ALL entity types, the losing local edit is preserved as a conflict-copy NOTE
   * in the Conflicts binder. The canonical entity is updated to the server version.
   */
  private async handleConflict(result: SyncPushResult): Promise<void> {
    // entity_not_found: The client tried to UPDATE an entity the server doesn't have.
    // This happens with pre-sync entities that were created before cursor-based sync was active.
    // Fix: Reset server_updated_at to NULL so the next sync cycle pushes it as CREATE
    // (base_version: null). The server will accept the full entity including its deleted flag,
    // allowing other clients to discover the entity's current state.
    if (result.reason === 'entity_not_found') {
      logger.info('[CursorSync] entity_not_found — resetting to CREATE for retry', {
        entityType: result.entity_type,
        entityId: result.entity_id,
      });

      await this.updateEntitySyncMetadata(
        result.entity_type,
        result.entity_id,
        1, // reset version to 1
        0 // clear server_updated_at (0 treated as unset; NULL via direct SQL below)
      );

      // Set server_updated_at to actual NULL (updateEntitySyncMetadata sets it to 0)
      const db = this.deps.storage.database.getDatabase();
      const tableMap: Record<SyncEntityType, string> = {
        binders: 'binders',
        notes: 'notes',
        transcriptions: 'transcription_sessions',
        summaries: 'summaries',
        tags: 'tags',
        note_tags: 'note_tags',
      };
      const table = tableMap[result.entity_type];
      if (table) {
        db.prepare(
          `UPDATE ${table} SET server_updated_at = NULL, sync_version = 1 WHERE id = ?`
        ).run(result.entity_id);
      }

      // Re-mark as dirty so the next sync cycle retries as CREATE
      this.deps.syncItemsService.markDirty(result.entity_type, result.entity_id);

      logger.info('[CursorSync] Entity reset for CREATE retry', {
        entityType: result.entity_type,
        entityId: result.entity_id,
      });
      return;
    }

    // Get local entity data before it's overwritten
    const localEntity = await this.getEntityData(result.entity_type, result.entity_id);

    if (result.entity_type === 'notes') {
      // For notes: create conflict copy note with the local content
      await this.createNoteConflictCopy(result, localEntity);
    } else if (result.entity_type === 'transcriptions' || result.entity_type === 'summaries') {
      // For transcriptions/summaries: create conflict copy NOTE containing the losing content
      await this.createNonNoteConflictCopy(result, localEntity);
    }
    // For tags/note_tags/binders: just accept server version (no user-editable content to preserve)

    // Apply server version to canonical entity
    if (result.server_entity) {
      await this.applyDeltaItem({
        seq: 0,
        entity_type: result.entity_type,
        entity_id: result.entity_id,
        op: 'upsert',
        version: result.server_version || 0,
        server_updated_at: result.server_updated_at || Date.now(),
        entity: result.server_entity,
      });
    }

    // Mark the ORIGINAL entity's sync item as synced (server version now applied)
    this.deps.syncItemsService.markSynced(
      result.entity_type,
      result.entity_id,
      result.server_updated_at || Date.now()
    );

    logger.info('[CursorSync] Conflict resolved', {
      entityType: result.entity_type,
      entityId: result.entity_id,
      serverVersion: result.server_version,
    });
  }

  /**
   * Create conflict copy note for a note entity
   */
  private async createNoteConflictCopy(
    result: SyncPushResult,
    localEntity: Record<string, unknown> | null
  ): Promise<void> {
    if (!localEntity) return;

    // Get or create Conflicts binder
    const conflictsBinder = await this.getOrCreateConflictsBinder();

    // Create conflict copy note
    const conflictCopyId = crypto.randomUUID();
    const now = Date.now();

    const db = this.deps.storage.database.getDatabase();
    db.prepare(
      `
      INSERT INTO notes (id, binder_id, title, created_at, updated_at, is_conflict, conflict_of_id, conflict_created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `
    ).run(
      conflictCopyId,
      conflictsBinder.id,
      `[Conflict] ${localEntity.title || 'Untitled'}`,
      now,
      now,
      result.entity_id,
      now
    );

    // Copy note content
    const content = db
      .prepare('SELECT * FROM note_content_head WHERE note_id = ?')
      .get(result.entity_id);
    if (content) {
      // Get the revision
      const revision = db
        .prepare('SELECT * FROM note_revisions WHERE revision_id = ?')
        .get((content as { revision_id: number }).revision_id);
      if (revision) {
        // Create new revision for conflict copy
        const revisionResult = db
          .prepare(
            `
          INSERT INTO note_revisions (note_id, lexical_json, plaintext, hash, created_at)
          VALUES (?, ?, ?, ?, ?)
        `
          )
          .run(
            conflictCopyId,
            (revision as { lexical_json: string }).lexical_json,
            (revision as { plaintext: string }).plaintext,
            (revision as { hash: string }).hash,
            now
          );

        // Point head to revision
        db.prepare('INSERT INTO note_content_head (note_id, revision_id) VALUES (?, ?)').run(
          conflictCopyId,
          revisionResult.lastInsertRowid
        );
      }
    }

    // Mark conflict copy for sync
    this.deps.syncItemsService.markDirty('notes', conflictCopyId);

    logger.info('[CursorSync] Created note conflict copy', {
      originalId: result.entity_id,
      conflictCopyId,
      conflictsBinder: conflictsBinder.id,
    });
  }

  /**
   * Create conflict copy NOTE for non-note entities (transcriptions, summaries)
   * The losing local content is preserved as a note in the Conflicts binder
   */
  private async createNonNoteConflictCopy(
    result: SyncPushResult,
    localEntity: Record<string, unknown> | null
  ): Promise<void> {
    if (!localEntity) return;

    const conflictsBinder = await this.getOrCreateConflictsBinder();
    const conflictNoteId = crypto.randomUUID();
    const now = Date.now();

    const db = this.deps.storage.database.getDatabase();

    // Build conflict note content based on entity type
    let title: string;
    let content: string;

    if (result.entity_type === 'transcriptions') {
      title = `[Conflict] Transcription ${result.entity_id.substring(0, 8)}`;
      content = (localEntity.full_text as string) || (localEntity.original_text as string) || '';
    } else if (result.entity_type === 'summaries') {
      title = `[Conflict] Summary ${result.entity_id.substring(0, 8)}`;
      content = (localEntity.summary_text as string) || '';
    } else {
      return; // Unsupported entity type
    }

    // Create the conflict copy note
    db.prepare(
      `
      INSERT INTO notes (id, binder_id, title, created_at, updated_at, is_conflict, conflict_of_id, conflict_created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `
    ).run(
      conflictNoteId,
      conflictsBinder.id,
      title,
      now,
      now,
      result.entity_id, // Reference to original entity (even though it's not a note)
      now
    );

    // Create note content with the losing transcription/summary text
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    const lexicalJson = JSON.stringify({
      root: {
        children: [{ children: [{ text: content }], type: 'paragraph' }],
        type: 'root',
      },
    });

    const revisionResult = db
      .prepare(
        `
      INSERT INTO note_revisions (note_id, lexical_json, plaintext, hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(conflictNoteId, lexicalJson, content, hash, now);

    db.prepare('INSERT INTO note_content_head (note_id, revision_id) VALUES (?, ?)').run(
      conflictNoteId,
      revisionResult.lastInsertRowid
    );

    // Mark conflict note for sync
    this.deps.syncItemsService.markDirty('notes', conflictNoteId);

    logger.info('[CursorSync] Created non-note conflict copy', {
      entityType: result.entity_type,
      originalId: result.entity_id,
      conflictNoteId,
      conflictsBinder: conflictsBinder.id,
    });
  }

  /**
   * Get or create the Conflicts binder
   */
  private async getOrCreateConflictsBinder(): Promise<{ id: string; name: string }> {
    const db = this.deps.storage.database.getDatabase();

    // Try to find existing Conflicts binder
    const existing = db
      .prepare('SELECT id, name FROM binders WHERE is_conflicts = 1 AND deleted = 0 LIMIT 1')
      .get() as { id: string; name: string } | undefined;

    if (existing) {
      return existing;
    }

    // Get current user profile
    const userProfile = db.prepare('SELECT id FROM user_profiles LIMIT 1').get() as
      | { id: string }
      | undefined;

    if (!userProfile) {
      throw new Error('No user profile found');
    }

    // Create new Conflicts binder
    const id = crypto.randomUUID();
    const now = Date.now();

    db.prepare(
      `
      INSERT INTO binders (id, user_profile_id, name, binder_type, is_conflicts, created_at, updated_at)
      VALUES (?, ?, ?, 'SYSTEM', 1, ?, ?)
    `
    ).run(id, userProfile.id, 'Conflicts', now, now);

    // Mark for sync
    this.deps.syncItemsService.markDirty('binders', id);

    logger.info('[CursorSync] Created Conflicts binder', { id });

    return { id, name: 'Conflicts' };
  }

  /**
   * Get the local user profile ID for synced entities
   * Server entities don't include user_profile_id, so we inject the local one
   */
  private getLocalUserProfileId(): string {
    const db = this.deps.storage.database.getDatabase();
    const userProfile = db.prepare('SELECT id FROM user_profiles LIMIT 1').get() as
      | { id: string }
      | undefined;

    if (!userProfile) {
      throw new Error('No user profile found');
    }

    return userProfile.id;
  }

  /**
   * Soft delete an entity (from server delta)
   * Also updates sync metadata to prevent re-pushing the now-deleted entity
   */
  private async softDeleteEntity(
    entityType: SyncEntityType,
    entityId: string,
    version?: number,
    serverUpdatedAt?: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();
    const now = Date.now();

    const tableMap: Record<SyncEntityType, string> = {
      binders: 'binders',
      notes: 'notes',
      transcriptions: 'transcription_sessions',
      summaries: 'summaries',
      tags: 'tags',
      note_tags: 'note_tags',
    };

    const table = tableMap[entityType];
    if (!table) return;

    // Update deleted flag along with sync metadata
    db.prepare(
      `UPDATE ${table} SET deleted = 1, updated_at = ?, sync_version = ?, server_updated_at = ? WHERE id = ?`
    ).run(now, version || 1, serverUpdatedAt || now, entityId);
  }

  // ============================================
  // Entity Upsert Methods
  // ============================================

  private async upsertBinder(
    entity: Record<string, unknown>,
    version: number,
    serverUpdatedAt: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();
    // Server doesn't send user_profile_id, inject local one
    const userProfileId = this.getLocalUserProfileId();

    // Normalize boolean values to integers (SQLite doesn't accept JS booleans)
    const toInt = (val: unknown): number => (val ? 1 : 0);

    // Before inserting a conflicts binder, check if a different local conflicts binder
    // already exists. The partial unique index enforces one non-deleted conflicts binder
    // per user, so we must remove the old one first to avoid a UNIQUE constraint violation.
    const isConflictsBinder = toInt(entity.is_conflicts) === 1 && toInt(entity.deleted) === 0;
    if (isConflictsBinder) {
      const existing = db
        .prepare(
          'SELECT id FROM binders WHERE user_profile_id = ? AND is_conflicts = 1 AND deleted = 0 AND id != ?'
        )
        .get(userProfileId, entity.id) as { id: string } | undefined;

      if (existing) {
        logger.info('[CursorSync] Replacing local conflicts binder with canonical', {
          oldId: existing.id,
          newId: entity.id as string,
        });
        db.prepare('UPDATE notes SET binder_id = ? WHERE binder_id = ?').run(
          entity.id,
          existing.id
        );
        db.prepare('UPDATE transcription_sessions SET binder_id = ? WHERE binder_id = ?').run(
          entity.id,
          existing.id
        );
        db.prepare('DELETE FROM binders WHERE id = ?').run(existing.id);
        this.deps.syncItemsService.remove('binders', existing.id);
      }
    }

    db.prepare(
      `
      INSERT INTO binders (id, user_profile_id, name, color, binder_type, is_conflicts, deleted, sync_version, server_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_profile_id = excluded.user_profile_id,
        name = excluded.name,
        color = excluded.color,
        binder_type = excluded.binder_type,
        is_conflicts = excluded.is_conflicts,
        deleted = excluded.deleted,
        sync_version = excluded.sync_version,
        server_updated_at = excluded.server_updated_at,
        updated_at = excluded.updated_at
    `
    ).run(
      entity.id,
      userProfileId,
      entity.name,
      entity.color || null,
      entity.binder_type || 'USER',
      toInt(entity.is_conflicts),
      toInt(entity.deleted),
      version,
      serverUpdatedAt,
      entity.created_at || Date.now(),
      entity.updated_at || Date.now()
    );
  }

  private async upsertNote(
    entity: Record<string, unknown>,
    version: number,
    serverUpdatedAt: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();

    // Normalize boolean values to integers (SQLite doesn't accept JS booleans)
    const toInt = (val: unknown): number => (val ? 1 : 0);

    db.prepare(
      `
      INSERT INTO notes (id, binder_id, title, pinned, starred, archived, deleted, is_conflict, conflict_of_id, conflict_created_at, sync_version, server_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        binder_id = excluded.binder_id,
        title = excluded.title,
        pinned = excluded.pinned,
        starred = excluded.starred,
        archived = excluded.archived,
        deleted = excluded.deleted,
        is_conflict = excluded.is_conflict,
        conflict_of_id = excluded.conflict_of_id,
        conflict_created_at = excluded.conflict_created_at,
        sync_version = excluded.sync_version,
        server_updated_at = excluded.server_updated_at,
        updated_at = excluded.updated_at
    `
    ).run(
      entity.id,
      entity.binder_id,
      entity.title || '',
      toInt(entity.pinned),
      toInt(entity.starred),
      toInt(entity.archived),
      toInt(entity.deleted),
      toInt(entity.is_conflict),
      entity.conflict_of_id || null,
      entity.conflict_created_at || null,
      version,
      serverUpdatedAt,
      entity.created_at || Date.now(),
      entity.updated_at || Date.now()
    );

    // Also create/update note content (revisions + head pointer)
    // Server sends 'content' (lexical_json) — plaintext is NOT included in the response.
    // If the server doesn't provide plaintext, extract it from the Lexical JSON.
    const content = (entity.content as string) || 'null';
    let plaintext = (entity.notes as string) || '';
    if (!plaintext && content !== 'null') {
      plaintext = CursorSyncEngine.extractPlaintextFromLexical(content);
    }
    const noteId = entity.id as string;
    const now = entity.updated_at || Date.now();

    // Compute content hash
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // Check if we already have this exact content (by hash) to avoid duplicate revisions
    const existingRevision = db
      .prepare(
        `SELECT r.revision_id FROM note_revisions r
         JOIN note_content_head h ON h.revision_id = r.revision_id
         WHERE h.note_id = ? AND r.hash = ?`
      )
      .get(noteId, hash) as { revision_id: number } | undefined;

    if (!existingRevision) {
      // Create new revision
      const revisionResult = db
        .prepare(
          `INSERT INTO note_revisions (note_id, lexical_json, plaintext, hash, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(noteId, content, plaintext, hash, now);

      // Update or create head pointer
      db.prepare(
        `INSERT INTO note_content_head (note_id, revision_id)
         VALUES (?, ?)
         ON CONFLICT(note_id) DO UPDATE SET revision_id = excluded.revision_id`
      ).run(noteId, revisionResult.lastInsertRowid);

      logger.debug('[CursorSync] Created note content revision', {
        noteId,
        revisionId: revisionResult.lastInsertRowid,
        contentLength: content.length,
      });
    }
  }

  private async upsertTranscription(
    entity: Record<string, unknown>,
    version: number,
    serverUpdatedAt: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();
    // logger is imported at module level

    // Normalize boolean values to integers (SQLite doesn't accept JS booleans)
    const toInt = (val: unknown): number => (val ? 1 : 0);

    // Server must provide binder_id - it's a required field
    if (!entity.binder_id) {
      logger.warn('[CursorSync] Cannot apply transcription - missing binder_id from server', {
        entityId: entity.id,
        noteId: entity.note_id,
      });
      return;
    }

    db.prepare(
      `
      INSERT INTO transcription_sessions (id, binder_id, note_id, language, status, start_time, end_time, duration_ms, char_count, word_count, full_text, original_text, user_edited, deleted, sync_version, server_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        binder_id = excluded.binder_id,
        note_id = excluded.note_id,
        language = excluded.language,
        status = excluded.status,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        duration_ms = excluded.duration_ms,
        char_count = excluded.char_count,
        word_count = excluded.word_count,
        full_text = excluded.full_text,
        original_text = excluded.original_text,
        user_edited = excluded.user_edited,
        deleted = excluded.deleted,
        sync_version = excluded.sync_version,
        server_updated_at = excluded.server_updated_at,
        updated_at = excluded.updated_at
    `
    ).run(
      entity.id,
      entity.binder_id,
      entity.note_id,
      entity.language || 'en',
      entity.status || 'completed',
      entity.start_time || Date.now(),
      entity.end_time || null,
      entity.duration_ms || null,
      entity.char_count || 0,
      entity.word_count || 0,
      entity.full_text || '',
      entity.original_text || null,
      toInt(entity.user_edited),
      toInt(entity.deleted),
      version,
      serverUpdatedAt,
      entity.created_at || Date.now(),
      entity.updated_at || Date.now()
    );
  }

  private async upsertSummary(
    entity: Record<string, unknown>,
    version: number,
    serverUpdatedAt: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();

    // Normalize boolean values to integers (SQLite doesn't accept JS booleans)
    const toInt = (val: unknown): number => (val ? 1 : 0);

    db.prepare(
      `
      INSERT INTO summaries (id, transcription_id, summary_text, summary_type, processing_time_ms, model_used, backend_type, pipeline_used, deleted, sync_version, server_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        transcription_id = excluded.transcription_id,
        summary_text = excluded.summary_text,
        summary_type = excluded.summary_type,
        processing_time_ms = excluded.processing_time_ms,
        model_used = excluded.model_used,
        backend_type = excluded.backend_type,
        pipeline_used = excluded.pipeline_used,
        deleted = excluded.deleted,
        sync_version = excluded.sync_version,
        server_updated_at = excluded.server_updated_at,
        updated_at = excluded.updated_at
    `
    ).run(
      entity.id,
      entity.transcription_id,
      entity.summary_text || null,
      entity.summary_type || 'full',
      entity.processing_time_ms || null,
      entity.model_used || null,
      entity.backend_type || null,
      toInt(entity.pipeline_used),
      toInt(entity.deleted),
      version,
      serverUpdatedAt,
      entity.created_at || Date.now(),
      entity.updated_at || Date.now()
    );
  }

  private async upsertTag(
    entity: Record<string, unknown>,
    version: number,
    serverUpdatedAt: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();
    // Server doesn't send user_profile_id, inject local one
    const userProfileId = this.getLocalUserProfileId();

    // Normalize boolean values to integers (SQLite doesn't accept JS booleans)
    const toInt = (val: unknown): number => (val ? 1 : 0);

    db.prepare(
      `
      INSERT INTO tags (id, user_profile_id, name, color, deleted, sync_version, server_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        user_profile_id = excluded.user_profile_id,
        name = excluded.name,
        color = excluded.color,
        deleted = excluded.deleted,
        sync_version = excluded.sync_version,
        server_updated_at = excluded.server_updated_at,
        updated_at = excluded.updated_at
    `
    ).run(
      entity.id,
      userProfileId,
      entity.name,
      entity.color || null,
      toInt(entity.deleted),
      version,
      serverUpdatedAt,
      entity.created_at || Date.now(),
      entity.updated_at || Date.now()
    );
  }

  private async upsertNoteTag(
    entity: Record<string, unknown>,
    version: number,
    serverUpdatedAt: number
  ): Promise<void> {
    const db = this.deps.storage.database.getDatabase();

    // Normalize boolean values to integers (SQLite doesn't accept JS booleans)
    const toInt = (val: unknown): number => (val ? 1 : 0);

    db.prepare(
      `
      INSERT INTO note_tags (id, note_id, tag_id, deleted, sync_version, server_updated_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        note_id = excluded.note_id,
        tag_id = excluded.tag_id,
        deleted = excluded.deleted,
        sync_version = excluded.sync_version,
        server_updated_at = excluded.server_updated_at,
        updated_at = excluded.updated_at
    `
    ).run(
      entity.id,
      entity.note_id,
      entity.tag_id,
      toInt(entity.deleted),
      version,
      serverUpdatedAt,
      entity.created_at || Date.now(),
      entity.updated_at || Date.now()
    );
  }

  // ============================================
  // Orphan Reconciliation
  // ============================================

  /**
   * After a full snapshot, compare local entities against what the server sent.
   * Any local entity with server_updated_at IS NOT NULL that was NOT in the
   * server's snapshot is an orphan — reset it for CREATE retry.
   */
  private async reconcileOrphansAfterSnapshot(
    serverEntityIds: Map<SyncEntityType, Set<string>>
  ): Promise<{ orphansFound: number; byType: Record<string, number> }> {
    const db = this.deps.storage.database.getDatabase();

    const tableMap: Record<SyncEntityType, string> = {
      binders: 'binders',
      notes: 'notes',
      transcriptions: 'transcription_sessions',
      summaries: 'summaries',
      tags: 'tags',
      note_tags: 'note_tags',
    };

    const byType: Record<string, number> = {};
    let orphansFound = 0;

    for (const entityType of CursorSyncEngine.APPLY_ORDER) {
      const table = tableMap[entityType];
      const serverIds = serverEntityIds.get(entityType) || new Set();

      // Find local entities that claim to be synced (server_updated_at IS NOT NULL)
      const localSynced = db
        .prepare(`SELECT id FROM ${table} WHERE server_updated_at IS NOT NULL`)
        .all() as Array<{ id: string }>;

      // Orphans: locally synced but not in the server snapshot
      const orphanIds = localSynced.filter((r) => !serverIds.has(r.id)).map((r) => r.id);
      if (orphanIds.length === 0) continue;

      logger.warn('[CursorSync] Found orphan entities', {
        entityType,
        count: orphanIds.length,
      });

      // Reset orphans: clear server_updated_at so next push treats them as CREATE
      const resetStmt = db.prepare(
        `UPDATE ${table} SET server_updated_at = NULL, sync_version = 1 WHERE id = ?`
      );
      const resetTx = db.transaction((ids: string[]) => {
        for (const id of ids) {
          resetStmt.run(id);
          this.deps.syncItemsService.markDirty(entityType, id);
        }
      });
      resetTx(orphanIds);

      byType[entityType] = orphanIds.length;
      orphansFound += orphanIds.length;
    }

    return { orphansFound, byType };
  }

  /**
   * Get the orphan reconciliation version from sync_config
   */
  private async getReconciliationVersion(): Promise<number> {
    const db = this.deps.storage.database.getDatabase();
    const row = db
      .prepare("SELECT value FROM sync_config WHERE key = 'orphan_reconciliation_version'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /**
   * Set the orphan reconciliation version in sync_config
   */
  private async setReconciliationVersion(version: number): Promise<void> {
    const db = this.deps.storage.database.getDatabase();
    db.prepare(
      "INSERT OR REPLACE INTO sync_config (key, value) VALUES ('orphan_reconciliation_version', ?)"
    ).run(String(version));
  }

  // ============================================
  // Cursor Management
  // ============================================

  /**
   * Get current cursor from sync_config (key-value table)
   */
  private async getCursor(): Promise<number> {
    const db = this.deps.storage.database.getDatabase();
    const row = db.prepare("SELECT value FROM sync_config WHERE key = 'cursor'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  /**
   * Update cursor in sync_config (key-value table)
   */
  private async setCursor(cursor: number): Promise<void> {
    const db = this.deps.storage.database.getDatabase();
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('cursor', ?)").run(
      String(cursor)
    );
    db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('updated_at', ?)").run(
      String(Date.now())
    );
  }

  // ============================================
  // Lifecycle
  // ============================================

  /**
   * Update configuration (e.g., after token refresh)
   */
  updateConfiguration(config: Partial<CursorSyncConfiguration>): void {
    this.config = { ...this.config, ...config };

    if (config.accessToken || config.syncServiceUrl || config.deviceId) {
      this.apiClient.updateConfiguration({
        syncServiceUrl: this.config.syncServiceUrl,
        accessToken: this.config.accessToken,
        deviceId: this.config.deviceId,
        timeoutMs: this.config.timeoutMs,
      });
    }

    logger.info('[CursorSync] Configuration updated');
  }

  /**
   * Shutdown the engine
   */
  async shutdown(): Promise<void> {
    this.isInitialized = false;
    logger.info('[CursorSync] Engine shutdown');
  }
}
