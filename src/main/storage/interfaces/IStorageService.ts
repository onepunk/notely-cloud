/**
 * Main storage service interface - Orchestrates all storage operations
 */

import type { SyncItemsService } from '../services/SyncItemsService';

import type { IAudioRecordingService } from './IAudioRecordingService';
import type { IBinderService } from './IBinderService';
import type { ICalendarEventService } from './ICalendarEventService';
import type { IDatabaseManager } from './IDatabaseManager';
import type { INoteService } from './INoteService';
import type { ISearchService } from './ISearchService';
import type { ISettingsService } from './ISettingsService';
import type { ISummaryService } from './ISummaryService';
import type { ISyncService } from './ISyncService';
import type { ITagService } from './ITagService';
import type { ITranscriptionService } from './ITranscriptionService';
import type { IUserService } from './IUserService';

/**
 * Main storage service interface that provides access to all storage operations
 * through specialized service domains.
 */
export interface IStorageService {
  // Core database operations
  readonly database: IDatabaseManager;

  // Domain services
  readonly users: IUserService;
  readonly binders: IBinderService;
  readonly notes: INoteService;
  readonly transcriptions: ITranscriptionService;
  readonly settings: ISettingsService;
  readonly search: ISearchService;
  readonly summaries: ISummaryService;
  readonly calendarEvents: ICalendarEventService;
  readonly tags: ITagService;
  readonly audioRecordings: IAudioRecordingService;
  readonly sync: ISyncService;
  readonly syncItems: SyncItemsService;

  /**
   * Initialize the storage service and run any necessary migrations
   */
  initialize(): Promise<void>;

  /**
   * Close the storage service and clean up resources
   */
  close(): Promise<void>;

  /**
   * Get database health status
   */
  getHealthStatus(): Promise<{
    connected: boolean;
    walMode: boolean;
    foreignKeysEnabled: boolean;
    lastMigrationVersion: number;
  }>;
}
