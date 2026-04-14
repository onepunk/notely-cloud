import { Search20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';

import { SignInRequiredModal } from '@shared/components';
import { reportError } from '@shared/error';
import { useIsAuthenticated } from '@shared/hooks/useAuthStore';

import { useTranscriptionStore } from '../model/transcription.store';

import { AudioPlayer } from './AudioPlayer';
import styles from './TranscriptionViewModal.module.css';

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
};

type Props = {
  transcription: Transcription;
  isOpen: boolean;
  onClose: () => void;
};

export const TranscriptionViewModal: React.FC<Props> = ({ transcription, isOpen, onClose }) => {
  const isAuthenticated = useIsAuthenticated();
  const [showSignInModal, setShowSignInModal] = React.useState(false);
  const [content, setContent] = React.useState<string>('');
  const [searchTerm, setSearchTerm] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [highlightedContent, setHighlightedContent] = React.useState<string>('');
  const [summary, setSummary] = React.useState<string>('');
  const [summaryId, setSummaryId] = React.useState<string | null>(null);
  const [summarySearchTerm, setSummarySearchTerm] = React.useState('');
  const [highlightedSummary, setHighlightedSummary] = React.useState<string>('');
  const [summaryJobStatus, setSummaryJobStatus] = React.useState<
    'idle' | 'pending' | 'generating' | 'completed' | 'failed' | 'checking_server'
  >('idle');
  const [_summaryJobId, setSummaryJobId] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<'transcription' | 'summary'>('transcription');
  const modalRef = React.useRef<HTMLDivElement>(null);

  // Segments state for timecodes
  const [segments, setSegments] = React.useState<
    Array<{
      segmentId: string;
      text: string;
      startTime: number;
      endTime: number;
    }>
  >([]);

  // Audio player state and actions
  const seekAudioTo = useTranscriptionStore((s) => s.seekAudioTo);
  const audioFilePath = useTranscriptionStore((s) => s.audioPlayer.filePath);
  const loadAudio = useTranscriptionStore((s) => s.loadAudio);

  // Load transcription content, segments, and audio
  React.useEffect(() => {
    const loadContent = async () => {
      if (!isOpen || !transcription.id) return;

      setLoading(true);
      try {
        const result = await window.api.transcription.get(transcription.id);
        setContent(result?.fullText || '');

        // Load segments for timecodes
        try {
          const segmentResult = await window.api.transcription.getSegments(transcription.id);
          if (segmentResult && segmentResult.length > 0) {
            setSegments(
              segmentResult.map((seg) => ({
                segmentId: seg.segmentId,
                text: seg.text,
                startTime: seg.startTime,
                endTime: seg.endTime,
              }))
            );
          } else {
            setSegments([]);
          }
        } catch {
          setSegments([]);
        }

        // Load audio for playback
        loadAudio(transcription.id);
      } catch (e) {
        console.error('Failed to load transcription content:', e);
        setContent('');
        setSegments([]);
      } finally {
        setLoading(false);
      }
    };

    loadContent();
  }, [isOpen, transcription.id, loadAudio]);

  // Load existing summaries on modal open
  React.useEffect(() => {
    const loadSummaries = async () => {
      if (!isOpen || !transcription.id) return;

      try {
        const result = await window.api.summary.getByTranscription(transcription.id);
        if (result.success && result.summaries && result.summaries.length > 0) {
          // Show the first (most recent) summary
          setSummary(result.summaries[0].summaryText);
          setSummaryId(result.summaries[0].id);
          setSummaryJobStatus('completed');
          // Keep default tab as transcription; user can click Summary tab
        } else {
          setSummaryJobStatus('idle');
        }
      } catch (e) {
        console.error('Failed to load existing summaries:', e);
        setSummaryJobStatus('idle');
      }
    };

    loadSummaries();
  }, [isOpen, transcription.id]);

  // Listen for summary completion notifications (for summaries synced from other devices)
  React.useEffect(() => {
    if (!isOpen) return;

    const unsubscribe = window.api.onSummaryNotification((notification) => {
      console.log('Received summary notification:', notification);

      // Only handle notifications for our current transcription
      if (notification.transcriptionId !== transcription.id) return;

      switch (notification.type) {
        case 'summary-completed':
          // Fetch the summary by ID since notification doesn't include the text
          if (notification.summaryId) {
            window.api.summary.get(notification.summaryId).then((result) => {
              if (result.success && result.summary) {
                setSummary(result.summary.summaryText);
                setSummaryId(result.summary.id);
                setSummaryJobStatus('completed');
                setSummaryJobId(null);
                console.log('Summary completed and displayed');
              }
            });
          }
          break;

        case 'summary-failed':
          setSummaryJobStatus('failed');
          setSummaryJobId(null);
          console.error('Summary generation failed:', notification.message);
          break;

        default:
          console.log('Unhandled notification type:', notification.type);
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [isOpen, transcription.id]);

  // Handle summary generation (non-blocking) - One time only
  const handleGenerateSummary = async () => {
    if (!transcription.id) return;

    // Auth check - show sign-in modal if not authenticated
    if (!isAuthenticated) {
      setShowSignInModal(true);
      return;
    }

    // Don't allow regeneration if summary already exists
    if (summaryJobStatus === 'completed' && summary) {
      console.log('Summary already exists for transcription:', transcription.id);
      return;
    }

    try {
      console.log('Starting server check and sync before summary generation:', transcription.id);
      setSummaryJobStatus('checking_server');

      // Show progress banner while we check and sync
      const checkToastId = toast.message('Checking for existing summary...');

      // First check if summary already exists on server
      try {
        const serverCheckResult = await window.api.summary.checkServerSummaryExists(
          transcription.id
        );

        if (serverCheckResult.success && serverCheckResult.exists) {
          console.log('Summary already exists on server, syncing locally...');
          toast.message('Summary exists on server, syncing...', { id: checkToastId });

          // Trigger sync to pull the existing summary
          await window.api.sync.push();

          // Reload existing summaries
          const result = await window.api.summary.getByTranscription(transcription.id);
          if (result.success && result.summaries && result.summaries.length > 0) {
            setSummary(result.summaries[0].summaryText);
            setSummaryId(result.summaries[0].id);
            setSummaryJobStatus('completed');
            toast.success('Existing summary synchronized', { id: checkToastId });
            return;
          }
        }
      } catch (e) {
        console.warn('Server check failed, proceeding with normal flow:', e);
      }

      // Proceed with sync and generation only if no summary exists
      setSummaryJobStatus('pending');
      toast.dismiss(checkToastId);

      // Ensure the transcription exists on the server before requesting summary
      try {
        await window.api.sync.push();
      } catch (e) {
        reportError(e, 'E2001', { transcriptionId: transcription.id });
        setSummaryJobStatus('failed');
        return;
      }

      console.log('Starting summary generation for transcription:', transcription.id);
      setSummaryJobStatus('generating');

      // Generate summary via server API (requires auth + license)
      const result = await window.api.summary.generate({
        transcriptionId: transcription.id,
        summaryType: 'full',
        forceRegenerate: false,
      });

      if (result.success && result.summary) {
        setSummary(result.summary.summaryText);
        setSummaryId(result.summary.id);
        setSummaryJobStatus('completed');
        console.log('Summary generated successfully:', result.summary.id);
      } else {
        setSummaryJobStatus('failed');
        reportError(result.error, 'E3001', { transcriptionId: transcription.id });
      }
    } catch (e) {
      setSummaryJobStatus('failed');
      reportError(e, 'E3001', { transcriptionId: transcription.id });
    }
  };

  // Handle opening online summary
  const handleViewOnline = async () => {
    if (summaryId) {
      // Get server URL from settings (single source of truth)
      const serverUrl = await window.api.settings.get('auth.serverUrl');
      const summaryUrl = `${serverUrl}/summary/${summaryId}`;
      window.api.window.openExternal(summaryUrl);
    }
  };

  // Format content with timestamps from segments
  const formattedContent = React.useMemo(() => {
    if (segments.length === 0) return content;

    return segments
      .map((seg) => {
        const mins = Math.floor(seg.startTime / 60);
        const secs = Math.floor(seg.startTime % 60);
        const timestamp = `[${mins}:${secs.toString().padStart(2, '0')}]`;
        return `<span class="timestamp" data-time-ms="${(mins * 60 + secs) * 1000}">${timestamp}</span> ${seg.text}`;
      })
      .join('<br/>');
  }, [segments, content]);

  // Handle clicks on timestamp markers
  const handleContentClick = React.useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('timestamp')) {
        const timeMs = parseInt(target.dataset.timeMs || '0', 10);
        if (audioFilePath) {
          seekAudioTo(timeMs);
        } else {
          toast.info('Recording not available for playback');
        }
      }
    },
    [audioFilePath, seekAudioTo]
  );

  // Highlight search terms
  React.useEffect(() => {
    if (!searchTerm.trim()) {
      setHighlightedContent(formattedContent);
      return;
    }

    const escaped = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const highlighted = formattedContent.replace(regex, '<mark>$1</mark>');
    setHighlightedContent(highlighted);
  }, [formattedContent, searchTerm]);

  // Highlight search terms for summary
  React.useEffect(() => {
    if (!summarySearchTerm.trim()) {
      setHighlightedSummary(summary);
      return;
    }
    const escaped = summarySearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const highlighted = summary.replace(regex, '<mark>$1</mark>');
    setHighlightedSummary(highlighted);
  }, [summary, summarySearchTerm]);

  // Close on escape key
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose]);

  // Handle backdrop click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (!isOpen) return null;

  const started = transcription.startTime;
  const duration =
    typeof transcription.durationMs === 'number'
      ? Math.round(transcription.durationMs / 1000)
      : undefined;

  const modalContent = (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div ref={modalRef} className={styles.modal}>
        <div className={styles.header}>
          <div className={styles['header-content']}>
            <h2 className={styles.title}>Transcription</h2>
            <div className={styles.meta}>
              <span className={styles.timestamp}>
                {started.toLocaleDateString()} at{' '}
                {started.toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              {duration !== undefined && <span>{duration}s</span>}
              <span>{transcription.wordCount} words</span>
              <span className={styles.language}>{transcription.language}</span>
            </div>
          </div>
          <button className={styles['close-button']} onClick={onClose} aria-label="Close">
            <Dismiss20Regular />
          </button>
        </div>

        {activeTab === 'transcription' && (
          <div className={styles['search-container']}>
            <div className={styles['search-input-wrapper']}>
              <Search20Regular className={styles['search-icon']} />
              <input
                type="text"
                className={styles['search-input']}
                placeholder="Search transcription..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
        )}

        {activeTab === 'summary' && (
          <div className={styles['search-container']}>
            <div className={styles['search-input-wrapper']}>
              <Search20Regular className={styles['search-icon']} />
              <input
                type="text"
                className={styles['search-input']}
                placeholder="Search summary..."
                value={summarySearchTerm}
                onChange={(e) => setSummarySearchTerm(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${activeTab === 'transcription' ? styles['tab-active'] : ''}`}
            onClick={() => setActiveTab('transcription')}
          >
            Transcription
          </button>
          {summary && (
            <button
              className={`${styles.tab} ${activeTab === 'summary' ? styles['tab-active'] : ''}`}
              onClick={() => setActiveTab('summary')}
            >
              Summary
            </button>
          )}
        </div>

        <div className={styles.content}>
          {activeTab === 'transcription' && (
            <>
              {loading && <div className={styles.loading}>Loading transcription...</div>}

              {!loading && !content && (
                <div className={styles.empty}>
                  <div>No transcription content available</div>
                </div>
              )}

              {!loading && content && (
                <div
                  className={styles['transcription-text']}
                  dangerouslySetInnerHTML={{ __html: highlightedContent }}
                  onClick={handleContentClick}
                />
              )}
            </>
          )}

          {activeTab === 'summary' && (
            <>
              {!summary && (
                <div className={styles['summary-placeholder']}>
                  <div>No summary available</div>
                </div>
              )}
              {summary && (
                <>
                  {summaryId && (
                    <div className={styles['summary-actions']}>
                      <a
                        href="#"
                        className={styles['view-online-link']}
                        onClick={(e) => {
                          e.preventDefault();
                          handleViewOnline();
                        }}
                        title="View this summary online in your browser"
                      >
                        View Online
                      </a>
                    </div>
                  )}
                  <div
                    className={styles['summary-text']}
                    dangerouslySetInnerHTML={{ __html: highlightedSummary }}
                  />
                </>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          {audioFilePath && (
            <div className={styles['audio-player-container']}>
              <AudioPlayer sessionId={transcription.id} />
            </div>
          )}
          <div className={styles.actions}>
            <button
              className={styles['action-button']}
              onClick={handleGenerateSummary}
              disabled={
                summaryJobStatus === 'pending' ||
                summaryJobStatus === 'generating' ||
                summaryJobStatus === 'checking_server' ||
                summaryJobStatus === 'completed'
              }
            >
              {summaryJobStatus === 'checking_server' && 'Checking...'}
              {summaryJobStatus === 'pending' && 'Starting...'}
              {summaryJobStatus === 'generating' && 'Generating...'}
              {summaryJobStatus === 'idle' && 'Generate Summary'}
              {summaryJobStatus === 'completed' && 'Generated'}
              {summaryJobStatus === 'failed' && 'Try Again'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {createPortal(modalContent, document.body)}
      <SignInRequiredModal
        open={showSignInModal}
        onDismiss={() => setShowSignInModal(false)}
        feature="AI Summary"
      />
    </>
  );
};
