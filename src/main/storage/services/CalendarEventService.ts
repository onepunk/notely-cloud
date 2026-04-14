import crypto from 'node:crypto';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { logger } from '../../logger';
import { TransactionManager } from '../core/TransactionManager';
import {
  type CalendarEventCacheRecord,
  type CalendarEventListResult,
  type ICalendarEventService,
} from '../interfaces/ICalendarEventService';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';

type CacheableEventDetails = {
  eventId: string;
  provider: string | null;
  calendarId: string | null;
  title: string;
  description: string | null;
  location: string | null;
  startTime: number;
  endTime: number;
  isAllDay: boolean;
  isCancelled: boolean;
  lastModified: number | null;
};

/**
 * CalendarEventService - manages local caching for remote calendar events
 */
export class CalendarEventService implements ICalendarEventService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager
  ) {}

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  async listRange(
    accountId: string,
    rangeStart: number,
    rangeEnd: number
  ): Promise<CalendarEventListResult> {
    return await this.transactionManager.readOnly(() => {
      const rows = this.db
        .prepare(
          `
          SELECT raw_payload, synced_at
          FROM calendar_events
          WHERE account_id = ?
            AND NOT (end_time < ? OR start_time > ?)
          ORDER BY start_time ASC, event_id ASC
        `
        )
        .all(accountId, rangeStart, rangeEnd) as Array<{ raw_payload: string; synced_at: number }>;

      const events: unknown[] = [];
      for (const row of rows) {
        try {
          events.push(JSON.parse(row.raw_payload));
        } catch (error) {
          logger.warn('CalendarEventService: Failed to parse cached event payload', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      const rangeEntry = this.db
        .prepare(
          `
          SELECT synced_at
          FROM calendar_event_sync_ranges
          WHERE account_id = ? AND range_start = ? AND range_end = ?
        `
        )
        .get(accountId, rangeStart, rangeEnd) as { synced_at: number } | undefined;

      const syncedAt =
        rangeEntry?.synced_at ??
        (rows.length > 0
          ? ((
              this.db
                .prepare(
                  `
                SELECT MAX(synced_at) AS synced_at
                FROM calendar_events
                WHERE account_id = ?
              `
                )
                .get(accountId) as { synced_at: number | null }
            ).synced_at ?? null)
          : null);

      return {
        events,
        syncedAt: typeof syncedAt === 'number' ? syncedAt : null,
      };
    });
  }

  async listRangeRecords(
    accountId: string,
    rangeStart: number,
    rangeEnd: number
  ): Promise<CalendarEventCacheRecord[]> {
    return await this.transactionManager.readOnly(() => {
      const rows = this.db
        .prepare(
          `
          SELECT
            account_id,
            event_id,
            provider,
            calendar_id,
            title,
            description,
            location,
            start_time,
            end_time,
            is_all_day,
            is_cancelled,
            last_modified,
            raw_payload,
            synced_at,
            created_at,
            updated_at
          FROM calendar_events
          WHERE account_id = ?
            AND NOT (end_time < ? OR start_time > ?)
          ORDER BY start_time ASC, event_id ASC
        `
        )
        .all(accountId, rangeStart, rangeEnd) as Array<{
        account_id: string;
        event_id: string;
        provider: string | null;
        calendar_id: string | null;
        title: string;
        description: string | null;
        location: string | null;
        start_time: number;
        end_time: number;
        is_all_day: number;
        is_cancelled: number;
        last_modified: number | null;
        raw_payload: string;
        synced_at: number;
        created_at: number;
        updated_at: number;
      }>;

      return rows.map((row) => {
        let rawPayload: unknown = row.raw_payload;
        try {
          rawPayload = JSON.parse(row.raw_payload);
        } catch (error) {
          logger.debug('CalendarEventService: Failed to parse cached event payload', {
            error: error instanceof Error ? error.message : error,
            eventId: row.event_id,
          });
        }

        return {
          accountId: row.account_id,
          eventId: row.event_id,
          provider: row.provider,
          calendarId: row.calendar_id,
          title: row.title,
          description: row.description,
          location: row.location,
          startTime: row.start_time,
          endTime: row.end_time,
          isAllDay: row.is_all_day === 1,
          isCancelled: row.is_cancelled === 1,
          lastModified: row.last_modified,
          rawPayload,
          syncedAt: row.synced_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
    });
  }

  async replaceRange(
    accountId: string,
    rangeStart: number,
    rangeEnd: number,
    events: unknown[],
    syncedAt: number
  ): Promise<void> {
    await this.transactionManager.execute(() => {
      // Remove existing cached events that overlap with the requested window
      this.db
        .prepare(
          `
          DELETE FROM calendar_events
          WHERE account_id = ?
            AND NOT (end_time < ? OR start_time > ?)
        `
        )
        .run(accountId, rangeStart, rangeEnd);

      const insert = this.db.prepare(
        `
        INSERT INTO calendar_events (
          account_id,
          event_id,
          provider,
          calendar_id,
          title,
          description,
          location,
          start_time,
          end_time,
          is_all_day,
          is_cancelled,
          last_modified,
          raw_payload,
          synced_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, event_id) DO UPDATE SET
          provider = excluded.provider,
          calendar_id = excluded.calendar_id,
          title = excluded.title,
          description = excluded.description,
          location = excluded.location,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          is_all_day = excluded.is_all_day,
          is_cancelled = excluded.is_cancelled,
          last_modified = excluded.last_modified,
          raw_payload = excluded.raw_payload,
          synced_at = excluded.synced_at,
          updated_at = excluded.updated_at
      `
      );

      const now = Date.now();
      events.forEach((event, index) => {
        const details = this.extractDetails(event, index);
        if (!details) {
          return;
        }

        try {
          const rawPayload = JSON.stringify(event);
          insert.run(
            accountId,
            details.eventId,
            details.provider,
            details.calendarId,
            details.title,
            details.description,
            details.location,
            details.startTime,
            details.endTime,
            details.isAllDay ? 1 : 0,
            details.isCancelled ? 1 : 0,
            details.lastModified,
            rawPayload,
            syncedAt,
            now,
            now
          );
        } catch (error) {
          logger.warn('CalendarEventService: Failed to cache calendar event', {
            error: error instanceof Error ? error.message : error,
          });
        }
      });

      this.db
        .prepare(
          `
          INSERT INTO calendar_event_sync_ranges(account_id, range_start, range_end, synced_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id, range_start, range_end) DO UPDATE SET
            synced_at = excluded.synced_at
        `
        )
        .run(accountId, rangeStart, rangeEnd, syncedAt);
    });
  }

  async clearAccount(accountId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      this.db.prepare(`DELETE FROM calendar_event_sync_ranges WHERE account_id = ?`).run(accountId);
      this.db.prepare(`DELETE FROM calendar_events WHERE account_id = ?`).run(accountId);
    });
  }

  private extractDetails(event: unknown, fallbackIndex: number): CacheableEventDetails | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const objectEvent = event as Record<string, unknown>;

    const startDate = this.parseDate(
      objectEvent.start ??
        objectEvent.startTime ??
        objectEvent.start_date ??
        (objectEvent as { start_time?: unknown }).start_time
    );
    const endDate = this.parseDate(
      objectEvent.end ??
        objectEvent.endTime ??
        objectEvent.end_date ??
        (objectEvent as { end_time?: unknown }).end_time
    );

    if (!startDate || !endDate) {
      return null;
    }

    const title =
      this.asString(objectEvent.subject) ||
      this.asString(objectEvent.title) ||
      this.asString(objectEvent.summary) ||
      'Untitled meeting';

    const eventId =
      this.asString(objectEvent.id) ||
      this.asString(objectEvent.calendar_event_id) ||
      this.generateFallbackId(title, startDate.getTime(), endDate.getTime(), fallbackIndex);

    const provider =
      this.asString(objectEvent.provider) ||
      this.asString(objectEvent.calendar_provider) ||
      this.asString(this.getFromObject(objectEvent.source, 'provider'));

    const calendarId =
      this.asString(objectEvent.calendar_id) ||
      this.asString(objectEvent.calendarId) ||
      this.getStringFromObject(objectEvent.calendar, 'id');

    const description =
      this.asString(objectEvent.description) ||
      this.asString(objectEvent.bodyPreview) ||
      this.getStringFromObject(objectEvent.body, 'content');

    const location =
      this.getStringFromObject(objectEvent.location, 'displayName') ||
      this.asString(objectEvent.location) ||
      this.asString(objectEvent.resourceLocation);

    const isCancelled =
      this.asBoolean(objectEvent.isCancelled) ||
      this.asBoolean(objectEvent.is_canceled) ||
      this.asString(objectEvent.status)?.toLowerCase() === 'cancelled';

    const isAllDay =
      this.asBoolean(objectEvent.isAllDay) ||
      this.asBoolean(objectEvent.is_all_day) ||
      this.asBoolean(objectEvent.allDay);

    const lastModified =
      this.parseDate(
        objectEvent.lastModified ||
          objectEvent.lastModifiedDateTime ||
          objectEvent.calendar_last_modified ||
          objectEvent.updated_at
      )?.getTime() ?? null;

    return {
      eventId,
      provider: provider || null,
      calendarId: calendarId || null,
      title,
      description: description || null,
      location: location || null,
      startTime: startDate.getTime(),
      endTime: endDate.getTime(),
      isAllDay,
      isCancelled,
      lastModified,
    };
  }

  private parseDate(value: unknown): Date | null {
    if (!value) {
      return null;
    }

    if (value instanceof Date) {
      return new Date(value.getTime());
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return new Date(value);
    }

    if (typeof value === 'string') {
      const normalized =
        /[zZ]|[+-]\d{2}:\d{2}$/.test(value) || value.endsWith('Z') ? value : `${value}Z`;
      const date = new Date(normalized);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    if (typeof value === 'object') {
      const candidate =
        (value as { dateTime?: unknown }).dateTime ??
        (value as { startTime?: unknown }).startTime ??
        (value as { endTime?: unknown }).endTime ??
        (value as { time?: unknown }).time ??
        (value as { value?: unknown }).value;
      return this.parseDate(candidate);
    }

    return null;
  }

  private asString(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  }

  private asBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    if (typeof value === 'string') {
      return ['true', '1', 'yes', 'y'].includes(value.toLowerCase());
    }

    return false;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private getFromObject(value: unknown, key: string): unknown {
    if (this.isRecord(value) && key in value) {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }

  private getStringFromObject(value: unknown, key: string): string | null {
    return this.asString(this.getFromObject(value, key));
  }

  private generateFallbackId(title: string, startMs: number, endMs: number, index: number): string {
    const hash = crypto.createHash('sha1');
    hash.update(title);
    hash.update(String(startMs));
    hash.update(String(endMs));
    hash.update(String(index));
    return `local-${hash.digest('hex')}`;
  }
}
