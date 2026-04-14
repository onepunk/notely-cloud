import { Badge, ProgressBar, Spinner, Tooltip } from '@fluentui/react-components';
import {
  ChevronUp20Regular,
  ChevronDown20Regular,
  Dismiss20Regular,
  Edit20Regular,
  Checkmark20Regular,
  Sparkle20Regular,
  Globe20Regular,
} from '@fluentui/react-icons';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import LexicalErrorBoundary from '@lexical/react/LexicalErrorBoundary';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { $getRoot, EditorState } from 'lexical';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { SignInRequiredModal } from '@shared/components';
import { reportError } from '@shared/error';
import { useIsAuthenticated } from '@shared/hooks/useAuthStore';
import { useLicense } from '@shared/hooks/useLicense';

import { getLanguageName } from '../../../shared/constants/languages';
import { useTranscriptionStore } from '../model/transcription.store';
import { TranscriptionViewerPlugin } from '../plugins/TranscriptionViewerPlugin';

import { AudioPlayer } from './AudioPlayer';
import { SummaryRenderer, SummaryData } from './SummaryRenderer';
import styles from './TranscriptionSidebar.module.css';

type TabType = 'transcription' | 'summary';

type Props = {
  isOpen: boolean;
  activeTab?: TabType;
  onTabChange?: (tab: TabType) => void;
};

