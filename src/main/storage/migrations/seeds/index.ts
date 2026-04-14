/**
 * Seed data registry - exports all seed functions
 */

export { DEFAULT_BINDERS, seedDefaultBinders, type DefaultBinder } from './defaultBinders';
export {
  DEFAULT_SETTINGS,
  seedDefaultSettings,
  getDefaultSetting,
  validateDefaultSettings,
  type DefaultSetting,
} from './defaultSettings';

import { Database } from 'better-sqlite3-multiple-ciphers';

import { logger } from '../../../logger';

import { seedDefaultBinders } from './defaultBinders';
import { seedDefaultSettings } from './defaultSettings';

/**
 * Run all seed functions in the correct order
 */
export function runAllSeeds(db: Database): void {
  logger.info('Running database seeds...');

  // Seed settings first (required for other seeds)
  seedDefaultSettings(db);

  // Seed default binders
  seedDefaultBinders();

  logger.info('Database seeding completed');
}
