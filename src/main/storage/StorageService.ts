/**
 * Main storage service orchestrator - Delegates operations to specialized services
 */

import { logger } from '../logger';

import {
  needsEncryptionMigration,
  migrateToEncryptedDatabase,
} from './core/DatabaseEncryptionMigration';
import { DatabaseManager } from './core/DatabaseManager';
import type {
  IStorageService,
  IDatabaseManager,
  IUserService,
  IBinderService,
  ICalendarEventService,
  INoteService,
  ITranscriptionService,
  ISettingsService,
  ISearchService,
  ISummaryService,
  ITagService,
  IAudioRecordingService,
  ISyncService,
} from './interfaces';
import { setupDatabase } from './migrations';
import { createServices } from './services';
import type { SyncItemsService } from './services/SyncItemsService';

/**
 * Main storage service that orchestrates all storage operations through specialized services
 */
export class StorageService implements IStorageService {
  private _database: IDatabaseManager;
  private _users: IUserService;
  private _binders: IBinderService;
  private _notes: INoteService;
  private _transcriptions: ITranscriptionService;
  private _settings: ISettingsService;
  private _search: ISearchService;
  private _summaries: ISummaryService;
  private _calendarEvents: ICalendarEventService;
  private _tags: ITagService;
  private _audioRecordings: IAudioRecordingService;
  private _sync: ISyncService;
  private _syncItems: SyncItemsService;
  private readonly _baseDir: string;

  constructor(baseDir: string) {
    this._baseDir = baseDir;

    // Check for DEBUG_DB environment variable to disable encryption for debugging
    // WARNING: Only works for NEW databases - existing encrypted databases cannot be decrypted
    const debugDbEnabled = process.env.DEBUG_DB === 'true' || process.env.DEBUG_DB === '1';

    if (debugDbEnabled) {
      logger.warn(
        '⚠️  DEBUG_DB mode enabled - database encryption is DISABLED. ' +
          'This should only be used for development/debugging. ' +
          'Do NOT use in production!'
      );
    }

    // Create database manager with encryption disabled in debug mode
    this._database = new DatabaseManager(baseDir, {
      encryption: !debugDbEnabled,
    });

    // Create all services via factory
    const services = createServices(this._database);

    this._users = services.userService;
    this._settings = services.settingsService;
    this._binders = services.binderService;
    this._notes = services.noteService;
    this._search = services.searchService;
    this._transcriptions = services.transcriptionService;
    this._summaries = services.summaryService;
    this._calendarEvents = services.calendarEventService;
    this._tags = services.tagService;
    this._audioRecordings = services.audioRecordingService;
    this._sync = services.syncService;
    this._syncItems = services.syncItemsService;
  }

  // Readonly service accessors
  get database(): IDatabaseManager {
    return this._database;
  }
  get users(): IUserService {
    return this._users;
  }
  get binders(): IBinderService {
    return this._binders;
  }
  get notes(): INoteService {
    return this._notes;
  }
  get transcriptions(): ITranscriptionService {
    return this._transcriptions;
  }
  get settings(): ISettingsService {
    return this._settings;
  }
  get search(): ISearchService {
    return this._search;
  }
  get summaries(): ISummaryService {
    return this._summaries;
  }
  get calendarEvents(): ICalendarEventService {
    return this._calendarEvents;
  }
  get tags(): ITagService {
    return this._tags;
  }
  get audioRecordings(): IAudioRecordingService {
    return this._audioRecordings;
  }
  get sync(): ISyncService {
    return this._sync;
  }
  get syncItems(): SyncItemsService {
    return this._syncItems;
  }

  /**
   * Initialize the storage service and run any necessary migrations
   */
  async initialize(): Promise<void> {
    try {
      // Run database encryption migration if needed (before opening the database)
      await this.runEncryptionMigrationIfNeeded();

      logger.debug('Opening database connection...');
      // Open database connection
      await this._database.open();
      logger.debug('Database connection opened');

      logger.debug('Running migrations and seeds...');
      // Run migrations and seeds
      await setupDatabase(this._database);
      logger.debug('Migrations and seeds completed');

      logger.debug('Ensuring local user exists...');
      // Ensure a local user profile exists (creates anonymous profile if needed)
      // This allows standalone use without OAuth login
      const userId = await this._users.ensureLocalUser();
      logger.debug('Local user ready', { userId: userId.substring(0, 8) + '...' });
    } catch (error) {
      logger.error(
        'Storage initialization failed: %s',
        error instanceof Error ? error.stack || error.message : String(error)
      );
      throw new Error(
        `Failed to initialize storage: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Run database encryption migration if the database exists but is not yet encrypted
   */
  private async runEncryptionMigrationIfNeeded(): Promise<void> {
    // Skip encryption migration in DEBUG_DB mode
    const debugDbEnabled = process.env.DEBUG_DB === 'true' || process.env.DEBUG_DB === '1';
    if (debugDbEnabled) {
      logger.debug('StorageService: Skipping encryption migration (DEBUG_DB mode)');
      return;
    }

    if (!needsEncryptionMigration(this._baseDir)) {
      return;
    }

    logger.info(
      'StorageService: Existing unencrypted database detected, running encryption migration...'
    );

    const result = await migrateToEncryptedDatabase(this._baseDir, (progress) => {
      logger.debug('StorageService: Encryption migration progress', {
        stage: progress.stage,
        percent: progress.percent,
        message: progress.message,
      });
    });

    if (!result.success) {
      logger.error('StorageService: Database encryption migration failed', {
        message: result.message,
        error: result.error,
      });
      throw new Error(`Database encryption migration failed: ${result.error || result.message}`);
    }

    if (result.migrated) {
      logger.debug('StorageService: Database encryption migration completed successfully', {
        backupPath: result.backupPath,
      });
    }
  }

  /**
   * Close the storage service and clean up resources
   */
  async close(): Promise<void> {
    try {
      await this._database.close();
    } catch (error) {
      throw new Error(
        `Failed to close storage: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get database health status
   */
  async getHealthStatus(): Promise<{
    connected: boolean;
    walMode: boolean;
    foreignKeysEnabled: boolean;
    encrypted: boolean;
    lastMigrationVersion: number;
  }> {
    try {
      const health = await this._database.getHealthStatus();
      const schemaVersion = await this._settings.get('schema_version');

      return {
        connected: health.connected,
        walMode: health.walMode,
        foreignKeysEnabled: health.foreignKeysEnabled,
        encrypted: health.encrypted ?? false,
        lastMigrationVersion: schemaVersion ? parseInt(schemaVersion, 10) : 0,
      };
    } catch (error) {
      return {
        connected: false,
        walMode: false,
        foreignKeysEnabled: false,
        encrypted: false,
        lastMigrationVersion: 0,
      };
    }
  }
}

/**
 * Create a new storage service instance
 */
export function createStorageService(baseDir: string): IStorageService {
  return new StorageService(baseDir);
}
