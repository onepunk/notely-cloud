import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { logger } from '../../logger';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';

export interface Migration {
  version: number;
  description: string;
  up: (db: DatabaseInstance) => void;
  down?: (db: DatabaseInstance) => void;
}

export interface MigrationResult {
  version: number;
  success: boolean;
  error?: string;
  executedAt: number;
}

export type DatabaseState = 'fresh' | 'partial' | 'migrated';

export interface BaselineResult {
  success: boolean;
  version: number;
  checksum?: string;
  error?: string;
  executedAt: number;
}

export class MigrationRunner {
  private migrations: Migration[] = [];

  constructor(private databaseManager: IDatabaseManager) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Register a migration with the runner
   */
  registerMigration(migration: Migration): void {
    // Insert in version order
    const insertIndex = this.migrations.findIndex((m) => m.version > migration.version);
    if (insertIndex === -1) {
      this.migrations.push(migration);
    } else {
      this.migrations.splice(insertIndex, 0, migration);
    }
  }

  /**
   * Get the current schema version from the database
   */
  getCurrentVersion(): number {
    try {
      const getSetting = this.db.prepare('SELECT value FROM settings WHERE key=?');
      const row = getSetting.get('schema_version') as { value: string } | undefined;
      return row && row.value ? Number(row.value) || 0 : 0;
    } catch (error) {
      // If settings table doesn't exist, assume version 0 (fresh install)
      if (error instanceof Error && error.message.includes('no such table: settings')) {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Set the schema version in the database
   */
  private setVersion(version: number): void {
    const setSetting = this.db.prepare(
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    );
    setSetting.run('schema_version', String(version));
  }

  /**
   * Run all pending migrations up to the target version
   */
  async runMigrations(targetVersion?: number): Promise<MigrationResult[]> {
    const currentVersion = this.getCurrentVersion();
    const results: MigrationResult[] = [];

    // Filter migrations to run
    const migrationsToRun = this.migrations.filter((m) => {
      return m.version > currentVersion && (!targetVersion || m.version <= targetVersion);
    });

    if (migrationsToRun.length === 0) {
      return results;
    }

    logger.info(
      `Running ${migrationsToRun.length} migrations from version ${currentVersion} to ${targetVersion || 'latest'}`
    );

    // Run each migration in a transaction
    for (const migration of migrationsToRun) {
      const result: MigrationResult = {
        version: migration.version,
        success: false,
        executedAt: Date.now(),
      };

      try {
        logger.debug(`Running migration ${migration.version}: ${migration.description}`);

        // Run migration in transaction
        this.db.transaction(() => {
          migration.up(this.db);
          this.setVersion(migration.version);
        })();

        result.success = true;
        logger.debug(`Migration ${migration.version} completed`);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        logger.error(`Migration ${migration.version} failed: %s`, result.error);

        // Stop on first failure
        results.push(result);
        break;
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Rollback to a specific version (development/testing only)
   */
  async rollbackTo(targetVersion: number): Promise<MigrationResult[]> {
    const currentVersion = this.getCurrentVersion();
    const results: MigrationResult[] = [];

    if (targetVersion >= currentVersion) {
      throw new Error(
        `Target version ${targetVersion} must be less than current version ${currentVersion}`
      );
    }

    // Find migrations to rollback (in reverse order)
    const migrationsToRollback = this.migrations
      .filter((m) => m.version > targetVersion && m.version <= currentVersion)
      .sort((a, b) => b.version - a.version);

    logger.warn(
      `Rolling back ${migrationsToRollback.length} migrations from version ${currentVersion} to ${targetVersion}`
    );

    for (const migration of migrationsToRollback) {
      if (!migration.down) {
        throw new Error(`Migration ${migration.version} does not support rollback`);
      }

      const result: MigrationResult = {
        version: migration.version,
        success: false,
        executedAt: Date.now(),
      };

      try {
        logger.warn(`Rolling back migration ${migration.version}: ${migration.description}`);

        // Run rollback in transaction
        this.db.transaction(() => {
          migration.down!(this.db);
          this.setVersion(migration.version - 1);
        })();

        result.success = true;
        logger.info(`Rollback ${migration.version} completed successfully`);
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        logger.error(`Rollback ${migration.version} failed: %s`, result.error);

        results.push(result);
        break;
      }

      results.push(result);
    }

    return results;
  }

  /**
   * Dry run - show what migrations would be executed
   */
  dryRun(targetVersion?: number): Migration[] {
    const currentVersion = this.getCurrentVersion();
    return this.migrations.filter((m) => {
      return m.version > currentVersion && (!targetVersion || m.version <= targetVersion);
    });
  }

  /**
   * Get all registered migrations
   */
  getMigrations(): Migration[] {
    return [...this.migrations];
  }

  /**
   * Validate migration sequence - ensure no gaps in version numbers
   */
  validateMigrationSequence(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (this.migrations.length === 0) {
      return { valid: true, errors };
    }

    // Sort by version
    const sorted = [...this.migrations].sort((a, b) => a.version - b.version);

    // Check for duplicates
    const versions = new Set<number>();
    for (const migration of sorted) {
      if (versions.has(migration.version)) {
        errors.push(`Duplicate migration version: ${migration.version}`);
      }
      versions.add(migration.version);
    }

    // Check for gaps (optional - migrations could skip versions)
    let expectedVersion = 1;
    for (const migration of sorted) {
      if (migration.version < expectedVersion) {
        errors.push(
          `Migration version ${migration.version} is less than expected ${expectedVersion}`
        );
      }
      expectedVersion = migration.version + 1;
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Detect the current database state for baseline vs migration decision
   */
  detectDatabaseState(): DatabaseState {
    try {
      // Check if settings table exists
      const tableExists = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
        .get();

      if (!tableExists) {
        return 'fresh';
      }

      // Check current schema version
      const currentVersion = this.getCurrentVersion();

      if (currentVersion === 0) {
        // Settings table exists but no version set - might be partial
        const tableCount = this.db
          .prepare(
            "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          )
          .get() as { count: number };

        return tableCount.count > 1 ? 'partial' : 'fresh';
      }

      // Check for partial migrations by validating expected tables exist
      if (currentVersion > 0 && currentVersion < 9) {
        return this.validatePartialSchema(currentVersion) ? 'migrated' : 'partial';
      }

      return 'migrated';
    } catch (error) {
      logger.warn(
        'Error detecting database state, assuming fresh: %s',
        error instanceof Error ? error.message : String(error)
      );
      return 'fresh';
    }
  }

  /**
   * Validate that the schema is consistent for the given version
   */
  private validatePartialSchema(version: number): boolean {
    try {
      // Basic validation - check essential tables exist
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);

      // All versions should have these core tables
      const coreTablesShouldExist = ['settings', 'binders', 'notes'];
      for (const table of coreTablesShouldExist) {
        if (!tableNames.includes(table)) {
          logger.warn(`Expected table ${table} not found for schema version ${version}`);
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.warn(
        'Schema validation failed: %s',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  }

  /**
   * Apply baseline schema for fresh installations
   * This replaces migrations 001-009 with a single SQL file
   */
  async applyBaseline(baselineVersion = 9): Promise<BaselineResult> {
    const result: BaselineResult = {
      success: false,
      version: baselineVersion,
      executedAt: Date.now(),
    };

    try {
      logger.debug('Applying baseline schema v%d for fresh installation', baselineVersion);

      // Locate the baseline schema file
      const baselineFile = this.getBaselineSchemaPath(baselineVersion);
      if (!fs.existsSync(baselineFile)) {
        throw new Error(`Baseline schema file not found: ${baselineFile}`);
      }

      // Read the baseline schema
      const baselineSQL = fs.readFileSync(baselineFile, 'utf8');

      // Extract PRAGMA statements and run them outside the transaction.
      // SQLCipher disallows changing safety-level PRAGMAs (journal_mode,
      // synchronous, etc.) inside a transaction.
      const pragmaLines: string[] = [];
      const schemaLines: string[] = [];
      for (const line of baselineSQL.split('\n')) {
        if (/^\s*PRAGMA\s+/i.test(line)) {
          pragmaLines.push(line);
        } else {
          schemaLines.push(line);
        }
      }

      // Apply PRAGMAs outside the transaction
      if (pragmaLines.length > 0) {
        this.db.exec(pragmaLines.join('\n'));
      }

      // Apply schema DDL + seed data in a transaction
      this.db.transaction(() => {
        this.db.exec(schemaLines.join('\n'));

        // Verify the baseline was applied correctly
        const appliedVersion = this.getCurrentVersion();
        if (appliedVersion !== baselineVersion) {
          throw new Error(
            `Baseline application failed: expected version ${baselineVersion}, got ${appliedVersion}`
          );
        }

        // Get checksum if available
        try {
          const checksumRow = this.db
            .prepare("SELECT value FROM settings WHERE key='baseline_checksum'")
            .get() as { value: string } | undefined;
          if (checksumRow) {
            result.checksum = checksumRow.value;
          }
        } catch {
          // Checksum is optional
        }
      })();

      result.success = true;
      logger.debug('Baseline schema v%d applied successfully', baselineVersion);

      return result;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      logger.error('Failed to apply baseline schema v%d: %s', baselineVersion, result.error);
      return result;
    }
  }

  /**
   * Attempt to recover from a partial migration state
   */
  async recoverPartialMigration(): Promise<MigrationResult[]> {
    logger.warn('Attempting to recover from partial migration state');

    try {
      const currentVersion = this.getCurrentVersion();
      logger.debug('Current version in partial state: %d', currentVersion);

      // For now, attempt to continue with normal migrations
      // In a more sophisticated implementation, we might have specific recovery logic
      return await this.runMigrations();
    } catch (error) {
      logger.error(
        'Failed to recover from partial migration: %s',
        error instanceof Error ? error.message : String(error)
      );
      throw new Error(
        `Migration recovery failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the path to the baseline schema file
   */
  private getBaselineSchemaPath(version: number): string {
    // Vite bundles all main-process TS into a single dist-electron/main.cjs,
    // so __dirname is dist-electron/ at runtime. The build copies SQL files
    // into the same directory. We check both __dirname (bundled build) and
    // the original source-relative path (for any unbundled/test scenarios).
    const searchDirs = [__dirname, path.join(__dirname, '..')];

    for (const dir of searchDirs) {
      const versionedPath = path.join(dir, `baseline-schema-v${version}.sql`);
      if (fs.existsSync(versionedPath)) {
        return versionedPath;
      }

      const genericPath = path.join(dir, 'baseline-schema.sql');
      if (fs.existsSync(genericPath)) {
        return genericPath;
      }
    }

    throw new Error(`No baseline schema file found for version ${version}`);
  }

  /**
   * Check if baseline schema is available
   */
  hasBaseline(version = 9): boolean {
    try {
      this.getBaselineSchemaPath(version);
      return true;
    } catch {
      return false;
    }
  }
}
