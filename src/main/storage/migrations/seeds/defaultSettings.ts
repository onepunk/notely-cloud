import { Database } from 'better-sqlite3-multiple-ciphers';

import { logger } from '../../../logger';

export interface DefaultSetting {
  key: string;
  value: string;
  description: string;
}

/**
 * Default settings that are seeded when the database is first created
 * These are foundational settings required for the application to function
 */
export const DEFAULT_SETTINGS: DefaultSetting[] = [
  {
    key: 'app.locale',
    value: 'en',
    description: 'Application locale/language',
  },
];

/**
 * Seeds default settings if they don't exist
 * This is used both in migrations and for ensuring settings exist
 */
export function seedDefaultSettings(db: Database): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)');
  let seededCount = 0;

  for (const setting of DEFAULT_SETTINGS) {
    const result = stmt.run(setting.key, setting.value);
    if (result.changes > 0) {
      seededCount++;
    }
  }

  if (seededCount > 0) {
    logger.info(`Seeded ${seededCount} default settings`);
  }
}

/**
 * Get a default setting value by key
 */
export function getDefaultSetting(key: string): string | undefined {
  const setting = DEFAULT_SETTINGS.find((s) => s.key === key);
  return setting?.value;
}

/**
 * Validate that all required settings exist in the database
 */
export function validateDefaultSettings(db: Database): { valid: boolean; missing: string[] } {
  const getSetting = db.prepare('SELECT key FROM settings WHERE key = ?');
  const missing: string[] = [];

  for (const setting of DEFAULT_SETTINGS) {
    const result = getSetting.get(setting.key);
    if (!result) {
      missing.push(setting.key);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}
