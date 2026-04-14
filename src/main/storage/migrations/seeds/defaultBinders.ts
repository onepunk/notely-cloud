// import { Database } from 'better-sqlite3-multiple-ciphers';
import { createHash } from 'crypto';

import { logger } from '../../../logger';

export interface DefaultBinder {
  id: string;
  name: string;
  sort_index: number;
  type: BinderType;
}

export enum BinderType {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

/**
 * Generate deterministic UUID for system "Unassigned" binder using namespace approach.
 * Based on o3's recommendation to use UUIDv5-style generation for system entities.
 * This ID is consistent across all installations to prevent sync conflicts.
 * Notes without explicit binder assignment are stored in this system binder.
 */
function _generateSystemBinderUUID(): string {
  // Create a deterministic UUID using SHA-256 hash of namespace string
  const namespace = 'notely.system.unassigned.binder';
  const hash = createHash('sha256').update(namespace).digest('hex');

  // Format as UUID v4 structure: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // Use first 32 hex chars from hash to create deterministic UUID
  const uuid = [
    hash.substr(0, 8),
    hash.substr(8, 4),
    '4' + hash.substr(13, 3), // Version 4 UUID format
    '8' + hash.substr(17, 3), // Variant bits (8, 9, A, B)
    hash.substr(20, 12),
  ].join('-');

  return uuid;
}

// Align with server canonical ID for the system "Unassigned" binder
// Server constant is: 'ab6eb598-eeee-4d13-8dde-3eb2b496e91e'
export const UNASSIGNED_BINDER_ID = 'ab6eb598-eeee-4d13-8dde-3eb2b496e91e';

/**
 * System binder for unassigned notes.
 * This binder is hidden from the UI but used internally for notes
 * that don't have an explicit binder assignment.
 * Enhanced with type system per o3's recommendations for future-proofing.
 */
export const DEFAULT_BINDERS: DefaultBinder[] = [
  {
    id: UNASSIGNED_BINDER_ID,
    name: 'Unassigned',
    sort_index: -1, // Negative sort_index ensures it doesn't interfere with user binders
    type: BinderType.SYSTEM,
  },
];

/**
 * Seeds default binders if none exist
 * This runs after all migrations to ensure binders are available
 * Enhanced with security considerations per o3's recommendations.
 */
export function seedDefaultBinders(): void {
  // No-op: Per-user default binders are created in UserService during first-run
  // This avoids creating global binders with user_profile_id = NULL
  // Security: Each user gets their own system binder instance with proper user_id isolation
  logger.info('Skipping global default binders seeding (handled per-user by UserService)');
}

/**
 * Utility function to check if a binder ID is the system unassigned binder
 * Useful for security validations and UI filtering
 */
export function isSystemBinder(binderId: string): boolean {
  return binderId === UNASSIGNED_BINDER_ID;
}

/**
 * Utility function to check if a binder type is system
 * Used for filtering system binders from UI displays
 */
export function isSystemBinderType(binderType: BinderType): boolean {
  return binderType === BinderType.SYSTEM;
}
