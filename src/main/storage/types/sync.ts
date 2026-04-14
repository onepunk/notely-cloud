/**
 * Sync-related types
 *
 * NOTE: Auth fields (accessToken, refreshToken, tokenExpiresAt, serverUserId, serverUrl)
 * have been REMOVED to achieve auth/sync decoupling.
 * Use AuthService for all auth-related data.
 */

export type SyncConfig = {
  id: number;
  // Auth fields REMOVED - use AuthService instead:
  // - serverUrl -> AuthService.getAuthContext().serverUrl
  // - serverUserId -> AuthService.getAuthContext().userId
  // - accessToken -> AuthService.getAuthContext().accessToken
  // - refreshToken -> AuthService (not exposed in context)
  // - tokenExpiresAt -> AuthService (validated internally)
  //
  // REMOVED in migration 025:
  // - desktopUserUuid: Now stored in settings as 'sync.device_id'
  // - syncEnabled: Now stored in settings as 'syncEnabled' (single source of truth)
  lastPushAt: number | null;
  lastPullAt: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SyncOperation = 'push' | 'pull' | 'sync' | 'link' | 'restore';

export type SyncStatus = 'started' | 'completed' | 'failed';

export type SyncEntityType =
  | 'binders'
  | 'notes'
  | 'note_revisions'
  | 'transcription_sessions'
  | 'summaries';

export type SyncLogEntry = {
  id: number;
  operation: SyncOperation;
  status: SyncStatus;
  entityType: string | null;
  entityCount: number;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  sessionId: string | null;
};

export type SyncLogOptions = {
  entityType?: string;
  entityCount?: number;
  errorMessage?: string;
  sessionId?: string;
};

export type SyncMetadataOptions = {
  syncVersion?: number;
  syncChecksum?: string;
  serverUpdatedAt?: number;
};

export type UpdateSyncConfigInput = {
  // Auth fields REMOVED - use AuthService for auth operations
  // REMOVED in migration 025:
  // - desktopUserUuid: Now stored in settings as 'sync.device_id'
  // - syncEnabled: Now stored in settings as 'syncEnabled' (single source of truth)
  lastPushAt?: number;
  lastPullAt?: number;
};

// Entity sync metadata
export type SyncMetadata = {
  syncVersion: number;
  syncChecksum: string | null;
  serverUpdatedAt: number | null;
};

export type SyncableEntity = {
  id: string;
  updatedAt: number;
  syncMetadata?: SyncMetadata;
};
