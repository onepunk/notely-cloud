/**
 * Cursor-Based Sync Protocol Types
 *
 * Type definitions for the cursor-based sync protocol as specified in SYNC_JOPLIN.md
 *
 * References:
 * - SYNC_JOPLIN.md#L262 (API shape)
 * - SYNC_JOPLIN_PHASE0_SPEC.md (Protocol specifications)
 */

import type { SyncEntityType } from '../../../storage/services/SyncItemsService';

// Re-export for convenience
export type { SyncEntityType };

/**
 * Entity types as plural strings (matches server CollectionType)
 */
export const SYNC_ENTITY_TYPES: SyncEntityType[] = [
  'binders',
  'notes',
  'transcriptions',
  'summaries',
  'tags',
  'note_tags',
];

/**
 * Dependency order for applying entities
 * Earlier entities must be applied first (e.g., binders before notes)
 */
export const ENTITY_DEPENDENCY_ORDER: SyncEntityType[] = [
  'binders',
  'notes',
  'transcriptions',
  'summaries',
  'tags',
  'note_tags',
];

// ============================================
// Request Types
// ============================================

/**
 * Push item in sync request
 * Reference: SYNC_JOPLIN.md#L262
 */
export interface SyncPushItem {
  /** Client-generated UUID for idempotency */
  mutation_id: string;
  /** Entity type (plural form) */
  entity_type: SyncEntityType;
  /** Entity UUID */
  entity_id: string;
  /** Operation type */
  op: 'upsert' | 'delete';
  /**
   * Base version for optimistic concurrency
   * - null for creates (entity.server_updated_at IS NULL)
   * - entity.sync_version for updates/deletes
   */
  base_version: number | null;
  /** Full entity data (for upsert operations) */
  entity?: Record<string, unknown>;
}

/**
 * Sync request to POST /api/sync
 * Reference: SYNC_JOPLIN.md#L262
 */
export interface CursorSyncRequest {
  /** Device UUID (persistent across sessions) */
  device_id: string;
  /** Device name for display */
  device_name?: string;
  /** Last known cursor (0 for first sync/snapshot) */
  cursor: number;
  /** Client's current time in ms (for skew detection) */
  client_time_ms: number;
  /** Items to push to server */
  push: SyncPushItem[];
  /** Max items to return in response (default 500, max 1000) */
  limit?: number;
  /** Snapshot pagination token (for cursor=0 full sync) */
  snapshot_token?: string | null;
}

// ============================================
// Response Types
// ============================================

/**
 * Result status for a pushed item
 * Reference: SYNC_JOPLIN_PHASE0_SPEC.md Section 7
 */
export type PushResultStatus = 'applied' | 'conflict' | 'rejected' | 'ignored';

/**
 * Conflict reasons
 */
export type ConflictReason = 'version_mismatch' | 'entity_exists' | 'entity_not_found';

/**
 * Rejection reasons
 */
export type RejectionReason =
  | 'validation_failed'
  | 'constraint_violation'
  | 'rate_limited'
  | 'idempotency_payload_mismatch';

/**
 * Result for a single pushed item
 * Reference: SYNC_JOPLIN.md#L282
 */
export interface SyncPushResult {
  /** Mutation ID from the request */
  mutation_id: string;
  /** Entity type */
  entity_type: SyncEntityType;
  /** Entity ID */
  entity_id: string;
  /** Result status */
  status: PushResultStatus;
  /** New version (for applied/ignored) */
  version?: number;
  /** Server timestamp (for applied/ignored) */
  server_updated_at?: number;
  /** Canonical entity ID if remapped (for tags) */
  canonical_entity_id?: string;
  /** Conflict reason (for conflict status) */
  reason?: ConflictReason | RejectionReason | string;
  /** Server's current version (for conflicts) */
  server_version?: number;
  /** Server's entity data (for conflicts) */
  server_entity?: Record<string, unknown>;
  /** Retry after (ms) for rate limiting */
  retry_after_ms?: number;
}

/**
 * Delta item from server (entity changed since cursor)
 * Reference: SYNC_JOPLIN.md#L271
 */
