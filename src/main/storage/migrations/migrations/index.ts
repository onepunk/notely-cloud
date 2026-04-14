/**
 * Migration registry - exports all database migrations
 */

import { Migration } from '../MigrationRunner';

import { migration002SchemaAlignment } from './002-schema-alignment';
import { migration003SyncTables } from './003-sync-tables';
import { migration004CalendarEventsSchema } from './004-calendar-events-schema';

/**
 * All migrations in order
 * Fresh installations use baseline-schema.sql (version 2)
 * Migrations 3+ add sync infrastructure
 */
export const ALL_MIGRATIONS: Migration[] = [
  migration002SchemaAlignment,
  migration003SyncTables,
  migration004CalendarEventsSchema,
];
