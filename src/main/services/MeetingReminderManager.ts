import { EventEmitter } from 'node:events';

import type {
  MeetingReminderState,
  MeetingReminderTarget,
  MeetingReminderTriggerPayload,
  MeetingReminderSnoozeMap,
} from '../../common/meetingReminder';
import { logger } from '../logger';
import { type IStorageService } from '../storage';
import type { CalendarEventCacheRecord } from '../storage/interfaces/ICalendarEventService';

const DEFAULT_LEAD_TIME_MS = 60_000; // 60 seconds before meeting start
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_LOOKAHEAD_WINDOW_MS = 60 * 60_000; // 60 minutes

const SETTINGS_PREFIX = 'reminders.meeting';
const SETTINGS_ENABLED_KEY = `${SETTINGS_PREFIX}.enabled`;
const SETTINGS_MUTE_UNTIL_KEY = `${SETTINGS_PREFIX}.mute_until`;
const SETTINGS_SNOOZES_KEY = `${SETTINGS_PREFIX}.snoozes`;

export type MeetingReminderManagerEvents = 'reminder-due' | 'state-changed' | 'schedule-updated';

export interface MeetingReminderManagerDependencies {
  storage: IStorageService;
  getActiveTranscriptionSessionId: () => string | null;
  pollIntervalMs?: number;
  leadTimeMs?: number;
  lookaheadWindowMs?: number;
  now?: () => number;
}

interface ScheduledReminder {
  timer: NodeJS.Timeout;
  reminderTime: number;
  event: MeetingReminderTarget;
}

/**
 * MeetingReminderManager coordinates calendar polling, reminder scheduling,
 * snooze persistence, and mute behavior for meeting notifications.
 *
 * The manager operates entirely on locally cached calendar data and emits
 * events when reminders should be displayed. Renderer/UI layers are expected
 * to listen for `reminder-due` and present the popup accordingly.
 */