export interface SyncDeltaItem {
  /** Sequence number (cursor value) */
  seq: number;
  /** Entity type */
  entity_type: SyncEntityType;
  /** Entity ID */
  entity_id: string;
  /** Operation that created this change */
  op: 'upsert' | 'delete';
  /** Current version */
  version: number;
  /** Server timestamp */
  server_updated_at: number;
  /** Full entity data */
  entity: Record<string, unknown>;
}

/**
 * Sync response from POST /api/sync
 * Reference: SYNC_JOPLIN.md#L266
 */
export interface CursorSyncResponse {
  /** New cursor (last seq in items, or max seq for snapshot) */
  cursor: number;
  /** True if more items available */
  has_more: boolean;
  /** Delta items from server */
  items: SyncDeltaItem[];
  /** Results for each pushed item */
  results: SyncPushResult[];
  /** Server's current time in ms */
  server_time_ms: number;
  /** Computed clock skew (client - server) */
  device_time_skew_ms: number;
  /** True if clock skew > 5 minutes */
  clock_suspect: boolean;
  /** True if cursor expired and snapshot required */
  requires_snapshot?: boolean;
  /** Oldest available cursor (when requires_snapshot) */
  oldest_available_cursor?: number;
  /** Snapshot pagination token (for continuing snapshot) */
  snapshot_token?: string | null;
  /** True when snapshot is complete */
  snapshot_done?: boolean;
}

// ============================================
// Client-Side Types
// ============================================

/**
 * Configuration for the cursor sync engine
 */
export interface CursorSyncConfiguration {
  /** Base server URL */
  serverUrl: string;
  /** Sync service URL (derived from serverUrl) */
  syncServiceUrl: string;
  /** User ID */
  userId: string;
  /** Access token for authentication */
  accessToken: string;
  /** Device ID (persistent) */
  deviceId: string;
  /** Device name */
  deviceName?: string;
  /** Whether sync is enabled */
  enabled: boolean;
  /** Request timeout in ms */
  timeoutMs: number;
  /** Max items per push batch */
  maxPushBatchSize: number;
  /** Max items to request per pull */
  maxPullLimit: number;
}

/**
 * Result of a sync operation
 */
export interface CursorSyncResult {
  /** Whether sync completed successfully */
  success: boolean;
  /** Operation type */
  operation: 'push' | 'pull' | 'snapshot' | 'up_to_date';
  /** Duration in ms */
  duration_ms: number;
  /** Number of entities pushed */
  entities_pushed: number;
  /** Number of entities pulled */
  entities_pulled: number;
  /** Number of conflicts resolved */
  conflicts_resolved: number;
  /** New cursor after sync */
  new_cursor: number;
  /** Error message if failed */
  error?: string;
  /** User-friendly error message */
  userMessage?: string;
  /** Whether a snapshot was triggered */
  snapshot_triggered?: boolean;
  /** Number of orphan entities reconciled (reset for CREATE retry) */
  orphans_reconciled?: number;
}

/**
 * Entity data for building push payload
 */
export interface EntityForPush {
  /** Entity type */
  entityType: SyncEntityType;
  /** Entity ID */
  entityId: string;
  /** Operation */
  op: 'upsert' | 'delete';
  /** Base version (null for creates) */
  baseVersion: number | null;
  /** Full entity data */
  entity: Record<string, unknown>;
  /** Mutation ID for idempotency */
  mutationId: string;
}

/**
 * Conflict copy note data
 * Reference: SYNC_JOPLIN_PHASE0_SPEC.md Section 5
 */
export interface ConflictCopyNote {
  /** New UUID for conflict copy */
  id: string;
  /** ID of the canonical note */
  conflictOfId: string;
  /** Timestamp when conflict detected */
  conflictCreatedAt: number;
  /** Title for conflict copy */
  title: string;
  /** Content (losing version) */
  content: string;
  /** Binder ID (Conflicts binder) */
  binderId: string;
}

/**
 * Cursor state stored in sync_config
 */
export interface CursorState {
  /** Last known cursor */
  cursor: number;
  /** Last successful sync time */
  lastSyncAt: number | null;
  /** Last push time */
  lastPushAt: number | null;
  /** Last pull time */
  lastPullAt: number | null;
}
