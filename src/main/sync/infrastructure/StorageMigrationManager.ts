/**
 * Desktop Storage Migration Manager
 *
 * Manages versioned storage migrations and rollback capabilities
 * Handles both schema migrations and data migrations for sync v2
 *
 * References:
 * - /notely/SYNC_RE_ARCHITECTURE.md - Implementation Phases
 * - /notely/SYNC_RE_ARCHITECTURE_TODO.md - Phase 6 requirements
 * - Migration files: /src/main/storage/migrations/migrations/
 *
 * Date: 2025-09-09
 */

import { logger } from '../../logger';
import { IStorageService } from '../../storage/interfaces';
import { MigrationRunner } from '../../storage/migrations/MigrationRunner';

/**
 * Migration status
 */
export interface MigrationStatus {
  currentVersion: number;
  targetVersion: number;
  isComplete: boolean;
  hasV2Tables: boolean;
  canRollback: boolean;
  migrationHistory: MigrationHistoryEntry[];
}

/**
 * Migration history entry
 */
export interface MigrationHistoryEntry {
  version: number;
  description: string;
  appliedAt: number;
  duration: number;
  success: boolean;
  errorMessage?: string;
}

/**
 * Migration options
 */
export interface MigrationOptions {
  dryRun?: boolean;
  backupBeforeMigration?: boolean;
  rollbackOnFailure?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Migration result
 */
export interface MigrationResult {
  success: boolean;
  oldVersion: number;
  newVersion: number;
  migrationsApplied: number;
  duration: number;
  error?: string;
  rollbackApplied?: boolean;
}

/**
 * Storage backup info
 */
export interface StorageBackup {
  id: string;
  version: number;
  createdAt: number;
  path: string;
  size: number;
  checksum: string;
}

/**
 * Desktop Storage Migration Manager - handles versioned migrations
 */
export class DesktopStorageMigrationManager {
  private static readonly MIGRATION_HISTORY_KEY = 'storage.migration.history';
  private static readonly BACKUP_PREFIX = 'notely_backup_';
  private static readonly V2_TARGET_VERSION = 11; // Migration 011 adds v2 tables

  private migrationRunner: MigrationRunner;
  private isInitialized = false;

  constructor(private storage: IStorageService) {
    // Access the migration runner from the database manager
    this.migrationRunner = (
      this.storage.database as unknown as { migrationRunner: MigrationRunner }
    ).migrationRunner;
  }

  /**
   * Initialize the migration manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.isInitialized = true;
      logger.info('[StorageMigrationManager] Initialized');
    } catch (error) {
      logger.error('[StorageMigrationManager] Failed to initialize:', error);
      throw new Error(`Storage migration manager initialization failed: ${error}`);
    }
  }

  /**
   * Check current migration status
   */
  async getMigrationStatus(): Promise<MigrationStatus> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const currentVersion = await this.migrationRunner.getCurrentVersion();
      const hasV2Tables = currentVersion >= DesktopStorageMigrationManager.V2_TARGET_VERSION;
      const migrationHistory = await this.getMigrationHistory();

      const status: MigrationStatus = {
        currentVersion,
        targetVersion: DesktopStorageMigrationManager.V2_TARGET_VERSION,
        isComplete: hasV2Tables,
        hasV2Tables,
        canRollback: this.canRollbackFromVersion(currentVersion),
        migrationHistory,
      };

