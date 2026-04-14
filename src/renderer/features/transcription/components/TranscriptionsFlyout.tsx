import * as React from 'react';
import { createPortal } from 'react-dom';

import { DevTranscriptionModal } from './DevTranscriptionModal';
import styles from './TranscriptionsFlyout.module.css';

type Transcription = {
  id: string;
  language: string;
  status: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  charCount: number;
  wordCount: number;
  updatedAt: Date;
  content?: string;
  hasSummary?: boolean;
};

type Props = {
  binderId: string;
  noteId?: string;
  isOpen: boolean;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onTranscriptionSelect: (transcription: Transcription) => void;
};

export const TranscriptionsFlyout: React.FC<Props> = ({
  binderId,
  noteId,
  isOpen,
  anchorEl,
  onClose,
  onTranscriptionSelect,
}) => {
  const [transcriptions, setTranscriptions] = React.useState<Transcription[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [summaryChecks, setSummaryChecks] = React.useState<Record<string, boolean>>({});
  const [isDevelopment, setIsDevelopment] = React.useState(false);
  const [showDevModal, setShowDevModal] = React.useState(false);
  const flyoutRef = React.useRef<HTMLDivElement>(null);

  const loadTranscriptions = React.useCallback(async () => {
    if (!noteId) {
      setTranscriptions([]);
      return;
    }
    setLoading(true);
    try {
      const list = await window.api.transcription.listByNote(noteId);
      // Fetch preview content and summary status for each transcription
      const listWithContent = await Promise.all(
        list.map(async (item) => {
          try {
            const content = await window.api.transcription.getContent(item.id);
            return { ...item, content: content?.slice(0, 100) }; // First 100 chars for preview
          } catch (e) {
            return { ...item, content: undefined };
          }
        })
      );
      setTranscriptions(listWithContent);

      // Check for summaries for each transcription
      const summaryStatusMap: Record<string, boolean> = {};
      await Promise.all(
        listWithContent.map(async (item) => {
          try {
            const summaryResult = await window.api.summary.getByTranscription(item.id);
            summaryStatusMap[item.id] =
              summaryResult.success &&
              summaryResult.summaries &&
              summaryResult.summaries.length > 0;
          } catch (e) {
            summaryStatusMap[item.id] = false;
          }
        })
      );
      setSummaryChecks(summaryStatusMap);
    } catch (e) {
      console.error('Failed to load transcriptions', e);
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  React.useEffect(() => {
    if (isOpen) {
      loadTranscriptions();
    }
  }, [isOpen, loadTranscriptions]);

  // Check if we're in development mode
  React.useEffect(() => {
    window.api.isDevelopment().then(setIsDevelopment);
  }, []);

  // Close on outside click
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Don't close if dev modal is open
      if (showDevModal) {
        return;
      }

      if (
        isOpen &&
        flyoutRef.current &&
        !flyoutRef.current.contains(event.target as Node) &&
        anchorEl &&
        !anchorEl.contains(event.target as Node)
      ) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose, anchorEl, showDevModal]);

  // Position the flyout
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    if (isOpen && anchorEl && flyoutRef.current) {
      const anchorRect = anchorEl.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const margin = 16;
      const verticalOffset = 10;

      const spaceAbove = anchorRect.top - margin - verticalOffset;
      const spaceBelow = viewportHeight - anchorRect.bottom - margin - verticalOffset;

      const minHeight = 200;
      const maxViewportHeight = Math.min(viewportHeight * 0.7, viewportHeight - margin * 2);

      let top: number;
      let maxHeight: number;

      const canPlaceAbove = spaceAbove >= minHeight;
      const canPlaceBelow = spaceBelow >= minHeight;
      let placeAbove: boolean;
      if (canPlaceAbove && canPlaceBelow) {
        placeAbove = spaceAbove >= spaceBelow;
      } else if (canPlaceAbove) {
        placeAbove = true;
      } else if (canPlaceBelow) {
        placeAbove = false;
      } else {
        placeAbove = spaceAbove >= spaceBelow;
      }

      if (placeAbove) {
        maxHeight = Math.min(Math.max(spaceAbove, minHeight), maxViewportHeight);
        top = anchorRect.top - margin - verticalOffset - maxHeight;
        if (top < margin) {
          top = margin;
        }
      } else {
        maxHeight = Math.min(Math.max(spaceBelow, minHeight), maxViewportHeight);
        top = anchorRect.bottom + margin + verticalOffset;
        if (top + maxHeight > viewportHeight - margin) {
          top = Math.max(margin, viewportHeight - margin - maxHeight);
        }
      }

      if (maxHeight < minHeight) {
        maxHeight = Math.min(minHeight, viewportHeight - margin * 2);
        top = Math.max(margin, viewportHeight - margin - maxHeight);
      }

      // Apply the dynamic height constraint
      flyoutRef.current.style.setProperty('--dynamic-max-height', `${maxHeight}px`);

      const flyoutWidth = flyoutRef.current.offsetWidth || 480;
      const desiredLeft = anchorRect.left + anchorRect.width / 2 - flyoutWidth / 2;
      const minLeft = margin;
      const maxLeft = Math.max(margin, viewportWidth - margin - flyoutWidth);
      const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

      setPosition({ top, left });
    }
  }, [isOpen, anchorEl]);

  if (!isOpen) return null;

  const flyoutContent = (
    <div
      ref={flyoutRef}
      className={styles.flyout}
      style={position ? { top: position.top, left: position.left } : undefined}
    >
      <div className={styles.header}>
        <h3 className={styles.title}>Previous Transcriptions</h3>
        <button className={styles['close-button']} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {isDevelopment && noteId && (
        <div className={styles['dev-section']}>
          <button className={styles['dev-button']} onClick={() => setShowDevModal(true)}>
            🛠️ Dev: Add Test Transcription
          </button>
        </div>
      )}

      <div className={styles.content}>
        {loading && <div className={styles.loading}>Loading transcriptions...</div>}

        {!loading && transcriptions.length === 0 && (
          <div className={styles.empty}>
            <div className={styles['empty-icon']}>📝</div>
            <div>No transcriptions yet</div>
            <div className={styles['empty-subtext']}>
              Transcriptions from recordings will appear here
            </div>
          </div>
        )}

        {!loading && transcriptions.length > 0 && (
          <div className={styles.list}>
            {transcriptions.map((transcription) => {
              const started = transcription.startTime;
              const duration =
                typeof transcription.durationMs === 'number'
                  ? Math.round(transcription.durationMs / 1000)
                  : undefined;

              return (
                <div
                  key={transcription.id}
                  className={styles.item}
                  onClick={() => onTranscriptionSelect(transcription)}
                >
                  <div className={styles['item-header']}>
                    <div className={styles['header-left']}>
                      <div className={styles.timestamp}>
                        {started.toLocaleDateString()} at{' '}
                        {started.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                      {summaryChecks[transcription.id] && (
                        <div className={styles['summary-indicator']} title="Summary available">
                          ✨
                        </div>
                      )}
                    </div>
                    <div className={styles.meta}>
                      {duration !== undefined && <span>{duration}s</span>}
                      <span>{transcription.wordCount} words</span>
                    </div>
                  </div>

                  {transcription.content && (
                    <div className={styles.preview}>
                      &quot;{transcription.content}
                      {transcription.content.length >= 100 ? '...' : ''}&quot;
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <>
      {createPortal(flyoutContent, document.body)}
      {showDevModal && noteId && (
        <DevTranscriptionModal
          binderId={binderId}
          noteId={noteId}
          isOpen={showDevModal}
          onClose={() => setShowDevModal(false)}
          onSuccess={() => {
            setShowDevModal(false);
            loadTranscriptions(); // Refresh the list after adding
          }}
        />
      )}
    </>
  );
};