export const TranscriptionSidebar: React.FC<Props> = ({
  isOpen,
  activeTab: controlledTab,
  onTabChange,
}) => {
  const { t } = useTranslation();
  const { license } = useLicense();
  const isAuthenticated = useIsAuthenticated();
  const [showSignInModal, setShowSignInModal] = React.useState(false);
  const partialText = useTranscriptionStore((s) => s.partialText);
  const displayText = useTranscriptionStore((s) => s.displayText);
  const stableText = useTranscriptionStore((s) => s.stableText);
  const isRecording = useTranscriptionStore((s) => s.isRecording);
  const isFinalizing = useTranscriptionStore((s) => s.isFinalizing);
  const hasRecording = useTranscriptionStore((s) => s.hasRecording);
  const seekAudioTo = useTranscriptionStore((s) => s.seekAudioTo);
  const audioFilePath = useTranscriptionStore((s) => s.audioPlayer.filePath);
  const activeSessionId = useTranscriptionStore((s) => s.activeSessionId);
  const lastRecordingSessionId = useTranscriptionStore((s) => s.lastRecordingSessionId);
  const detectedLanguage = useTranscriptionStore((s) => s.detectedLanguage);
  const languageConfidence = useTranscriptionStore((s) => s.languageConfidence);
  const isAutoDetectEnabled = useTranscriptionStore((s) => s.isAutoDetectEnabled);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = React.useState(0);
  const [matchCount, setMatchCount] = React.useState(0);
  const [isEditMode, setIsEditMode] = React.useState(false);
  const [editedText, setEditedText] = React.useState<string | null>(null);
  const [localTab, setLocalTab] = React.useState<TabType>('transcription');

  // Use controlled state when props provided, local state otherwise
  const activeTab = controlledTab ?? localTab;
  const setActiveTab = React.useCallback(
    (tab: TabType) => {
      if (onTabChange) {
        onTabChange(tab);
      } else {
        setLocalTab(tab);
      }
    },
    [onTabChange]
  );
  const [summaryContent, setSummaryContent] = React.useState<SummaryData | null>(null);
  const [activeSummaryId, setActiveSummaryId] = React.useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = React.useState(false);
  const [_summaryJobId, setSummaryJobId] = React.useState<string | null>(null);
  const viewerRef = React.useRef<HTMLDivElement>(null);
  const contentEditableRef = React.useRef<HTMLDivElement>(null);

  // Get the current transcription session ID
  const transcriptionId = activeSessionId || lastRecordingSessionId;

  // Check if user has active license for AI Summary feature
  const hasActiveLicense = license.status === 'active' || license.status === 'expiring';

  const hasLiveText = React.useMemo(() => {
    if (displayText && displayText.trim().length > 0) {
      return true;
    }
    if (partialText && partialText.trim().length > 0) {
      return true;
    }
    if (stableText && stableText.trim().length > 0) {
      return true;
    }
    return false;
  }, [displayText, partialText, stableText]);

  // Can only edit when not recording and has text
  const canEdit = !isRecording && hasLiveText;

  // Show summary button when we have text to summarize (doesn't require audio recording)
  const showSummaryButton = hasActiveLicense && !isRecording && hasLiveText && !isEditMode;

  // AI Summary handler
  const handleSummaryClick = React.useCallback(async () => {
    if (isSummarizing || isRecording || !transcriptionId) return;

    // Auth check - show sign-in modal if not authenticated
    if (!isAuthenticated) {
      setShowSignInModal(true);
      return;
    }

    // Switch to summary tab immediately
    setActiveTab('summary');
    setIsSummarizing(true);
    setSummaryContent(null);
    setSummaryJobId(null);

    try {
      console.log('[TranscriptionSidebar] Starting AI Summary generation for:', transcriptionId);

      // Always generate a new summary when explicitly requested by the user.
      // Existing summaries are loaded passively via the useEffect when switching tabs.
      const result = await window.api.summary.generate({
        transcriptionId,
        summaryType: 'full',
        forceRegenerate: true,
      });

      if (result.success && result.summary) {
        console.log('[TranscriptionSidebar] Summary generated:', result.summary.id);
        setActiveSummaryId(result.summary.id);
        // Parse the summary text for structured rendering
        try {
          const parsedSummary = JSON.parse(result.summary.summaryText);
          setSummaryContent(parsedSummary);
        } catch {
          // Fallback: if not JSON, wrap as raw text
          setSummaryContent({ _rawText: result.summary.summaryText } as SummaryData);
        }
        setIsSummarizing(false);
      } else {
        console.error('[TranscriptionSidebar] Failed to generate summary:', result.error);
        reportError(result.error, 'E3001', { transcriptionId });
        setIsSummarizing(false);
      }
    } catch (error) {
      console.error('[TranscriptionSidebar] Failed to generate summary:', error);
      reportError(error, 'E3001', { transcriptionId });
      setIsSummarizing(false);
    }
  }, [isSummarizing, isRecording, transcriptionId, isAuthenticated, setActiveTab]);

  // Listen for summary completion notifications
  React.useEffect(() => {
    if (!transcriptionId) return;

    const unsubscribe = window.api.onSummaryNotification((notification) => {
      // Only handle notifications for the current transcription
      if (notification.transcriptionId !== transcriptionId) return;

      console.log('[TranscriptionSidebar] Summary notification:', notification.type);

      if (notification.type === 'summary-completed' && notification.summaryId) {
        // Fetch and display the summary
        window.api.summary.get(notification.summaryId).then((result) => {
          console.log('[TranscriptionSidebar] Fetched summary result:', result);
          if (result.success && result.summary) {
            console.log('[TranscriptionSidebar] Raw summaryText:', result.summary.summaryText);
            setActiveSummaryId(result.summary.id);
            try {
              const parsedSummary = JSON.parse(result.summary.summaryText);
              console.log('[TranscriptionSidebar] Parsed summary:', parsedSummary);
              setSummaryContent(parsedSummary);
            } catch (parseError) {
              console.error('[TranscriptionSidebar] JSON parse error:', parseError);
              setSummaryContent({ _rawText: result.summary.summaryText } as SummaryData);
            }
          } else {
            console.error('[TranscriptionSidebar] Summary fetch failed:', result);
          }
          setIsSummarizing(false);
        });
      } else if (notification.type === 'summary-failed') {
        reportError(notification.message || 'Summary generation failed', 'E3001', {
          transcriptionId,
        });
        setIsSummarizing(false);
      }
    });

    return () => unsubscribe();
  }, [transcriptionId]);

  // Load existing summary when transcription changes
  React.useEffect(() => {
    if (!transcriptionId || isRecording) {
      setSummaryContent(null);
      setActiveSummaryId(null);
      return;
    }

    // Clear existing summary immediately when transcription changes
    setSummaryContent(null);
    setActiveSummaryId(null);

    // Check for existing summary
    window.api.summary.getByTranscription(transcriptionId).then((result) => {
      if (result.success && result.summaries && result.summaries.length > 0) {
        setActiveSummaryId(result.summaries[0].id);
        try {
          const parsedSummary = JSON.parse(result.summaries[0].summaryText);
          setSummaryContent(parsedSummary);
        } catch {
          setSummaryContent({ _rawText: result.summaries[0].summaryText } as SummaryData);
        }
      }
    });
  }, [transcriptionId, isRecording]);

  // Handle action item checkbox toggle
  const handleActionItemToggle = React.useCallback(
    async (index: number, completed: boolean) => {
      if (!summaryContent || !activeSummaryId) return;

      // Clone and update the summary content
      const updated = { ...summaryContent } as Record<string, unknown>;
      const nextSteps = Array.isArray(updated.next_steps)
        ? [...(updated.next_steps as Array<Record<string, unknown>>)]
        : [];
      if (index < 0 || index >= nextSteps.length) return;

      nextSteps[index] = { ...nextSteps[index], completed };
      updated.next_steps = nextSteps;
      const updatedData = updated as SummaryData;

      // Optimistic UI update
      const previousContent = summaryContent;
      setSummaryContent(updatedData);

      // Persist to storage
      try {
        const result = await window.api.summary.updateSummaryText(
          activeSummaryId,
          JSON.stringify(updatedData)
        );
        if (!result.success) {
          console.error(
            '[TranscriptionSidebar] Failed to persist action item toggle:',
            result.error
          );
          setSummaryContent(previousContent);
        }
      } catch (error) {
        console.error('[TranscriptionSidebar] Failed to persist action item toggle:', error);
        setSummaryContent(previousContent);
      }
    },
    [summaryContent, activeSummaryId]
  );

  // Handle editor changes when in edit mode
  const handleEditorChange = React.useCallback(
    (editorState: EditorState) => {
      if (!isEditMode) return;

      editorState.read(() => {
        const root = $getRoot();
        const textContent = root.getTextContent();
        setEditedText(textContent);
      });
    },
    [isEditMode]
  );

  // Save corrections
  const handleSaveCorrections = React.useCallback(async () => {
    if (!editedText || editedText === displayText) {
      setIsEditMode(false);
      setEditedText(null);
      return;
    }

    console.log('[TranscriptionSidebar] Saving corrections', {
      original: displayText?.substring(0, 100),
      edited: editedText.substring(0, 100),
    });

    // Update the store with corrected text
    const store = useTranscriptionStore.getState();
    const sessionId = store.activeSessionId || store.lastRecordingSessionId;

    if (sessionId) {
      try {
        // Save correction via IPC
        await window.api.transcription.saveCorrection({
          sessionId,
          originalText: displayText || '',
          correctedText: editedText,
        });
        console.log('[TranscriptionSidebar] Correction saved to database');
      } catch (error) {
        console.error('[TranscriptionSidebar] Failed to save correction:', error);
      }
    }

    // Update display text in store and mark as user-edited
    // Store original text for word-level diff highlighting
    const currentState = useTranscriptionStore.getState();
    useTranscriptionStore.setState({
      displayText: editedText,
      hasUserEdits: true,
      // Only set originalDisplayText if this is the first edit (preserve earliest original)
      originalDisplayText: currentState.originalDisplayText || displayText,
    });

    setIsEditMode(false);
    setEditedText(null);
  }, [editedText, displayText]);

  // Cancel editing
  const handleCancelEdit = React.useCallback(() => {
    setIsEditMode(false);
    setEditedText(null);
  }, []);

  // Editor config - always starts as non-editable, we toggle with editor.setEditable()
  const viewerConfig = React.useMemo(
    () => ({
      namespace: 'TranscriptionSidebarViewer',
      editable: false,
      theme: { paragraph: 'editor-paragraph' },
      onError(err: Error) {
        console.error(err);
      },
    }),
    []
  );

  // Auto-scroll to bottom when content changes (e.g. new transcription text)
  React.useEffect(() => {
    const element = contentEditableRef.current;
    if (!element || !isOpen || activeTab !== 'transcription') return;

    const scrollToBottom = () => {
      const el = contentEditableRef.current;
      if (!el) return;
      // Only auto-scroll if user is near the bottom (within 100px) or actively recording
      const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
      if (isNearBottom || isRecording) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    };

    // Initial scroll (instant on first mount)
    element.scrollTop = element.scrollHeight;

    // Watch for DOM mutations so we scroll whenever Lexical updates the content,
    // regardless of which store field triggered the re-render.
    const observer = new MutationObserver(scrollToBottom);
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => observer.disconnect();
  }, [isOpen, isRecording, activeTab]);

  // Search functionality
  const handleSearch = React.useCallback(() => {
    if (!searchQuery || !contentEditableRef.current) {
      setMatchCount(0);
      setCurrentMatchIndex(0);
      return;
    }

    const element = contentEditableRef.current;
    const text = element.textContent || '';
    const query = searchQuery.toLowerCase();
    const matches: number[] = [];

    let index = text.toLowerCase().indexOf(query);
    while (index !== -1) {
      matches.push(index);
      index = text.toLowerCase().indexOf(query, index + 1);
    }

    setMatchCount(matches.length);
    if (matches.length > 0) {
      setCurrentMatchIndex(0);
    }
  }, [searchQuery]);

  const handleNextMatch = React.useCallback(() => {
    if (matchCount > 0) {
      setCurrentMatchIndex((prev) => (prev + 1) % matchCount);
    }
  }, [matchCount]);

  const handlePrevMatch = React.useCallback(() => {
    if (matchCount > 0) {
      setCurrentMatchIndex((prev) => (prev - 1 + matchCount) % matchCount);
    }
  }, [matchCount]);

  const handleClearSearch = React.useCallback(() => {
    setSearchQuery('');
    setMatchCount(0);
    setCurrentMatchIndex(0);
  }, []);

  // Trigger search when query changes
  React.useEffect(() => {
    const timeoutId = setTimeout(handleSearch, 300);
    return () => clearTimeout(timeoutId);
  }, [handleSearch, searchQuery, displayText, partialText]);

  // Handle clicks on timestamp markers in the viewer
  const handleViewerClick = React.useCallback(
    (e: React.MouseEvent) => {
      // Don't handle clicks in edit mode
      if (isEditMode) return;

      const target = e.target as HTMLElement;
      const text = target.textContent || '';

      // Check if clicked on a timestamp marker [MM:SS]
      const timestampMatch = text.match(/^\[(\d+):(\d{2})\]/);
      if (timestampMatch) {
        const mins = parseInt(timestampMatch[1], 10);
        const secs = parseInt(timestampMatch[2], 10);
        const timeMs = (mins * 60 + secs) * 1000;

        // If we have an audio file loaded, seek to that time
        if (audioFilePath) {
          seekAudioTo(timeMs);
        } else {
          toast.info('Recording not available for playback');
        }
      }
    },
    [isEditMode, audioFilePath, seekAudioTo]
  );

  return (
    <aside
      className={`${styles.sidebar} ${isOpen ? styles.open : styles.closed}`}
      aria-label="Live transcription"
      data-testid="transcription-sidebar"
    >
      <div className={styles.panel} aria-hidden={!isOpen}>
        {(hasLiveText || isRecording) && (
          <div className={styles.searchContainer}>
            <input
              type="text"
              className={styles.searchInput}
              placeholder={t('transcription.search')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              tabIndex={isOpen ? 0 : -1}
              disabled={isEditMode}
            />
            {searchQuery && !isEditMode && (
              <>
                <span className={styles.searchStats}>
                  {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : '0/0'}
                </span>
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={handlePrevMatch}
                  disabled={matchCount === 0}
                  tabIndex={isOpen ? 0 : -1}
                  aria-label="Previous match"
                >
                  <ChevronUp20Regular />
                </button>
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={handleNextMatch}
                  disabled={matchCount === 0}
                  tabIndex={isOpen ? 0 : -1}
                  aria-label="Next match"
                >
                  <ChevronDown20Regular />
                </button>
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={handleClearSearch}
                  tabIndex={isOpen ? 0 : -1}
                  aria-label="Clear search"
                >
                  <Dismiss20Regular />
                </button>
              </>
            )}
            {/* Edit/Save buttons */}
            {canEdit && !isEditMode && (
              <Tooltip content={t('transcription.editTooltip')} relationship="label">
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={() => setIsEditMode(true)}
                  tabIndex={isOpen ? 0 : -1}
                  aria-label="Edit transcription"
                >
                  <Edit20Regular />
                </button>
              </Tooltip>
            )}
            {/* AI Summary button - only shown for licensed users */}
            {showSummaryButton && (
              <Tooltip content={t('transcription.aiSummary')} relationship="label">
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={handleSummaryClick}
                  disabled={isSummarizing}
                  tabIndex={isOpen ? 0 : -1}
                  aria-label={t('transcription.aiSummary')}
                >
                  {isSummarizing ? <Spinner size="tiny" /> : <Sparkle20Regular />}
                </button>
              </Tooltip>
            )}
            {isEditMode && (
              <>
                <button
                  type="button"
                  className={`${styles.searchButton} ${styles.saveButton}`}
                  onClick={handleSaveCorrections}
                  tabIndex={isOpen ? 0 : -1}
                  aria-label="Save corrections"
                  title="Save corrections"
                >
                  <Checkmark20Regular />
                </button>
                <button
                  type="button"
                  className={styles.searchButton}
                  onClick={handleCancelEdit}
                  tabIndex={isOpen ? 0 : -1}
                  aria-label="Cancel editing"
                  title="Cancel editing"
                >
                  <Dismiss20Regular />
                </button>
              </>
            )}
          </div>
        )}
        {/* Language detection badge - show when auto-detect is enabled and recording */}
        {isRecording && isAutoDetectEnabled && (
          <div className={styles.languageDetectionBar}>
            <Globe20Regular className={styles.languageIcon} />
            {detectedLanguage ? (
              <Tooltip
                content={`${(languageConfidence ? languageConfidence * 100 : 0).toFixed(0)}% confidence`}
                relationship="label"
              >
                <Badge appearance="filled" color="success" size="small">
                  {getLanguageName(detectedLanguage)}
                </Badge>
              </Tooltip>
            ) : (
              <span className={styles.languageDetecting}>
                {t('transcription.detectingLanguage', { defaultValue: 'Detecting language...' })}
              </span>
            )}
          </div>
        )}
        {/* Transcription view */}
        {activeTab === 'transcription' && (
          <div
            className={`${styles.viewer} ${isEditMode ? styles.editMode : ''} ${isFinalizing ? styles.finalizing : ''}`}
            ref={viewerRef}
            onClick={handleViewerClick}
            data-testid="transcription-viewer"
          >
            <LexicalComposer initialConfig={viewerConfig}>
              <RichTextPlugin
                contentEditable={
                  <div
                    className={isEditMode ? styles.editable : styles.readonly}
                    ref={contentEditableRef}
                    data-testid="transcription-content-editable"
                  >
                    <ContentEditable />
                  </div>
                }
                placeholder={null}
                ErrorBoundary={LexicalErrorBoundary}
              />
              <TranscriptionViewerPlugin
                searchQuery={isEditMode ? '' : searchQuery}
                currentMatchIndex={currentMatchIndex}
                isEditMode={isEditMode}
              />
              {isEditMode && <OnChangePlugin onChange={handleEditorChange} />}
            </LexicalComposer>
            {!isRecording && !hasLiveText && (
              <div className={styles.placeholder}>{t('transcription.livePlaceholder')}</div>
            )}
            {isEditMode && <div className={styles.editHint}>{t('transcription.editHint')}</div>}
          </div>
        )}
        {/* Summary view */}
        {activeTab === 'summary' && (
          <div className={styles.viewer} ref={viewerRef}>
            <div className={styles.summaryContent}>
              {isSummarizing ? (
                <div className={styles.summaryLoading}>
                  <div className={styles.summaryProgressBar}>
                    <ProgressBar />
                  </div>
                  <span className={styles.summaryLoadingText}>
                    {t('transcription.generatingSummary')}
                  </span>
                </div>
              ) : summaryContent ? (
                <SummaryRenderer
                  data={summaryContent}
                  showHeaders={true}
                  compact={false}
                  onActionItemToggle={handleActionItemToggle}
                />
              ) : (
                <div className={styles.summaryPlaceholder}>
                  <Sparkle20Regular className={styles.summaryIcon} />
                  <p>{t('transcription.summaryPlaceholder')}</p>
                </div>
              )}
            </div>
          </div>
        )}
        {/* Audio Player / Finalizing status */}
        {isFinalizing ? (
          <div className={styles.finalizingStatus}>
            <span className={styles.finalizingStatusText}>
              Performing final audio pass to improve accuracy…
            </span>
          </div>
        ) : (
          hasRecording &&
          !isRecording &&
          transcriptionId && <AudioPlayer sessionId={transcriptionId} />
        )}
      </div>

      {/* Sign In Required Modal */}
      <SignInRequiredModal
        open={showSignInModal}
        onDismiss={() => setShowSignInModal(false)}
        feature="AI Summary"
      />
    </aside>
  );
};
