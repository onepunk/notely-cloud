import { Button, Spinner } from '@fluentui/react-components';
import { ChevronLeft, ChevronRight, RefreshCcw } from 'lucide-react';
import * as React from 'react';

import styles from './CalendarView.module.css';

type CalendarEvent = {
  id: string;
  title: string;
  time?: string;
  endTime?: string;
};

type CalendarCell = {
  date: Date;
  iso: string;
  inCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
};

type WeekDay = {
  date: Date;
  iso: string;
  label: string;
  dayNumber: string;
  isToday: boolean;
  isSelected: boolean;
};

type TimeSlot = {
  iso: string;
  label: string;
  isHourStart: boolean;
};

type CalendarViewProps = {
  eventsByDay?: Record<string, CalendarEvent[]>;
  onMonthChange?: (month: Date) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  isConnected?: boolean;
  onConnect?: () => void;
  isConnecting?: boolean;
  isSignedIn?: boolean;
};

const WEEK_STARTS_ON_MONDAY = true; // TODO: respect locale

const MONTH_TITLE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
});

const DAY_NUMBER_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
});

const WEEKDAY_SHORT_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
});

const _WEEKDAY_LONG_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
});

const DAY_OF_MONTH_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

const WEEK_RANGE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
});

const TIME_LABEL_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

const TODAY_DATE = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  day: 'numeric',
});

const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;
const SLOT_INTERVAL_MINUTES = 30;
const SLOT_HEIGHT_PX = 36;
const TIME_COLUMN_WIDTH_PX = 72;
const DAY_START_MINUTES = DAY_START_HOUR * 60;
const DAY_END_MINUTES = DAY_END_HOUR * 60;
const DAY_TOTAL_MINUTES = DAY_END_MINUTES - DAY_START_MINUTES;
const PIXELS_PER_MINUTE = SLOT_HEIGHT_PX / SLOT_INTERVAL_MINUTES;
const MIN_EVENT_DURATION_MINUTES = SLOT_INTERVAL_MINUTES;
const MIN_EVENT_HEIGHT_PERCENT = Math.max(
  (MIN_EVENT_DURATION_MINUTES / DAY_TOTAL_MINUTES) * 100,
  2
);
const INITIAL_SCROLL_OFFSET_MINUTES = 120;
const EVENT_COLUMN_GAP_PERCENT = 2;
const SCROLLBAR_HIDE_DELAY_MS = 1000;
const CURRENT_TIME_UPDATE_INTERVAL_MS = 60_000;

const normalizeDate = (date: Date): Date => {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
};

const addDays = (date: Date, delta: number): Date => {
  const result = new Date(date);
  result.setDate(result.getDate() + delta);
  return normalizeDate(result);
};

const addMonths = (date: Date, delta: number): Date => {
  const result = new Date(date);
  result.setMonth(result.getMonth() + delta);
  return normalizeDate(result);
};

const startOfMonth = (date: Date): Date => {
  const result = normalizeDate(date);
  result.setDate(1);
  return result;
};

const startOfCalendarGrid = (reference: Date): Date => {
  const firstOfMonth = startOfMonth(reference);
  const dayIndex = firstOfMonth.getDay(); // 0 = Sunday ... 6 = Saturday
  const offset = WEEK_STARTS_ON_MONDAY ? (dayIndex === 0 ? 6 : dayIndex - 1) : dayIndex;
  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - offset);
  return start;
};

const startOfWeek = (reference: Date): Date => {
  const result = normalizeDate(reference);
  const dayIndex = result.getDay();
  const offset = WEEK_STARTS_ON_MONDAY ? (dayIndex === 0 ? -6 : 1 - dayIndex) : -dayIndex;
  result.setDate(result.getDate() + offset);
  return result;
};

const formatISODate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const buildCalendarCells = (activeDate: Date, selectedDate: Date): CalendarCell[] => {
  const cells: CalendarCell[] = [];
  const gridStart = startOfCalendarGrid(activeDate);
  const todayIso = formatISODate(normalizeDate(new Date()));
  const selectedIso = formatISODate(selectedDate);

  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const iso = formatISODate(date);
    cells.push({
      date,
      iso,
      inCurrentMonth: date.getMonth() === activeDate.getMonth(),
      isToday: iso === todayIso,
      isSelected: iso === selectedIso,
    });
  }

  return cells;
};

