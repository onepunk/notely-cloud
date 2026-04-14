import { Button, Spinner } from '@fluentui/react-components';
import * as React from 'react';

import { CalendarView } from '../../features/calendar/components/CalendarView';
import { formatErrorForDisplay } from '../../shared/error';
import { useIsAuthenticated } from '../../shared/hooks/useAuthStore';

import styles from './CalendarPage.module.css';

type CalendarStatus = {
  connected: boolean;
  syncStatus?: string | null;
  lastSyncTime?: string | null;
  errorMessage?: string | null;
};

type RawCalendarEvent = Record<string, unknown> & {
  id?: string;
  subject?: string;
  title?: string;
  summary?: string;
  start?: unknown;
  startTime?: unknown;
  startDate?: unknown;
  end?: unknown;
  endTime?: unknown;
  endDate?: unknown;
};

type DayEvent = {
  id: string;
  title: string;
  time?: string;
  endTime?: string;
  description?: string | null;
};

const normalizeDate = (date: Date): Date => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const formatIsoDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const ensureIsoTimezone = (value: string): string => {
  if (!value) return value;
  return /[Z+-]/.test(value) ? value : `${value}Z`;
};

const coerceDate = (value: unknown): Date | null => {
  if (!value) return null;
  if (value instanceof Date) {
    return new Date(value);
  }
  if (typeof value === 'string') {
    const parsed = new Date(ensureIsoTimezone(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === 'object') {
    const candidate =
      (value as { dateTime?: string }).dateTime ??
      (value as { startTime?: string }).startTime ??
      (value as { endTime?: string }).endTime ??
      (value as { time?: string }).time ??
      (value as { value?: string }).value;
    if (typeof candidate === 'string') {
      return coerceDate(candidate);
    }
  }
  return null;
};

const toTimeString = (date: Date | null): string | undefined => {
  if (!date) return undefined;
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
};

const getMonthKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const sanitizeDescription = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  let text = value.replace(/<hr[^>]*>[\s\S]*?<hr[^>]*>/gi, ' ');
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/https?:\/\/\S+/gi, ' ');
  text = text.replace(/teams\.microsoft\.com\S*/gi, ' ');
  text = text.replace(/\bJoin\s+(?:Microsoft\s+)?Teams\s+Meeting\b/gi, ' ');
  text = text.replace(/\bJoin on (?:your computer or mobile app|the web)\b/gi, ' ');
  text = text.replace(/\bMeeting\s+ID:\s*\S+/gi, ' ');
  text = text.replace(/\bPasscode:\s*\S+/gi, ' ');
  text = text.replace(/Microsoft Teams.*?Meeting options\.?/gis, ' ');
  text = text.replace(/[-=_]{4,}[\s\S]*?[-=_]{4,}/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) {
    return null;
  }

  if (text.length > 500) {
    return `${text.slice(0, 497)}…`;
  }

  return text;
};

const extractDescription = (event: RawCalendarEvent): string | null => {
  const direct =
    (typeof event.description === 'string' && event.description) ||
    (typeof (event as { notes?: unknown }).notes === 'string' &&
      (event as { notes?: string }).notes) ||
    (typeof (event as { summary?: unknown }).summary === 'string' &&
      (event as { summary?: string }).summary);

  if (direct) {
    const sanitized = sanitizeDescription(direct);
    if (sanitized) {
      return sanitized;
    }
  }

  const bodyPreview =
    typeof (event as { bodyPreview?: unknown }).bodyPreview === 'string'
      ? (event as { bodyPreview?: string }).bodyPreview
      : null;
  if (bodyPreview) {
    const sanitized = sanitizeDescription(bodyPreview);
    if (sanitized) {
      return sanitized;
    }
  }

  const body = (event as { body?: unknown }).body;
  if (
    typeof body === 'object' &&
    body &&
    'content' in body &&
    typeof (body as { content: unknown }).content === 'string'
  ) {
    const sanitized = sanitizeDescription((body as { content: string }).content);
    if (sanitized) {
      return sanitized;
    }
  }

  const details =
    typeof (event as { details?: unknown }).details === 'string'
      ? (event as { details?: string }).details
      : null;
  if (details) {
    const sanitized = sanitizeDescription(details);
    if (sanitized) {
      return sanitized;
    }
  }

  return null;
};

const mapEventsByDay = (events: RawCalendarEvent[]): Record<string, DayEvent[]> => {
  const buckets: Record<string, DayEvent[]> = {};

  events.forEach((event, index) => {
    const startDate =
      coerceDate(event.start) ??
      coerceDate(event.startTime) ??
      coerceDate(event.startDate) ??
      coerceDate((event as { start_time?: unknown }).start_time);

    if (!startDate) {
      return;
    }

    const normalizedDay = formatIsoDate(normalizeDate(startDate));
    if (!buckets[normalizedDay]) {
      buckets[normalizedDay] = [];
    }

    const endDate =
      coerceDate(event.end) ??
      coerceDate(event.endTime) ??
      coerceDate(event.endDate) ??
      coerceDate((event as { end_time?: unknown }).end_time);

    const id =
      typeof event.id === 'string' && event.id.length > 0
        ? event.id
        : `${(event.subject || event.title || event.summary || 'event').toString()}-${
            startDate.getTime() + index
          }`;
    const title =
      (typeof event.subject === 'string' && event.subject) ||
      (typeof event.title === 'string' && event.title) ||
      (typeof event.summary === 'string' && event.summary) ||
      'Untitled meeting';

    const startTime = toTimeString(startDate) ?? '08:00';
    const endTime = toTimeString(endDate);
    const description = extractDescription(event);

    buckets[normalizedDay].push({
      id,
      title,
      time: startTime,
      endTime: endTime && endTime !== startTime ? endTime : undefined,
      description,
    });
  });

  Object.values(buckets).forEach((bucket) => {
    bucket.sort((a, b) => {
      const timeA = a.time ?? '00:00';
      const timeB = b.time ?? '00:00';
      return timeA.localeCompare(timeB);
    });
  });

  return buckets;
};

