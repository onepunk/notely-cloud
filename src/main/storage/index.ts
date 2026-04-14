/**
 * Storage layer public API
 */

// Export main service
export { StorageService, createStorageService } from './StorageService';

// Export all interfaces for type checking
export type {
  IStorageService,
  IDatabaseManager,
  IUserService,
  IBinderService,
  INoteService,
  ITranscriptionService,
  ISettingsService,
  ISearchService,
} from './interfaces';

// Export all types
export type * from './types';

// Export service implementations (for advanced use cases)
export {
  UserService,
  SettingsService,
  BinderService,
  NoteService,
  SearchService,
  TranscriptionService,
} from './services';

/**
 * Main factory function to create a storage service
 * This is the primary entry point for the storage layer
 *
 * @param baseDir - Base directory for data storage
 * @returns Configured storage service
 */
export { createStorageService as createStorage } from './StorageService';
