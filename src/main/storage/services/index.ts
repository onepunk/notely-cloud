/**
 * Storage services exports
 */

// Service implementations
export { UserService } from './UserService';
export { SettingsService } from './SettingsService';
export { BinderService } from './BinderService';
export { NoteService } from './NoteService';
export { SearchService } from './SearchService';
export { TranscriptionService } from './TranscriptionService';
export { SummaryService } from './SummaryService';
export { CalendarEventService } from './CalendarEventService';
export { TagService } from './TagService';
export { AudioRecordingService } from './AudioRecordingService';
export { SyncItemsService } from './SyncItemsService';
export { SyncService } from './SyncService';

// Import all services for factory function
import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';

import { AudioRecordingService } from './AudioRecordingService';
import { BinderService } from './BinderService';
import { CalendarEventService } from './CalendarEventService';
import { NoteService } from './NoteService';
import { SearchService } from './SearchService';
import { SettingsService } from './SettingsService';
import { SummaryService } from './SummaryService';
import { SyncItemsService } from './SyncItemsService';
import { SyncService } from './SyncService';
import { TagService } from './TagService';
import { TranscriptionService } from './TranscriptionService';
import { UserService } from './UserService';

/**
 * Create all services with proper dependency injection
 */
export function createServices(databaseManager: IDatabaseManager) {
  // Create shared utilities
  const transactionManager = new TransactionManager(databaseManager);

  // Create sync items service (tracks dirty entities for sync)
  const syncItemsService = new SyncItemsService(databaseManager, transactionManager);
  const syncService = new SyncService(databaseManager, transactionManager);

  // Create services in dependency order, injecting syncItemsService for markDirty
  const userService = new UserService(databaseManager, transactionManager);
  const settingsService = new SettingsService(databaseManager, transactionManager);
  const binderService = new BinderService(
    databaseManager,
    transactionManager,
    userService,
    syncItemsService
  );
  const searchService = new SearchService(databaseManager, transactionManager, settingsService);
  const noteService = new NoteService(
    databaseManager,
    transactionManager,
    searchService,
    syncItemsService
  );
  const transcriptionService = new TranscriptionService(
    databaseManager,
    transactionManager,
    searchService,
    syncItemsService
  );
  const calendarEventService = new CalendarEventService(databaseManager, transactionManager);
  const summaryService = new SummaryService(databaseManager, transactionManager, syncItemsService);
  const tagService = new TagService(
    databaseManager,
    transactionManager,
    userService,
    syncItemsService
  );
  const audioRecordingService = new AudioRecordingService(databaseManager, transactionManager);

  return {
    userService,
    settingsService,
    binderService,
    noteService,
    searchService,
    transcriptionService,
    summaryService,
    calendarEventService,
    tagService,
    audioRecordingService,
    syncItemsService,
    syncService,
  };
}
