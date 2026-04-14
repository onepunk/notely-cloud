import { ChevronRight20Regular, ChevronDown20Regular } from '@fluentui/react-icons';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import { useTranscriptionStore } from '../../features/transcription/model/transcription.store';

import styles from './TranscriptionsPage.module.css';

type TranscriptionWithDetails = {
  id: string;
  noteId: string;
  binderId: string;
  noteTitle: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  wordCount: number;
  charCount: number;
  previewText: string;
};

type DateGroup = {
  dateKey: string;
  displayName: string;
  transcriptions: TranscriptionWithDetails[];
  isWithinSevenDays: boolean;
};

interface TranscriptionsContentProps {
  onClose?: () => void;
  onSelectTranscription?: () => void;
}

export function TranscriptionsContent({
  onClose,
  onSelectTranscription,
}: TranscriptionsContentProps) {
  const navigate = useNavigate();
  const [transcriptions, setTranscriptions] = React.useState<TranscriptionWithDetails[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [expandedDates, setExpandedDates] = React.useState<Set<string>>(new Set());
  const selectHistoricalTranscription = useTranscriptionStore(
    (s) => s.selectHistoricalTranscription
  );

  React.useEffect(() => {
    const loadTranscriptions = async () => {
      try {
        setLoading(true);
        const allTranscriptions = await window.api.transcription.listAllWithDetails();
        setTranscriptions(allTranscriptions);
        // Auto-expand the first date that has transcriptions
        if (allTranscriptions.length > 0) {
          const firstDate = getDateKey(allTranscriptions[0].startTime);
          setExpandedDates(new Set([firstDate]));
        }
      } catch (error) {
        console.error('Failed to load transcriptions:', error);
      } finally {
        setLoading(false);
      }
    };

    loadTranscriptions();
  }, []);

  // Get date key (YYYY-MM-DD) from timestamp
  const getDateKey = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };

  // Get day name (Sunday, Monday, etc.)
  const getDayName = (date: Date): string => {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[date.getDay()];
  };

  // Format date for display based on whether it's within 7 days
  const formatDateDisplay = (dateKey: string, isToday: boolean): string => {
    const date = new Date(dateKey + 'T00:00:00');
    if (isToday) {
      return 'Today';
    }
    return getDayName(date);
  };

  // Format date for older items (beyond 7 days)
  const formatOlderDate = (dateKey: string): string => {
    const date = new Date(dateKey + 'T00:00:00');
    // Use locale format
    return date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
    });
  };

  // Group transcriptions by date and generate date groups
  const dateGroups = React.useMemo((): DateGroup[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    // Group transcriptions by date
    const transcriptionsByDate = new Map<string, TranscriptionWithDetails[]>();
    for (const t of transcriptions) {
      const dateKey = getDateKey(t.startTime);
      if (!transcriptionsByDate.has(dateKey)) {
        transcriptionsByDate.set(dateKey, []);
      }
      transcriptionsByDate.get(dateKey)!.push(t);
    }

    const groups: DateGroup[] = [];

    // Generate last 7 days (including today)
    for (let i = 0; i < 7; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateKey = getDateKey(date.getTime());
      const isToday = i === 0;

      groups.push({
        dateKey,
        displayName: formatDateDisplay(dateKey, isToday),
        transcriptions: transcriptionsByDate.get(dateKey) || [],
        isWithinSevenDays: true,
      });
    }

    // Add older dates that have transcriptions
    const olderDates = Array.from(transcriptionsByDate.keys())
      .filter((dateKey) => {
        const date = new Date(dateKey + 'T00:00:00');
        return date < sevenDaysAgo;
      })
      .sort((a, b) => b.localeCompare(a)); // Sort descending

    for (const dateKey of olderDates) {
      groups.push({
        dateKey,
        displayName: formatOlderDate(dateKey),
        transcriptions: transcriptionsByDate.get(dateKey) || [],
        isWithinSevenDays: false,
      });
    }

    return groups;
  }, [transcriptions]);

  const toggleDateExpansion = (dateKey: string) => {
    setExpandedDates((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(dateKey)) {
        newSet.delete(dateKey);
      } else {
        newSet.add(dateKey);
      }
      return newSet;
    });
  };

  const handleTranscriptionClick = async (transcription: TranscriptionWithDetails) => {
    // Pre-select the transcription before navigating
    // This ensures the correct transcription is shown when the note loads
    await selectHistoricalTranscription(transcription.id);

    // Navigate to the note - this will load the note in the editor
    navigate(`/binders/${transcription.binderId}/notes/${transcription.noteId}`);

    // Close transcriptions panel and open the transcription sidebar
    onSelectTranscription?.();
  };

  if (loading) {
    return <div className={styles.loading}>Loading transcriptions...</div>;
  }

  if (transcriptions.length === 0) {
    return <div className={styles.empty}>No transcriptions found</div>;
  }

  return (
    <div className={styles.list}>
      {dateGroups.map((group) => {
        const hasTranscriptions = group.transcriptions.length > 0;
        const isExpanded = expandedDates.has(group.dateKey);

        // Skip older dates with no transcriptions
        if (!group.isWithinSevenDays && !hasTranscriptions) {
          return null;
        }

        return (
          <div key={group.dateKey} className={styles.dateGroup}>
            <button
              className={`${styles.dateHeader} ${!hasTranscriptions ? styles.dateHeaderEmpty : ''}`}
              onClick={() => hasTranscriptions && toggleDateExpansion(group.dateKey)}
              disabled={!hasTranscriptions}
              aria-expanded={isExpanded}
            >
              {hasTranscriptions ? (
                <span className={styles.chevron}>
                  {isExpanded ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
                </span>
              ) : (
                <span className={styles.chevronPlaceholder} />
              )}
              <span className={styles.dateName}>{group.displayName}</span>
              {hasTranscriptions && (
                <span className={styles.transcriptionCount}>{group.transcriptions.length}</span>
              )}
            </button>

            {hasTranscriptions && isExpanded && (
              <div className={styles.transcriptionList}>
                {group.transcriptions.map((t) => {
                  // Truncate preview to 50 chars for safety
                  const preview = t.previewText
                    ? t.previewText.length > 50
                      ? t.previewText.slice(0, 50) + '...'
                      : t.previewText
                    : 'No content';
                  return (
                    <button
                      key={t.id}
                      className={styles.transcriptionItem}
                      onClick={() => handleTranscriptionClick(t)}
                    >
                      <div className={styles.transcriptionTitle}>{t.noteTitle}</div>
                      <div className={styles.transcriptionPreview}>{preview}</div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
