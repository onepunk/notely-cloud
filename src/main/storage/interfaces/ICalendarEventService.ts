/**
 * Calendar event storage and caching interface
 */
export type CalendarEventCacheRecord = {
  accountId: string;
  eventId: string;
  provider?: string | null;
  calendarId?: string | null;
  title: string;
  description?: string | null;
  location?: string | null;
  startTime: number;
  endTime: number;
  isAllDay: boolean;
  isCancelled: boolean;
  lastModified?: number | null;
  rawPayload: unknown;
  syncedAt: number;
  createdAt: number;
  updatedAt: number;
};

export type CalendarEventRangeInfo = {
  rangeStart: number;
  rangeEnd: number;
  syncedAt: number;
};

export type CalendarEventListResult = {
  events: unknown[];
  syncedAt: number | null;
};

export interface ICalendarEventService {
  /**
   * List cached events for the given account and time range with full metadata.
   * Returns structured cache records sourced from the local database.
   */
  listRangeRecords(
    accountId: string,
    rangeStart: number,
    rangeEnd: number
  ): Promise<CalendarEventCacheRecord[]>;

  /**
   * List cached events for the given account and time range.
   * Returns the raw payloads preserved from the remote source.
   */
  listRange(
    accountId: string,
    rangeStart: number,
    rangeEnd: number
  ): Promise<CalendarEventListResult>;

  /**
   * Replace all events for the specified time range with the provided collection
   * and record the time the range was last synced.
   */
  replaceRange(
    accountId: string,
    rangeStart: number,
    rangeEnd: number,
    events: unknown[],
    syncedAt: number
  ): Promise<void>;

  /**
   * Clear all cached calendar data for the given account.
   */
  clearAccount(accountId: string): Promise<void>;
}
