/**
 * Minimal sync service interface for cursor-based sync
 *
 * This interface provides access to sync configuration stored in sync_config table.
 * The Merkle-based sync methods have been removed in favor of cursor-based sync.
 *
 * NOTE: Auth fields are NOT part of sync config - use AuthService for auth-related data.
 */

import type {
  SyncConfig,
  UpdateSyncConfigInput,
  SyncOperation,
  SyncStatus,
  SyncLogOptions,
} from '../types/sync';

/**
 * Interface for sync configuration operations
 */
export interface ISyncService {
  /**
   * Get sync configuration (cursor, lastPushAt, lastPullAt)
   */
  getConfig(): Promise<SyncConfig | null>;

  /**
   * Update sync configuration
   */
  setConfig(updates: UpdateSyncConfigInput): Promise<void>;

  /**
   * Get the current sync cursor value
   */
  getCursor(): Promise<number>;

  /**
   * Update the sync cursor value
   */
  setCursor(cursor: number): Promise<void>;

  /**
   * Log a sync operation start
   * @returns The log entry ID
   */
  logOperation(operation: SyncOperation, status: SyncStatus): Promise<number>;

  /**
   * Update a sync operation log entry status
   */
  updateLogStatus(logId: number, status: SyncStatus, options?: SyncLogOptions): Promise<void>;
}