const buildWeekDays = (reference: Date, selectedIso: string): WeekDay[] => {
  const start = startOfWeek(reference);
  const todayIso = formatISODate(normalizeDate(new Date()));
  return Array.from({ length: 7 }, (_, index) => {
    const date = addDays(start, index);
    const iso = formatISODate(date);
    return {
      date,
      iso,
      label: WEEKDAY_SHORT_FORMATTER.format(date),
      dayNumber: DAY_NUMBER_FORMATTER.format(date),
      isToday: iso === todayIso,
      isSelected: iso === selectedIso,
    };
  });
};

const buildTimeSlots = (): TimeSlot[] => {
  const slots: TimeSlot[] = [];

  for (
    let minutes = DAY_START_MINUTES;
    minutes < DAY_END_MINUTES;
    minutes += SLOT_INTERVAL_MINUTES
  ) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    const iso = `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    const label = TIME_LABEL_FORMATTER.format(new Date(Date.UTC(2020, 0, 1, hours, remainder)));
    slots.push({
      iso,
      label,
      isHourStart: remainder === 0,
    });
  }

  return slots;
};

const formatWeekRange = (weekStart: Date): string => {
  const weekEnd = addDays(weekStart, 6);
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth();
  const sameYear = weekStart.getFullYear() === weekEnd.getFullYear();

  if (sameMonth && sameYear) {
    return `${WEEK_RANGE_FORMATTER.format(weekStart)} – ${DAY_NUMBER_FORMATTER.format(weekEnd)}`;
  }

  if (sameYear && !sameMonth) {
    return `${DAY_OF_MONTH_FORMATTER.format(weekStart)} – ${DAY_OF_MONTH_FORMATTER.format(weekEnd)}`;
  }

  return `${WEEK_RANGE_FORMATTER.format(weekStart)} – ${WEEK_RANGE_FORMATTER.format(weekEnd)}`;
};

const timeStringToMinutes = (time?: string): number | null => {
  if (!time) {
    return null;
  }

  const [hours, minutes] = time.split(':');
  if (hours === undefined || minutes === undefined) {
    return null;
  }

  const hourValue = Number.parseInt(hours, 10);
  const minuteValue = Number.parseInt(minutes, 10);

  if (Number.isNaN(hourValue) || Number.isNaN(minuteValue)) {
    return null;
  }

  return hourValue * 60 + minuteValue;
};

const minutesToTimeString = (minutes: number): string => {
  const hours = Math.floor(minutes / 60) % 24;
  const mins = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

const getCurrentMinutes = (): number => {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
};

type PositionedEvent = {
  id: string;
  title: string;
  description?: string | null;
  timeLabel: string;
  top: number;
  height: number;
  left: number;
  width: number;
};

type InternalPositionedEvent = {
  id: string;
  title: string;
  description?: string | null;
  startMinutes: number;
  endMinutes: number;
  column: number;
  columnsTotal: number;
  timeLabel: string;
};

const parseTimeToDate = (time?: string): Date | null => {
  if (!time) {
    return null;
  }

  const [hours, minutes] = time.split(':');
  if (hours === undefined || minutes === undefined) {
    return null;
  }

  const hourValue = Number.parseInt(hours, 10);
  const minuteValue = Number.parseInt(minutes, 10);

  if (Number.isNaN(hourValue) || Number.isNaN(minuteValue)) {
    return null;
  }

  const reference = new Date();
  reference.setHours(hourValue, minuteValue, 0, 0);
  return reference;
};

const formatEventTimeRange = (start?: string, end?: string): string | null => {
  const startDate = parseTimeToDate(start);
  if (!startDate) {
    return null;
  }

  const startLabel = TIME_LABEL_FORMATTER.format(startDate);

  const endDate = parseTimeToDate(end);
  if (endDate && endDate.getTime() !== startDate.getTime()) {
    const endLabel = TIME_LABEL_FORMATTER.format(endDate);
    return `${startLabel} – ${endLabel}`;
  }

  return startLabel;
};

const buildPositionedEvents = (events: CalendarEvent[]): PositionedEvent[] => {
  if (!events.length) {
    return [];
  }

  const normalized: InternalPositionedEvent[] = events
    .map((event) => {
      const absoluteStart = timeStringToMinutes(event.time) ?? DAY_START_MINUTES;
      const absoluteEndRaw =
        timeStringToMinutes(event.endTime) ?? absoluteStart + MIN_EVENT_DURATION_MINUTES;

      const absoluteEnd = Math.max(absoluteEndRaw, absoluteStart + MIN_EVENT_DURATION_MINUTES);

      const clampedStart = Math.min(Math.max(absoluteStart, DAY_START_MINUTES), DAY_END_MINUTES);
      const clampedEnd = Math.min(Math.max(absoluteEnd, clampedStart + 1), DAY_END_MINUTES);

      if (clampedStart >= DAY_END_MINUTES || clampedEnd <= DAY_START_MINUTES) {
        return null;
      }

      const relativeStart = clampedStart - DAY_START_MINUTES;
      let relativeEnd = clampedEnd - DAY_START_MINUTES;

      if (relativeEnd - relativeStart < MIN_EVENT_DURATION_MINUTES) {
        relativeEnd = Math.min(relativeStart + MIN_EVENT_DURATION_MINUTES, DAY_TOTAL_MINUTES);
      }

      if (relativeEnd <= relativeStart) {
        return null;
      }

      const timeLabel =
        formatEventTimeRange(
          minutesToTimeString(Math.max(absoluteStart, 0) % (24 * 60)),
          minutesToTimeString(Math.max(absoluteEnd, 0) % (24 * 60))
        ) ??
        formatEventTimeRange(minutesToTimeString(clampedStart), minutesToTimeString(clampedEnd)) ??
        'Time pending';

      return {
        id: event.id,
        title: event.title,
        description: event.description,
        startMinutes: relativeStart,
        endMinutes: Math.min(relativeEnd, DAY_TOTAL_MINUTES),
        column: 0,
        columnsTotal: 1,
        timeLabel,
      };
    })
    .filter((item): item is InternalPositionedEvent => item !== null)
    .sort((a, b) => {
      if (a.startMinutes === b.startMinutes) {
        return a.endMinutes - b.endMinutes;
      }
      return a.startMinutes - b.startMinutes;
    });

  if (!normalized.length) {
    return [];
  }

  const positioned: InternalPositionedEvent[] = [];
  let active: InternalPositionedEvent[] = [];

  normalized.forEach((item) => {
    active = active.filter((candidate) => candidate.endMinutes > item.startMinutes);
    const usedColumns = active.map((candidate) => candidate.column);
    let column = 0;
    while (usedColumns.includes(column)) {
      column += 1;
    }

    const placed: InternalPositionedEvent = { ...item, column };
    positioned.push(placed);
    active.push(placed);
  });

  const overlaps: Array<Set<number>> = positioned.map(() => new Set<number>());
  for (let i = 0; i < positioned.length; i += 1) {
    for (let j = i + 1; j < positioned.length; j += 1) {
      const a = positioned[i];
      const b = positioned[j];
      if (a.startMinutes < b.endMinutes && b.startMinutes < a.endMinutes) {
        overlaps[i].add(j);
        overlaps[j].add(i);
      }
    }
  }

  const visited = new Set<number>();
  const clusterMaxColumns = new Map<number, number>();
  const clusterMembership = new Map<number, number>();

  const assignCluster = (index: number, clusterId: number) => {
    const queue: number[] = [index];
    const nodes: number[] = [];
    visited.add(index);

    while (queue.length) {
      const current = queue.shift()!;
      nodes.push(current);
      overlaps[current].forEach((neighbor) => {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      });
    }

    const maxColumn = Math.max(...nodes.map((nodeIndex) => positioned[nodeIndex].column)) + 1;
    clusterMaxColumns.set(clusterId, maxColumn);
    nodes.forEach((nodeIndex) => {
      clusterMembership.set(nodeIndex, clusterId);
    });
  };

  let clusterId = 0;
  for (let i = 0; i < positioned.length; i += 1) {
    if (!visited.has(i)) {
      assignCluster(i, clusterId);
      clusterId += 1;
    }
  }

  return positioned.map((item, index) => {
    const componentId = clusterMembership.get(index) ?? 0;
    const columnsTotal = clusterMaxColumns.get(componentId) ?? 1;

    const totalGap = (columnsTotal - 1) * EVENT_COLUMN_GAP_PERCENT;
    const width = columnsTotal > 0 ? Math.max((100 - totalGap) / columnsTotal, 0) : 100 - totalGap;
    const left = item.column * (width + EVENT_COLUMN_GAP_PERCENT);

    const top = (item.startMinutes / DAY_TOTAL_MINUTES) * 100;
    let height = ((item.endMinutes - item.startMinutes) / DAY_TOTAL_MINUTES) * 100;
    height = Math.max(height, MIN_EVENT_HEIGHT_PERCENT);
    if (top + height > 100) {
      height = 100 - top;
    }

    return {
      id: item.id,
      title: item.title,
      description: item.description,
      timeLabel: item.timeLabel,
      top,
      height: Math.max(height, MIN_EVENT_HEIGHT_PERCENT),
      left,
      width,
    };
  });
};

export const CalendarView: React.FC<CalendarViewProps> = ({
  eventsByDay,
  onMonthChange,
  onRefresh,
  isRefreshing,
  isConnected = true,
  onConnect,
  isConnecting,
  isSignedIn = false,
}) => {
  const today = React.useMemo(() => normalizeDate(new Date()), []);
  const [activeMonth, setActiveMonth] = React.useState<Date>(today);
  const [selectedDate, setSelectedDate] = React.useState<Date>(today);

  const selectedIso = React.useMemo(() => formatISODate(selectedDate), [selectedDate]);
  const monthCells = React.useMemo(
    () => buildCalendarCells(activeMonth, selectedDate),
    [activeMonth, selectedDate]
  );
  const weekDays = React.useMemo(
    () => buildWeekDays(selectedDate, selectedIso),
    [selectedDate, selectedIso]
  );
  const weekStart = React.useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const weekHeadingLabel = React.useMemo(() => TODAY_DATE.format(selectedDate), [selectedDate]);
  const weekSubtitleLabel = React.useMemo(() => {
    const weekEnd = addDays(weekStart, 6);
    return `Week ${DAY_NUMBER_FORMATTER.format(weekStart)} - ${DAY_NUMBER_FORMATTER.format(
      weekEnd
    )}`;
  }, [weekStart]);
  const weekRangeLabel = React.useMemo(() => formatWeekRange(weekStart), [weekStart]);
  const miniWeekdayLabels = React.useMemo(() => {
    const baseIndex = WEEK_STARTS_ON_MONDAY ? 1 : 0;
    return Array.from({ length: 7 }, (_, index) => {
      const reference = new Date(Date.UTC(2024, 0, baseIndex + index));
      return WEEKDAY_SHORT_FORMATTER.format(reference);
    });
  }, []);
  const isTodayInView = React.useMemo(() => weekDays.some((day) => day.isToday), [weekDays]);

  const timeSlots = React.useMemo(() => buildTimeSlots(), []);
  const timeGridRef = React.useRef<HTMLDivElement | null>(null);
  const hasAppliedInitialScroll = React.useRef(false);
  const ignoreProgrammaticScrolls = React.useRef(0);
  const [isScrollbarVisible, setIsScrollbarVisible] = React.useState(false);
  const [currentMinutes, setCurrentMinutes] = React.useState<number>(() => getCurrentMinutes());

  const eventSource = React.useMemo(() => eventsByDay ?? {}, [eventsByDay]);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = React.useState<boolean>(() => {
    if (typeof document === 'undefined') {
      return false;
    }
    return document.body?.dataset?.sidebar === 'collapsed';
  });

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const updateFromDom = () => {
      setIsSidebarCollapsed(document.body?.dataset?.sidebar === 'collapsed');
    };

    const handleSidebarState = (event: Event) => {
      const detail = (event as CustomEvent<{ collapsed?: boolean }>).detail;
      if (detail && typeof detail.collapsed === 'boolean') {
        setIsSidebarCollapsed(detail.collapsed);
      } else {
        updateFromDom();
      }
    };

    updateFromDom();

    window.addEventListener('sidebar:state', handleSidebarState as EventListener);
    const observer =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(updateFromDom) : null;
    if (observer) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['data-sidebar'] });
    }

    return () => {
      window.removeEventListener('sidebar:state', handleSidebarState as EventListener);
      observer?.disconnect();
    };
  }, []);

  React.useEffect(() => {
    if (onMonthChange) {
      onMonthChange(new Date(activeMonth));
    }
  }, [activeMonth, onMonthChange]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    setCurrentMinutes(getCurrentMinutes());
    const interval = window.setInterval(() => {
      setCurrentMinutes(getCurrentMinutes());
    }, CURRENT_TIME_UPDATE_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const refreshButtonClassName = React.useMemo(
    () =>
      [
        styles['control-button'],
        styles['control-icon-button'],
        isRefreshing ? styles['control-button-refreshing'] : '',
      ]
        .filter(Boolean)
        .join(' '),
    [isRefreshing]
  );

  React.useEffect(() => {
    const container = timeGridRef.current;
    if (!container || hasAppliedInitialScroll.current) {
      return;
    }

    hasAppliedInitialScroll.current = true;

    const now = new Date();
    const minutesSinceStart = now.getHours() * 60 + now.getMinutes();
    const targetMinutes = Math.max(
      minutesSinceStart - INITIAL_SCROLL_OFFSET_MINUTES,
      DAY_START_MINUTES
    );
    const slotIndex = Math.floor((targetMinutes - DAY_START_MINUTES) / SLOT_INTERVAL_MINUTES);
    const desiredScroll = Math.max(slotIndex, 0) * SLOT_HEIGHT_PX;

    const applyScroll = () => {
      const node = timeGridRef.current;
      if (!node) {
        return;
      }
      const maxScroll = Math.max(node.scrollHeight - node.clientHeight, 0);
      ignoreProgrammaticScrolls.current += 1;
      node.scrollTop = Math.min(desiredScroll, maxScroll);
      window.requestAnimationFrame(() => {
        ignoreProgrammaticScrolls.current = Math.max(ignoreProgrammaticScrolls.current - 1, 0);
      });
    };

    if (container.scrollHeight === 0) {
      requestAnimationFrame(applyScroll);
    } else {
      applyScroll();
    }
  }, []);

  React.useEffect(() => {
    const container = timeGridRef.current;
    if (!container) {
      return;
    }

    let hideTimer: number | undefined;

    const clearHideTimer = () => {
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer);
        hideTimer = undefined;
      }
    };

    const handleScroll = () => {
      if (ignoreProgrammaticScrolls.current > 0) {
        return;
      }

      if (container.scrollHeight <= container.clientHeight) {
        return;
      }

      setIsScrollbarVisible(true);
      clearHideTimer();
      hideTimer = window.setTimeout(() => {
        setIsScrollbarVisible(false);
        hideTimer = undefined;
      }, SCROLLBAR_HIDE_DELAY_MS);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      clearHideTimer();
    };
  }, []);

  const positionedEventsByDay = React.useMemo<Record<string, PositionedEvent[]>>(() => {
    const result: Record<string, PositionedEvent[]> = {};
    Object.entries(eventSource).forEach(([iso, dayEvents]) => {
      result[iso] = buildPositionedEvents(dayEvents ?? []);
    });
    return result;
  }, [eventSource]);

  const gridTemplateRows = React.useMemo(
    () => `repeat(${timeSlots.length}, ${SLOT_HEIGHT_PX}px)`,
    [timeSlots.length]
  );

  const monthTitle = React.useMemo(() => MONTH_TITLE_FORMATTER.format(activeMonth), [activeMonth]);
  const showCurrentTimeIndicator = React.useMemo(() => {
    if (!isTodayInView) {
      return false;
    }
    return currentMinutes >= DAY_START_MINUTES && currentMinutes <= DAY_END_MINUTES;
  }, [currentMinutes, isTodayInView]);
  const currentTimeIndicatorStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (!showCurrentTimeIndicator) {
      return undefined;
    }
    const clamped = Math.min(Math.max(currentMinutes, DAY_START_MINUTES), DAY_END_MINUTES - 1);
    const offsetMinutes = clamped - DAY_START_MINUTES;
    const topPx = offsetMinutes * PIXELS_PER_MINUTE;
    return {
      top: `${topPx}px`,
      ['--time-grid-time-column-width' as const]: `${TIME_COLUMN_WIDTH_PX}px`,
    };
  }, [currentMinutes, showCurrentTimeIndicator]);

  const handleSelectDate = React.useCallback((date: Date) => {
    const normalized = normalizeDate(date);
    setSelectedDate(normalized);
    setActiveMonth(startOfMonth(normalized));
  }, []);

  const handleToday = React.useCallback(() => {
    setSelectedDate(today);
    setActiveMonth(startOfMonth(today));
  }, [today]);

  const handlePrevWeek = React.useCallback(() => {
    setSelectedDate((prev) => {
      const next = addDays(prev, -7);
      setActiveMonth(startOfMonth(next));
      return next;
    });
  }, []);

  const handleNextWeek = React.useCallback(() => {
    setSelectedDate((prev) => {
      const next = addDays(prev, 7);
      setActiveMonth(startOfMonth(next));
      return next;
    });
  }, []);

  const handlePrevMonth = React.useCallback(() => {
    setActiveMonth((prev) => addMonths(prev, -1));
  }, []);

  const handleNextMonth = React.useCallback(() => {
    setActiveMonth((prev) => addMonths(prev, 1));
  }, []);

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles['header-left']}>
          <h1 className={styles.title}>{weekHeadingLabel}</h1>
          <span className={styles.subtitle} title={weekRangeLabel}>
            {weekSubtitleLabel}
          </span>
        </div>
        <div className={styles['header-actions']}>
          {!isConnected && onConnect && (
            <Button
              appearance="primary"
              size="small"
              className={styles['connect-button']}
              onClick={onConnect}
              disabled={isConnecting || !isSignedIn}
            >
              {isConnecting ? (
                <>
                  <Spinner size="tiny" />
                  <span style={{ marginLeft: 6 }}>Connecting…</span>
                </>
              ) : isSignedIn ? (
                'Connect Calendar'
              ) : (
                'Sign in to Connect Calendar'
              )}
            </Button>
          )}
          {isConnected && onRefresh ? (
            <Button
              appearance="subtle"
              size="small"
              icon={<RefreshCcw size={18} strokeWidth={1.6} />}
              className={refreshButtonClassName}
              onClick={onRefresh}
              aria-label={isRefreshing ? 'Refreshing calendar' : 'Refresh calendar'}
              disabled={isRefreshing}
            />
          ) : null}
          <Button
            appearance="secondary"
            size="small"
            className={styles['control-button']}
            onClick={handleToday}
          >
            Today
          </Button>
          <Button
            appearance="subtle"
            size="small"
            icon={<ChevronLeft size={18} strokeWidth={1.6} />}
            className={[styles['control-button'], styles['control-icon-button']].join(' ')}
            onClick={handlePrevWeek}
            aria-label="Previous week"
          />
          <Button
            appearance="subtle"
            size="small"
            icon={<ChevronRight size={18} strokeWidth={1.6} />}
            className={[styles['control-button'], styles['control-icon-button']].join(' ')}
            onClick={handleNextWeek}
            aria-label="Next week"
          />
        </div>
      </header>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles['mini-header']}>
            <div>
              <p className={styles['mini-title']}>{monthTitle}</p>
            </div>
            <div className={styles['mini-controls']}>
              <Button
                appearance="subtle"
                size="small"
                icon={<ChevronLeft size={16} strokeWidth={1.6} />}
                className={styles['mini-button']}
                onClick={handlePrevMonth}
                aria-label="Previous month"
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<ChevronRight size={16} strokeWidth={1.6} />}
                className={styles['mini-button']}
                onClick={handleNextMonth}
                aria-label="Next month"
              />
            </div>
          </div>

          <div className={styles['mini-weekdays']}>
            {miniWeekdayLabels.map((label) => (
              <span key={label} className={styles['mini-weekday']}>
                {label}
              </span>
            ))}
          </div>

          <div className={styles['mini-grid']}>
            {monthCells.map((cell) => {
              const events = eventSource[cell.iso] ?? [];
              const dayClasses = [
                styles['mini-day'],
                cell.isToday ? styles['mini-day-today'] : '',
                cell.isSelected ? styles['mini-day-selected'] : '',
                !cell.inCurrentMonth ? styles['mini-day-outside'] : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <button
                  type="button"
                  key={cell.iso}
                  className={dayClasses}
                  onClick={() => handleSelectDate(cell.date)}
                  aria-pressed={cell.isSelected}
                  aria-current={cell.isToday ? 'date' : undefined}
                >
                  <span>{DAY_NUMBER_FORMATTER.format(cell.date)}</span>
                  {events.length > 0 && <span className={styles['mini-indicator']} aria-hidden />}
                </button>
              );
            })}
          </div>
        </aside>

        <section className={styles['week-view']}>
          <div className={styles['week-header']}>
            <div className={styles['week-header-time']} aria-hidden>
              &nbsp;
            </div>
            {weekDays.map((day) => {
              const headerClasses = [
                styles['week-day'],
                day.isToday ? styles['week-day-today'] : '',
                day.isSelected ? styles['week-day-selected'] : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <button
                  key={day.iso}
                  type="button"
                  className={headerClasses}
                  onClick={() => handleSelectDate(day.date)}
                  aria-pressed={day.isSelected}
                  aria-current={day.isToday ? 'date' : undefined}
                >
                  <span className={styles['week-day-label']}>{day.label}</span>
                  <span className={styles['week-day-number']}>{day.dayNumber}</span>
                </button>
              );
            })}
          </div>

          <div
            className={[
              styles['time-grid'],
              isScrollbarVisible ? styles['time-grid--scrollbar-visible'] : '',
            ]
              .filter(Boolean)
              .join(' ')}
            ref={timeGridRef}
          >
            {currentTimeIndicatorStyle ? (
              <div
                className={styles['current-time-indicator']}
                style={currentTimeIndicatorStyle}
                aria-hidden="true"
              />
            ) : null}
            <div className={styles['time-grid-content']}>
              <div className={styles['time-column']} style={{ gridTemplateRows }}>
                {timeSlots.map((slot) => (
                  <div
                    key={slot.iso}
                    className={[
                      styles['time-cell'],
                      slot.isHourStart ? styles['time-cell-hour'] : styles['time-cell-half'],
                    ].join(' ')}
                  >
                    {slot.isHourStart ? slot.label : ''}
                  </div>
                ))}
              </div>

              {weekDays.map((day, index) => {
                const dayEvents = positionedEventsByDay[day.iso] ?? [];
                const dayColumnClasses = [
                  styles['day-column'],
                  index === 0 ? styles['day-column-first'] : '',
                  day.isToday ? styles['day-column-today'] : '',
                  day.isSelected ? styles['day-column-selected'] : '',
                ]
                  .filter(Boolean)
                  .join(' ');

                return (
                  <div key={day.iso} className={dayColumnClasses}>
                    <div className={styles['day-grid']} style={{ gridTemplateRows }}>
                      {timeSlots.map((slot) => (
                        <div
                          key={slot.iso}
                          className={[
                            styles['day-grid-slot'],
                            slot.isHourStart
                              ? styles['day-grid-slot-hour']
                              : styles['day-grid-slot-half'],
                          ].join(' ')}
                        />
                      ))}
                    </div>
                    <div className={styles['day-events']}>
                      {dayEvents.map((event) => {
                        const eventClasses = [
                          styles['slot-event'],
                          isSidebarCollapsed
                            ? styles['slot-event--with-title']
                            : styles['slot-event--compact'],
                        ]
                          .filter(Boolean)
                          .join(' ');

                        return (
                          <div
                            key={event.id}
                            className={eventClasses}
                            style={{
                              top: `${event.top}%`,
                              height: `${event.height}%`,
                              left: `${event.left}%`,
                              width: `${event.width}%`,
                            }}
                          >
                            {isSidebarCollapsed ? (
                              <span className={styles['slot-event-title']}>{event.title}</span>
                            ) : null}
                            <div
                              className={styles['slot-event-tooltip']}
                              role="tooltip"
                              aria-hidden="true"
                            >
                              <div className={styles['slot-event-tooltip-header']}>
                                {event.title}
                              </div>
                              <div className={styles['slot-event-tooltip-time']}>
                                {event.timeLabel}
                              </div>
                              {event.description ? (
                                <div className={styles['slot-event-tooltip-body']}>
                                  {event.description}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