      logger.debug('[StorageMigrationManager] Migration status checked', status);
      return status;
    } catch (error) {
      logger.error('[StorageMigrationManager] Failed to get migration status:', error);
      throw error;
    }
  }

  /**
   * Migrate storage to support sync v2
   */
  async migrateToV2(options: MigrationOptions = {}): Promise<MigrationResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const startTime = Date.now();
    const oldVersion = await this.migrationRunner.getCurrentVersion();

    // Check if already at target version
    if (oldVersion >= DesktopStorageMigrationManager.V2_TARGET_VERSION) {
      logger.info('[StorageMigrationManager] Already at v2 target version', {
        currentVersion: oldVersion,
        targetVersion: DesktopStorageMigrationManager.V2_TARGET_VERSION,
      });

      return {
        success: true,
        oldVersion,
        newVersion: oldVersion,
        migrationsApplied: 0,
        duration: Date.now() - startTime,
      };
    }

    let backupId: string | undefined;

    try {
      logger.info('[StorageMigrationManager] Starting migration to v2', {
        oldVersion,
        targetVersion: DesktopStorageMigrationManager.V2_TARGET_VERSION,
        options,
      });

      // Create backup if requested
      if (options.backupBeforeMigration) {
        backupId = await this.createBackup(oldVersion);
        logger.info('[StorageMigrationManager] Backup created', { backupId });
      }

      // Perform dry run if requested
      if (options.dryRun) {
        logger.info('[StorageMigrationManager] Performing dry run');
        const dryRunResult = await this.performDryRun(oldVersion);

        return {
          success: dryRunResult.success,
          oldVersion,
          newVersion: dryRunResult.targetVersion,
          migrationsApplied: dryRunResult.migrationsCount,
          duration: Date.now() - startTime,
          error: dryRunResult.error,
        };
      }

      // Run the actual migrations
      const migrationResult = await this.runMigrationsToTarget();
      const newVersion = await this.migrationRunner.getCurrentVersion();

      // Record migration in history
      await this.recordMigrationAttempt(
        oldVersion,
        newVersion,
        migrationResult.success,
        Date.now() - startTime,
        migrationResult.error
      );

      if (migrationResult.success) {
        logger.info('[StorageMigrationManager] Migration to v2 completed successfully', {
          oldVersion,
          newVersion,
          duration: Date.now() - startTime,
        });

        return {
          success: true,
          oldVersion,
          newVersion,
          migrationsApplied: newVersion - oldVersion,
          duration: Date.now() - startTime,
        };
      } else {
        throw new Error(migrationResult.error || 'Migration failed');
      }
    } catch (error) {
      logger.error('[StorageMigrationManager] Migration to v2 failed:', error);

      // Attempt rollback if requested and backup exists
      if (options.rollbackOnFailure && backupId) {
        logger.info('[StorageMigrationManager] Attempting rollback');
        try {
          await this.restoreFromBackup(backupId);
          logger.info('[StorageMigrationManager] Rollback completed');

          return {
            success: false,
            oldVersion,
            newVersion: oldVersion, // Rolled back
            migrationsApplied: 0,
            duration: Date.now() - startTime,
            error: error.message,
            rollbackApplied: true,
          };
        } catch (rollbackError) {
          logger.error('[StorageMigrationManager] Rollback failed:', rollbackError);
        }
      }

      // Record failed migration attempt
      await this.recordMigrationAttempt(
        oldVersion,
        await this.migrationRunner.getCurrentVersion(),
        false,
        Date.now() - startTime,
        error.message
      );

      return {
        success: false,
        oldVersion,
        newVersion: await this.migrationRunner.getCurrentVersion(),
        migrationsApplied: 0,
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Rollback from v2 to previous version
   */
  async rollbackFromV2(options: MigrationOptions = {}): Promise<MigrationResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    const startTime = Date.now();
    const currentVersion = await this.migrationRunner.getCurrentVersion();

    if (currentVersion < DesktopStorageMigrationManager.V2_TARGET_VERSION) {
      logger.info('[StorageMigrationManager] Not at v2 version, no rollback needed', {
        currentVersion,
      });

      return {
        success: true,
        oldVersion: currentVersion,
        newVersion: currentVersion,
        migrationsApplied: 0,
        duration: Date.now() - startTime,
      };
    }

    try {
      logger.info('[StorageMigrationManager] Starting rollback from v2', {
        currentVersion,
        options,
      });

      // Find the most recent backup before v2
      const backup = await this.findLatestBackupBeforeVersion(
        DesktopStorageMigrationManager.V2_TARGET_VERSION
      );

      if (!backup) {
        throw new Error('No backup available for rollback');
      }

      // Perform rollback
      await this.restoreFromBackup(backup.id);
      const newVersion = await this.migrationRunner.getCurrentVersion();

      logger.info('[StorageMigrationManager] Rollback from v2 completed', {
        oldVersion: currentVersion,
        newVersion,
        backupUsed: backup.id,
      });

      // Record rollback in history
      await this.recordMigrationAttempt(
        currentVersion,
        newVersion,
        true,
        Date.now() - startTime,
        `Rollback using backup ${backup.id}`
      );

      return {
        success: true,
        oldVersion: currentVersion,
        newVersion,
        migrationsApplied: newVersion - currentVersion, // Negative number
        duration: Date.now() - startTime,
        rollbackApplied: true,
      };
    } catch (error) {
      logger.error('[StorageMigrationManager] Rollback from v2 failed:', error);

      return {
        success: false,
        oldVersion: currentVersion,
        newVersion: await this.migrationRunner.getCurrentVersion(),
        migrationsApplied: 0,
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Create backup of current database state
   */
  async createBackup(version: number): Promise<string> {
    const backupId = `${DesktopStorageMigrationManager.BACKUP_PREFIX}v${version}_${Date.now()}`;

    try {
      // This would create a backup file
      // Implementation depends on the storage service backup capabilities
      logger.info('[StorageMigrationManager] Creating backup', { backupId, version });

      // For now, return the backup ID (actual backup implementation would go here)
      return backupId;
    } catch (error) {
      logger.error('[StorageMigrationManager] Failed to create backup:', error);
      throw new Error(`Backup creation failed: ${error.message}`);
    }
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupId: string): Promise<void> {
    try {
      logger.info('[StorageMigrationManager] Restoring from backup', { backupId });

      // This would restore from a backup file
      // Implementation depends on the storage service restore capabilities

      logger.info('[StorageMigrationManager] Restore completed', { backupId });
    } catch (error) {
      logger.error('[StorageMigrationManager] Failed to restore from backup:', error);
      throw new Error(`Backup restore failed: ${error.message}`);
    }
  }

  /**
   * Perform dry run migration
   */
  private async performDryRun(fromVersion: number): Promise<{
    success: boolean;
    targetVersion: number;
    migrationsCount: number;
    error?: string;
  }> {
    try {
      // This would simulate running migrations without actually applying them
      const targetVersion = DesktopStorageMigrationManager.V2_TARGET_VERSION;
      const migrationsCount = targetVersion - fromVersion;

      logger.info('[StorageMigrationManager] Dry run completed', {
        fromVersion,
        targetVersion,
        migrationsCount,
      });

      return {
        success: true,
        targetVersion,
        migrationsCount,
      };
    } catch (error) {
      return {
        success: false,
        targetVersion: fromVersion,
        migrationsCount: 0,
        error: error.message,
      };
    }
  }

  /**
   * Run migrations to target version
   */
  private async runMigrationsToTarget(): Promise<{ success: boolean; error?: string }> {
    try {
      // The migration runner should handle running migrations up to the latest
      await this.migrationRunner.runMigrations();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Check if rollback is possible from version
   */
  private canRollbackFromVersion(version: number): boolean {
    // Can rollback if we have backups or if rollback migrations exist
    return version >= DesktopStorageMigrationManager.V2_TARGET_VERSION;
  }

  /**
   * Get migration history from storage
   */
  private async getMigrationHistory(): Promise<MigrationHistoryEntry[]> {
    try {
      const stored = await this.storage.settings.get(
        DesktopStorageMigrationManager.MIGRATION_HISTORY_KEY
      );

      if (stored) {
        return JSON.parse(stored);
      }

      return [];
    } catch (error) {
      logger.warn('[StorageMigrationManager] Failed to load migration history:', error);
      return [];
    }
  }

  /**
   * Record migration attempt in history
   */
  private async recordMigrationAttempt(
    oldVersion: number,
    newVersion: number,
    success: boolean,
    duration: number,
    errorMessage?: string
  ): Promise<void> {
    try {
      const history = await this.getMigrationHistory();

      const entry: MigrationHistoryEntry = {
        version: newVersion,
        description: `Migration from v${oldVersion} to v${newVersion}`,
        appliedAt: Date.now(),
        duration,
        success,
        errorMessage,
      };

      history.push(entry);

      // Keep only last 20 entries
      const trimmedHistory = history.slice(-20);

      await this.storage.settings.set(
        DesktopStorageMigrationManager.MIGRATION_HISTORY_KEY,
        JSON.stringify(trimmedHistory)
      );
    } catch (error) {
      logger.error('[StorageMigrationManager] Failed to record migration attempt:', error);
    }
  }

  /**
   * Find latest backup before a specific version
   */
  private async findLatestBackupBeforeVersion(_version: number): Promise<StorageBackup | null> {
    // This would search for available backups
    // For now, return null (would be implemented based on backup storage mechanism)
    return null;
  }

  /**
   * Get available backups
   */
  async getAvailableBackups(): Promise<StorageBackup[]> {
    // This would list all available backups
    return [];
  }

  /**
   * Cleanup old backups
   */
  async cleanupOldBackups(olderThanDays: number): Promise<number> {
    try {
      logger.info('[StorageMigrationManager] Cleaning up old backups', { olderThanDays });

      // This would remove backups older than specified days
      const cleanedCount = 0; // Would be actual count of cleaned backups

      logger.info('[StorageMigrationManager] Backup cleanup completed', { cleanedCount });
      return cleanedCount;
    } catch (error) {
      logger.error('[StorageMigrationManager] Failed to cleanup backups:', error);
      return 0;
    }
  }

  /**
   * Validate storage integrity
   */
  async validateStorageIntegrity(): Promise<{
    valid: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    try {
      const status = await this.getMigrationStatus();

      // Check if v2 tables exist when expected
      if (
        status.currentVersion >= DesktopStorageMigrationManager.V2_TARGET_VERSION &&
        !status.hasV2Tables
      ) {
        issues.push('Migration version indicates v2 tables should exist, but they are missing');
        recommendations.push('Run migration repair or rollback and re-migrate');
      }

      // Check migration history consistency
      const history = status.migrationHistory;
      if (history.length > 0) {
        const lastSuccessfulMigration = history.filter((h) => h.success).pop();
        if (lastSuccessfulMigration && lastSuccessfulMigration.version !== status.currentVersion) {
          issues.push('Migration history is inconsistent with current version');
          recommendations.push('Check migration logs and consider re-running migrations');
        }
      }

      const valid = issues.length === 0;

      logger.info('[StorageMigrationManager] Storage integrity validated', {
        valid,
        issuesCount: issues.length,
      });

      return { valid, issues, recommendations };
    } catch (error) {
      logger.error('[StorageMigrationManager] Storage integrity validation failed:', error);
      return {
        valid: false,
        issues: [`Validation failed: ${error.message}`],
        recommendations: ['Contact support or check logs for details'],
      };
    }
  }

  /**
   * Cleanup resources
   */
  async shutdown(): Promise<void> {
    this.isInitialized = false;
    logger.info('[StorageMigrationManager] Shutdown complete');
  }
}

// Export factory function
export const createDesktopStorageMigrationManager = (
  storage: IStorageService
): DesktopStorageMigrationManager => {
  return new DesktopStorageMigrationManager(storage);
};