const CalendarPage: React.FC = () => {
  const isAuthenticated = useIsAuthenticated();
  const [status, setStatus] = React.useState<CalendarStatus | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [eventsByMonth, setEventsByMonth] = React.useState<Record<string, RawCalendarEvent[]>>({});
  const [visibleMonth, setVisibleMonth] = React.useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [eventsLoading, setEventsLoading] = React.useState(false);
  const [eventsError, setEventsError] = React.useState<string | null>(null);
  const [pollingConnection, setPollingConnection] = React.useState(false);

  const loadStatus = React.useCallback(async () => {
    try {
      const nextStatus = await window.api.calendar.getStatus();
      setStatus(nextStatus);
      setStatusError(null);
      return nextStatus;
    } catch (error) {
      const message = formatErrorForDisplay(error, 'E6001');
      setStatus({ connected: false, errorMessage: null });
      setStatusError(message);
      return null;
    }
  }, []);

  const loadEvents = React.useCallback(
    async (month: Date, options: { force?: boolean } = {}) => {
      if (!status?.connected) {
        return;
      }

      const normalized = new Date(month.getFullYear(), month.getMonth(), 1);
      const key = getMonthKey(normalized);
      if (!options.force && eventsByMonth[key]) {
        return;
      }

      const monthStart = new Date(normalized);
      const monthEnd = new Date(
        normalized.getFullYear(),
        normalized.getMonth() + 1,
        0,
        23,
        59,
        59,
        999
      );

      setEventsLoading(true);
      try {
        const response = await window.api.calendar.listEvents({
          startTime: monthStart.toISOString(),
          endTime: monthEnd.toISOString(),
          maxResults: 200,
        });

        const data = Array.isArray(response) ? (response as RawCalendarEvent[]) : [];
        setEventsByMonth((prev) => ({
          ...prev,
          [key]: data,
        }));
        setEventsError(null);
      } catch (error) {
        const message = formatErrorForDisplay(error, 'E6001', { action: 'loadEvents' });
        setEventsError(message);
      } finally {
        setEventsLoading(false);
      }
    },
    [eventsByMonth, status?.connected]
  );

  const handleMonthChange = React.useCallback((month: Date) => {
    setVisibleMonth(new Date(month.getFullYear(), month.getMonth(), 1));
  }, []);

  const handleRefreshEvents = React.useCallback(() => {
    loadEvents(visibleMonth, { force: true });
  }, [loadEvents, visibleMonth]);

  const handleConnectCalendar = React.useCallback(async () => {
    try {
      setStatusError(null);
      const started = await window.api.calendar.startConnect();
      if (started) {
        setPollingConnection(true);
      }
    } catch (error) {
      const message = formatErrorForDisplay(error, 'E6001', { action: 'startConnect' });
      setStatusError(message);
      setPollingConnection(false);
    }
  }, []);

  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  React.useEffect(() => {
    if (!status?.connected) {
      return;
    }
    loadEvents(visibleMonth);
  }, [status?.connected, visibleMonth, loadEvents]);

  React.useEffect(() => {
    if (!window.api?.calendar?.onConnectResult) {
      return undefined;
    }

    const unsubscribe = window.api.calendar.onConnectResult((result) => {
      setPollingConnection(false);

      if (result.canceled) {
        return;
      }

      if (result.success) {
        setStatusError(null);
        loadStatus();
      } else if (result.error) {
        setStatusError(result.error);
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [loadStatus]);

  React.useEffect(() => {
    if (!pollingConnection) {
      return undefined;
    }

    if (status?.connected) {
      setPollingConnection(false);
      return undefined;
    }

    const interval = window.setInterval(() => {
      loadStatus();
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [pollingConnection, status?.connected, loadStatus]);

  const currentMonthKey = React.useMemo(() => getMonthKey(visibleMonth), [visibleMonth]);
  const monthEvents = React.useMemo(
    () => eventsByMonth[currentMonthKey] ?? [],
    [eventsByMonth, currentMonthKey]
  );
  const eventsByDay = React.useMemo(() => mapEventsByDay(monthEvents), [monthEvents]);

  // Show loading spinner only while initial status is being determined
  if (!status) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.state}>
          <Spinner size="large" />
          <p className={styles.message}>Loading calendar…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      {eventsError && status.connected && (
        <div className={styles.banner} role="status">
          <span>{eventsError}</span>
          <Button appearance="subtle" size="small" onClick={handleRefreshEvents}>
            Retry
          </Button>
        </div>
      )}

      <div className={styles.calendarSection}>
        <CalendarView
          eventsByDay={eventsByDay}
          onMonthChange={handleMonthChange}
          onRefresh={status.connected ? handleRefreshEvents : undefined}
          isRefreshing={eventsLoading}
          isConnected={status.connected}
          onConnect={handleConnectCalendar}
          isConnecting={pollingConnection}
          isSignedIn={isAuthenticated}
        />
      </div>
    </div>
  );
};

export default CalendarPage;