export class MeetingReminderManager extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly leadTimeMs: number;
  private readonly lookaheadWindowMs: number;
  private readonly getNow: () => number;

  private pollTimer: NodeJS.Timeout | null = null;
  private scheduledReminders: Map<string, ScheduledReminder> = new Map();
  private snoozes: Map<string, number> = new Map();
  private muteUntil: number | null = null;
  private enabled = true;
  private running = false;
  private cachedAccountId: string | null = null;

  constructor(private deps: MeetingReminderManagerDependencies) {
    super();

    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leadTimeMs = Math.max(5_000, deps.leadTimeMs ?? DEFAULT_LEAD_TIME_MS);
    this.lookaheadWindowMs = Math.max(
      this.leadTimeMs,
      deps.lookaheadWindowMs ?? DEFAULT_LOOKAHEAD_WINDOW_MS
    );
    this.getNow = deps.now ?? (() => Date.now());
  }

  /**
   * Start reminder polling and scheduling.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.debug('MeetingReminderManager: start() called while already running');
      return;
    }

    logger.info('MeetingReminderManager: Starting reminder service');
    this.running = true;

    await this.loadPreferences();
    await this.refreshSchedule().catch((error) => {
      logger.error('MeetingReminderManager: Failed to prime schedule on start', {
        error: error instanceof Error ? error.message : error,
      });
    });

    this.schedulePolling();
  }

  /**
   * Stop reminder polling and clear any scheduled timers.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    logger.info('MeetingReminderManager: Stopping reminder service');
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.clearScheduledReminders();
  }

  /**
   * Force a schedule refresh (e.g., when calendar cache updates).
   */
  async refreshSchedule(): Promise<void> {
    if (!this.running) {
      logger.debug('MeetingReminderManager: refreshSchedule called while stopped');
      return;
    }

    if (!this.enabled || this.isMuted()) {
      logger.debug('MeetingReminderManager: Skipping schedule refresh while muted/disabled');
      this.clearScheduledReminders();
      this.emitStateChanged();
      return;
    }

    const accountId = await this.resolveAccountId();
    if (!accountId) {
      logger.debug('MeetingReminderManager: No account ID available for reminders');
      this.clearScheduledReminders();
      this.emitStateChanged();
      return;
    }

    this.cachedAccountId = accountId;
    const now = this.getNow();
    const windowStart = now - 2 * 60_000; // include grace period for late refreshes
    const windowEnd = now + this.lookaheadWindowMs;

    let records: CalendarEventCacheRecord[] = [];
    try {
      records = await this.deps.storage.calendarEvents.listRangeRecords(
        accountId,
        windowStart,
        windowEnd
      );
    } catch (error) {
      logger.error('MeetingReminderManager: Failed to load cached calendar events', {
        error: error instanceof Error ? error.message : error,
      });
      return;
    }

    this.trimExpiredSnoozes(now);
    this.reconcileSchedule(records, now);
  }

  /**
   * Globally enable or disable reminders.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    await this.deps.storage.settings.set(SETTINGS_ENABLED_KEY, enabled ? 'true' : 'false');

    if (!enabled) {
      this.clearScheduledReminders();
    } else {
      await this.refreshSchedule();
    }

    this.emitStateChanged();
  }

  /**
   * Temporarily mute reminders until the specified timestamp.
   * Pass null to clear the mute window.
   */
  async setMuteUntil(timestamp: number | null): Promise<void> {
    this.muteUntil = timestamp;

    if (timestamp === null) {
      await this.deps.storage.settings.delete(SETTINGS_MUTE_UNTIL_KEY);
    } else {
      await this.deps.storage.settings.set(SETTINGS_MUTE_UNTIL_KEY, String(timestamp));
    }

    await this.refreshSchedule();
    this.emitStateChanged();
  }

  /**
   * Snooze a specific meeting reminder until the provided timestamp.
   */
  async snooze(eventKey: string, snoozeUntil: number): Promise<void> {
    if (!Number.isFinite(snoozeUntil)) {
      throw new Error('Snooze timestamp must be a finite number');
    }

    this.snoozes.set(eventKey, snoozeUntil);
    await this.persistSnoozes();
    await this.refreshSchedule();
    this.emitStateChanged();
  }

  /**
   * Clear a snooze entry for an event.
   */
  async clearSnooze(eventKey: string): Promise<void> {
    if (!this.snoozes.has(eventKey)) {
      return;
    }

    this.snoozes.delete(eventKey);
    await this.persistSnoozes();
    await this.refreshSchedule();
    this.emitStateChanged();
  }

  /**
   * Get a snapshot of the current reminder state for UI consumption.
   */
  getState(): MeetingReminderState {
    const snoozes: MeetingReminderSnoozeMap = Object.fromEntries(this.snoozes.entries());

    return {
      enabled: this.enabled,
      muteUntil: this.muteUntil,
      snoozes,
      scheduledCount: this.scheduledReminders.size,
    };
  }

  /**
   * Returns true if reminders are muted either permanently or until a future timestamp.
   */
  isMuted(): boolean {
    if (this.muteUntil === null) {
      return false;
    }

    const now = this.getNow();
    if (now >= this.muteUntil) {
      this.muteUntil = null;
      void this.deps.storage.settings.delete(SETTINGS_MUTE_UNTIL_KEY);
      return false;
    }

    return true;
  }

  private schedulePolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.pollTimer = setInterval(() => {
      this.refreshSchedule().catch((error) => {
        logger.error('MeetingReminderManager: refreshSchedule failed during poll', {
          error: error instanceof Error ? error.message : error,
        });
      });
    }, this.pollIntervalMs);
  }

  private clearScheduledReminders(): void {
    for (const [key, scheduled] of this.scheduledReminders.entries()) {
      clearTimeout(scheduled.timer);
      this.scheduledReminders.delete(key);
      logger.debug('MeetingReminderManager: Cleared scheduled reminder', { key });
    }
  }

  private trimExpiredSnoozes(now: number): void {
    let changed = false;
    for (const [key, until] of this.snoozes.entries()) {
      if (until <= now) {
        this.snoozes.delete(key);
        changed = true;
      }
    }

    if (changed) {
      void this.persistSnoozes();
    }
  }

  private reconcileSchedule(records: CalendarEventCacheRecord[], now: number): void {
    const nextKeys = new Set<string>();

    for (const record of records) {
      if (record.isCancelled || record.isAllDay) {
        continue;
      }

      const event = this.toReminderTarget(record);
      if (!event) {
        continue;
      }

      if (event.endTime <= now) {
        continue; // Skip past meetings
      }

      const eventKey = this.buildEventKey(event);
      nextKeys.add(eventKey);

      const reminderTime = this.computeReminderTimestamp(event, now);
      if (reminderTime === null) {
        continue;
      }

      const existing = this.scheduledReminders.get(eventKey);
      if (existing && existing.reminderTime === reminderTime) {
        continue;
      }

      if (existing) {
        clearTimeout(existing.timer);
        this.scheduledReminders.delete(eventKey);
      }

      const delay = Math.max(0, reminderTime - now);
      const timer = setTimeout(() => {
        this.handleReminderDue(eventKey, event, reminderTime);
      }, delay);

      this.scheduledReminders.set(eventKey, {
        timer,
        reminderTime,
        event,
      });

      logger.debug('MeetingReminderManager: Scheduled reminder', {
        eventKey,
        reminderTime,
        delay,
        title: event.title,
      });
    }

    // Cancel reminders that are no longer relevant
    for (const existingKey of Array.from(this.scheduledReminders.keys())) {
      if (!nextKeys.has(existingKey)) {
        const scheduled = this.scheduledReminders.get(existingKey);
        if (scheduled) {
          clearTimeout(scheduled.timer);
        }
        this.scheduledReminders.delete(existingKey);
        logger.debug('MeetingReminderManager: Removed obsolete reminder', { existingKey });
      }
    }

    this.emit('schedule-updated', this.getState());
  }

  private buildEventKey(event: MeetingReminderTarget): string {
    return `${event.accountId}::${event.eventId}::${event.startTime}`;
  }

  private computeReminderTimestamp(event: MeetingReminderTarget, now: number): number | null {
    const baseReminderTime = event.startTime - this.leadTimeMs;
    const snoozedUntil = this.snoozes.get(this.buildEventKey(event)) ?? null;

    if (snoozedUntil && snoozedUntil > now) {
      if (snoozedUntil >= event.endTime) {
        // Snooze extends past meeting end; drop the reminder entirely
        return null;
      }
      return snoozedUntil;
    }

    if (baseReminderTime < now) {
      if (event.startTime <= now) {
        return null; // Meeting already started
      }
      // Reminder window already passed; trigger immediately
      return now;
    }

    return baseReminderTime;
  }

  private handleReminderDue(eventKey: string, event: MeetingReminderTarget, reminderTime: number) {
    this.scheduledReminders.delete(eventKey);

    // Remove associated snooze entry once fired
    if (this.snoozes.delete(eventKey)) {
      void this.persistSnoozes();
    }

    const hasActiveTranscription = this.deps.getActiveTranscriptionSessionId() !== null;
    const payload: MeetingReminderTriggerPayload = {
      reminderTime,
      eventKey,
      event,
      snoozedUntil: null,
      hasActiveTranscription,
    };

    logger.info('MeetingReminderManager: Reminder due', {
      eventKey,
      title: event.title,
      startTime: event.startTime,
    });

    this.emit('reminder-due', payload);
    this.emitStateChanged();
  }

  hasActiveTranscriptionSession(): boolean {
    return this.deps.getActiveTranscriptionSessionId() !== null;
  }

  private async resolveAccountId(): Promise<string | null> {
    try {
      const accountId = await this.deps.storage.settings.get('auth.userId');

      if (!accountId) {
        logger.debug('MeetingReminderManager: auth settings missing userId');
      }

      return accountId;
    } catch (error) {
      logger.warn('MeetingReminderManager: Failed to read auth settings for account ID', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  private toReminderTarget(record: CalendarEventCacheRecord): MeetingReminderTarget | null {
    if (!record.startTime || !record.eventId) {
      return null;
    }

    let startTime = record.startTime;
    let endTime = record.endTime;

    // In some cases cached events may not contain millisecond timestamps.
    // Ensure reasonable defaults (15 minutes) if metadata is incomplete.
    if (!Number.isFinite(startTime)) {
      startTime = this.extractTimestamp(record.rawPayload, 'start') ?? 0;
    }
    if (!Number.isFinite(endTime)) {
      endTime = this.extractTimestamp(record.rawPayload, 'end') ?? startTime + 15 * 60_000;
    }

    if (startTime <= 0) {
      return null;
    }

    if (!Number.isFinite(endTime) || endTime <= startTime) {
      endTime = startTime + 15 * 60_000;
    }

    const title =
      record.title?.trim() || this.extractTitle(record.rawPayload) || 'Untitled meeting';

    return {
      accountId: record.accountId,
      eventId: record.eventId,
      startTime,
      endTime,
      title,
      description: record.description,
      location: record.location,
      isAllDay: record.isAllDay,
      rawPayload: record.rawPayload,
    };
  }

  private extractTimestamp(rawPayload: unknown, field: 'start' | 'end'): number | null {
    if (!rawPayload || typeof rawPayload !== 'object') {
      return null;
    }

    const value = (rawPayload as Record<string, unknown>)[field];
    if (!value) {
      return null;
    }

    const timestamp = this.tryParseDateTime(value);
    if (timestamp !== null) {
      return timestamp;
    }

    // Fallback for nested fields such as { start: { dateTime: '...' } }
    if (typeof value === 'object') {
      const candidate =
        this.tryParseDateTime((value as Record<string, unknown>).dateTime) ??
        this.tryParseDateTime((value as Record<string, unknown>).datetime) ??
        this.tryParseDateTime((value as Record<string, unknown>).time);
      return candidate;
    }

    return null;
  }

  private tryParseDateTime(value: unknown): number | null {
    if (typeof value === 'number') {
      return value;
    }

    if (typeof value === 'string' && value.length > 0) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : parsed;
    }

    return null;
  }

  private extractTitle(rawPayload: unknown): string | null {
    if (!rawPayload || typeof rawPayload !== 'object') {
      return null;
    }

    const data = rawPayload as Record<string, unknown>;

    const directTitle = data.title ?? data.subject ?? data.name;
    if (typeof directTitle === 'string' && directTitle.trim().length > 0) {
      return directTitle.trim();
    }

    if (typeof data.summary === 'string' && data.summary.trim().length > 0) {
      return data.summary.trim();
    }

    return null;
  }

  private async loadPreferences(): Promise<void> {
    try {
      const [enabled, muteUntil, snoozesJson] = await Promise.all([
        this.deps.storage.settings.get(SETTINGS_ENABLED_KEY),
        this.deps.storage.settings.get(SETTINGS_MUTE_UNTIL_KEY),
        this.deps.storage.settings.get(SETTINGS_SNOOZES_KEY),
      ]);

      this.enabled = enabled !== 'false';

      if (muteUntil) {
        const parsed = Number(muteUntil);
        this.muteUntil = Number.isFinite(parsed) ? parsed : null;
      } else {
        this.muteUntil = null;
      }

      if (snoozesJson) {
        try {
          const parsed = JSON.parse(snoozesJson) as MeetingReminderSnoozeMap;
          this.snoozes = new Map(
            Object.entries(parsed).filter(([_, value]) => Number.isFinite(value))
          );
        } catch (error) {
          logger.warn('MeetingReminderManager: Failed to parse snoozes from settings', {
            error: error instanceof Error ? error.message : error,
          });
          this.snoozes = new Map();
        }
      } else {
        this.snoozes = new Map();
      }

      this.emitStateChanged();
    } catch (error) {
      logger.warn('MeetingReminderManager: Failed to load preferences', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private async persistSnoozes(): Promise<void> {
    try {
      const payload: MeetingReminderSnoozeMap = Object.fromEntries(this.snoozes.entries());
      if (Object.keys(payload).length === 0) {
        await this.deps.storage.settings.delete(SETTINGS_SNOOZES_KEY);
      } else {
        await this.deps.storage.settings.set(SETTINGS_SNOOZES_KEY, JSON.stringify(payload));
      }
    } catch (error) {
      logger.warn('MeetingReminderManager: Failed to persist snoozes', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private emitStateChanged(): void {
    this.emit('state-changed', this.getState());
  }
}
