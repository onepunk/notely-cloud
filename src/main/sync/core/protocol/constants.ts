/**
 * Sync v2 Constants - Single source of truth for collection definitions
 *
 * This file prevents duplication and ensures consistency across the sync system.
 * Any changes to collections should be made here and will automatically
 * propagate throughout the codebase.
 *
 * Date: 2025-09-14
 */

// Core collection types
export type CollectionType =
  | 'binders'
  | 'notes'
  | 'transcriptions'
  | 'summaries'
  | 'tags'
  | 'note_tags';

/**
 * All sync collections in canonical order
 * IMPORTANT: This is the single source of truth for all collection definitions
 */
export const SYNC_COLLECTIONS: readonly CollectionType[] = [
  'binders',
  'notes',
  'transcriptions',
  'summaries',
  'tags',
  'note_tags',
] as const;

/**
 * Collection count for validation
 */
export const COLLECTION_COUNT = SYNC_COLLECTIONS.length;

/**
 * Helper type for collection-based objects
 */
export type CollectionMap<T> = {
  [K in CollectionType]: T;
};

/**
 * Helper type for partial collection-based objects
 */
export type PartialCollectionMap<T> = {
  [K in CollectionType]?: T;
};

/**
 * Validate that all collections are present in a map
 */
export function validateAllCollections<T>(map: PartialCollectionMap<T>): map is CollectionMap<T> {
  return SYNC_COLLECTIONS.every((collection) => collection in map);
}

/**
 * Create a collection map with a default value for all collections
 */
export function createCollectionMap<T>(defaultValue: T): CollectionMap<T> {
  const map = {} as CollectionMap<T>;
  for (const collection of SYNC_COLLECTIONS) {
    map[collection] = defaultValue;
  }
  return map;
}

/**
 * Get collection counts from a collection map of arrays
 */
export function getCollectionCounts<T>(
  collections: PartialCollectionMap<T[]>
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const collection of SYNC_COLLECTIONS) {
    counts[collection] = collections[collection]?.length || 0;
  }
  return counts;
}

/**
 * Calculate total count across all collections
 */
export function getTotalCount<T>(collections: PartialCollectionMap<T[]>): number {
  return SYNC_COLLECTIONS.reduce(
    (total, collection) => total + (collections[collection]?.length || 0),
    0
  );
}
