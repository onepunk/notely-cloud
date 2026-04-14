/**
 * Migration system exports
 */

// Core migration system
export { MigrationRunner, type Migration, type MigrationResult } from './MigrationRunner';

// Individual migrations
export * from './migrations';

// Seed data
export * from './seeds';

// Convenience imports
import { logger } from '../../logger';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';

import { MigrationRunner } from './MigrationRunner';
import { ALL_MIGRATIONS } from './migrations';
import { runAllSeeds } from './seeds';

/**
 * Create a fully configured migration runner with all migrations registered
 */
export function createMigrationRunner(databaseManager: IDatabaseManager): MigrationRunner {
  const runner = new MigrationRunner(databaseManager);

  // Register all migrations
  for (const migration of ALL_MIGRATIONS) {
    runner.registerMigration(migration);
  }

  return runner;
}

/**
 * Run migrations and seeds - complete database setup
 *
 * Fresh installations use baseline-schema.sql (version 1)
 * Future migrations will run after the baseline is applied
 */
export async function setupDatabase(databaseManager: IDatabaseManager): Promise<void> {
  const runner = createMigrationRunner(databaseManager);

  // Validate migration sequence
  const validation = runner.validateMigrationSequence();
  if (!validation.valid) {
    throw new Error(`Migration validation failed: ${validation.errors.join(', ')}`);
  }

  // Detect current database state
  const state = runner.detectDatabaseState();
  logger.info('Database state detected: %s', state);

  switch (state) {
    case 'fresh':
      // Use baseline schema for fresh installations
      if (runner.hasBaseline(2)) {
        logger.info('Applying baseline schema for fresh installation...');
        const baselineResult = await runner.applyBaseline(2);

        if (!baselineResult.success) {
          logger.error('Baseline application failed: %s', baselineResult.error);
          throw new Error(`Baseline application failed: ${baselineResult.error}`);
        }

        logger.info('Baseline schema v%d applied successfully', baselineResult.version);

        // After applying the baseline, run any subsequent migrations (version 2+)
        await runPendingMigrations(runner);
      } else {
        throw new Error('No baseline schema available for fresh installation');
      }
      break;

    case 'partial':
      logger.warn('Partial migration state detected, attempting recovery...');
      try {
        await runner.recoverPartialMigration();
        logger.info('Partial migration recovery completed');
      } catch (error) {
        logger.error(
          'Migration recovery failed: %s',
          error instanceof Error ? error.message : String(error)
        );
        throw new Error(
          `Database setup failed due to partial migration recovery: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      break;

    case 'migrated': {
      // Run any pending migrations
      await runPendingMigrations(runner);
      break;
    }
  }

  // Run seeds after schema is set up
  try {
    runAllSeeds(databaseManager.getDatabase());
    logger.info('Database seeds completed');
  } catch (error) {
    logger.warn(
      'Database seeding encountered issues (non-fatal): %s',
      error instanceof Error ? error.message : String(error)
    );
  }

  logger.info('Database setup completed successfully');
}

/**
 * Helper function to run pending migrations
 */
async function runPendingMigrations(runner: MigrationRunner): Promise<void> {
  const results = await runner.runMigrations();

  if (results.length > 0) {
    const failed = results.filter((r) => !r.success);
    if (failed.length > 0) {
      const errors = failed.map((r) => `Migration ${r.version}: ${r.error}`).join(', ');
      throw new Error(`Migration failed: ${errors}`);
    }
    logger.info('Applied %d migrations successfully', results.length);
  } else {
    logger.info('Database is up to date, no pending migrations');
  }
}
