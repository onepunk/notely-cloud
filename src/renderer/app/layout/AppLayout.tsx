import { FluentProvider } from '@fluentui/react-components';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation, useParams } from 'react-router-dom';
import { Toaster } from 'sonner';

import { TranscriptionsContent } from '../../app/pages/TranscriptionsPage';
import { useBindersStore } from '../../features/binders/model/binders.store';
import { TranscriptionSidebar } from '../../features/transcription/components/TranscriptionSidebar';
import sidebarStyles from '../../features/transcription/components/TranscriptionSidebar.module.css';
import { useTranscriptionStore } from '../../features/transcription/model/transcription.store';
import { UpdateNotification } from '../../features/update';
import { useLicense } from '../../shared/hooks/useLicense';
import { useNativeMenu } from '../../shared/hooks/useNativeMenu';
import { useSettingsStore } from '../../shared/state/settings.store';
import { notelyDarkTheme, notelyTheme } from '../../shared/styles/theme';

import styles from './AppLayout.module.css';
import { BottomBar, type LeftPanelTab, type RightPanelTab } from './BottomBar';
import { type BreadcrumbItem } from './Breadcrumb';
import { NavigationPanel } from './NavigationPanel';
import { SlideInPanel } from './SlideInPanel';
import { Titlebar } from './Titlebar';

const THEME_KEY = 'system.theme';
const LEFT_PANEL_STATE_KEY = 'ui.leftPanel.open';
const RIGHT_PANEL_STATE_KEY = 'ui.rightPanel.open';
const LEFT_PANEL_TAB_KEY = 'ui.leftPanel.tab';
const RIGHT_PANEL_TAB_KEY = 'ui.rightPanel.tab';
const LEFT_PANEL_PINNED_KEY = 'ui.leftPanel.pinned';
const RIGHT_PANEL_PINNED_KEY = 'ui.rightPanel.pinned';
const LAST_NOTE_ROUTE_KEY = 'ui.lastNoteRoute';

// System binder ID (matches backend UUIDv5 generation)
const UNASSIGNED_BINDER_ID = 'ab6eb598-eeee-4d13-8dde-3eb2b496e91e';

export const AppLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { binderId, noteId } = useParams();
  const { license } = useLicense();
  const hasActiveLicense = license.status === 'active' || license.status === 'expiring';

  // Theme settings
  const themePreference = useSettingsStore((state) => state.values[THEME_KEY] ?? 'system');
  const setSetting = useSettingsStore((state) => state.setValue);
  const setBooleanSetting = useSettingsStore((state) => state.setBoolean);

  // Panel state from settings
  const savedLeftPanelOpen = useSettingsStore((state) =>
    state.getBoolean(LEFT_PANEL_STATE_KEY, false)
  );
  const savedRightPanelOpen = useSettingsStore((state) =>
    state.getBoolean(RIGHT_PANEL_STATE_KEY, false)
  );
  const savedLeftPanelTab = useSettingsStore(
    (state) => (state.values[LEFT_PANEL_TAB_KEY] as LeftPanelTab) ?? 'binders'
  );
  const savedRightPanelTab = useSettingsStore(
    (state) => (state.values[RIGHT_PANEL_TAB_KEY] as RightPanelTab) ?? 'transcription'
  );
  const savedLeftPanelPinned = useSettingsStore((state) =>
    state.getBoolean(LEFT_PANEL_PINNED_KEY, false)
  );
  const savedRightPanelPinned = useSettingsStore((state) =>
    state.getBoolean(RIGHT_PANEL_PINNED_KEY, false)
  );
  const savedLastNoteRoute = useSettingsStore(
    (state) => state.values[LAST_NOTE_ROUTE_KEY] as string | undefined
  );

  // Local panel state
  const [leftPanelOpen, setLeftPanelOpen] = React.useState(savedLeftPanelOpen);
  const [rightPanelOpen, setRightPanelOpen] = React.useState(savedRightPanelOpen);
  const [activeLeftTab, setActiveLeftTab] = React.useState<LeftPanelTab>(savedLeftPanelTab);
  const [activeRightTab, setActiveRightTab] = React.useState<RightPanelTab>(savedRightPanelTab);
  const [leftPanelPinned, setLeftPanelPinned] = React.useState(savedLeftPanelPinned);
  const [rightPanelPinned, setRightPanelPinned] = React.useState(savedRightPanelPinned);

  // Transcriptions panel state
  const [transcriptionsPanelOpen, setTranscriptionsPanelOpen] = React.useState(false);

  // Recording state
  const isRecording = useTranscriptionStore((s) => s.isRecording);
  const startRecording = useTranscriptionStore((s) => s.start);
  const stopRecording = useTranscriptionStore((s) => s.stop);

  // Track if we opened the panel for recording (to keep it open after recording stops)
  const openedForRecordingRef = React.useRef(false);

  // Binder name from store
  const binders = useBindersStore((state) => state.binders);
  const binderName = React.useMemo(() => {
    if (!binderId) return null;
    const binder = binders.find((b) => b.id === binderId);
    return binder?.name ?? null;
  }, [binderId, binders]);

  // System theme detection
  const [systemPrefersDark, setSystemPrefersDark] = React.useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', listener);
    } else {
      mediaQuery.addListener(listener);
    }
    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', listener);
      } else {
        mediaQuery.removeListener(listener);
      }
    };
  }, []);

  const effectiveTheme = React.useMemo<'light' | 'dark'>(() => {
    if (themePreference === 'dark') return 'dark';
    if (themePreference === 'light') return 'light';
    return systemPrefersDark ? 'dark' : 'light';
  }, [systemPrefersDark, themePreference]);

  const theme = React.useMemo(
    () => (effectiveTheme === 'dark' ? notelyDarkTheme : notelyTheme),
    [effectiveTheme]
  );

  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = effectiveTheme;
    root.style.colorScheme = effectiveTheme;
    document.body.dataset.theme = effectiveTheme;
  }, [effectiveTheme]);

  // Sync panel state with settings
  React.useEffect(() => {
    setLeftPanelOpen(savedLeftPanelOpen);
  }, [savedLeftPanelOpen]);

  React.useEffect(() => {
    setRightPanelOpen(savedRightPanelOpen);
  }, [savedRightPanelOpen]);

  React.useEffect(() => {
    setLeftPanelPinned(savedLeftPanelPinned);
  }, [savedLeftPanelPinned]);

  React.useEffect(() => {
    setRightPanelPinned(savedRightPanelPinned);
  }, [savedRightPanelPinned]);

  // Persist panel state changes
  React.useEffect(() => {
    void setBooleanSetting(LEFT_PANEL_STATE_KEY, leftPanelOpen);
  }, [leftPanelOpen, setBooleanSetting]);

  React.useEffect(() => {
    void setBooleanSetting(RIGHT_PANEL_STATE_KEY, rightPanelOpen);
  }, [rightPanelOpen, setBooleanSetting]);

  React.useEffect(() => {
    void setSetting(LEFT_PANEL_TAB_KEY, activeLeftTab);
  }, [activeLeftTab, setSetting]);

  React.useEffect(() => {
    void setSetting(RIGHT_PANEL_TAB_KEY, activeRightTab);
  }, [activeRightTab, setSetting]);

  React.useEffect(() => {
    void setBooleanSetting(LEFT_PANEL_PINNED_KEY, leftPanelPinned);
  }, [leftPanelPinned, setBooleanSetting]);

  React.useEffect(() => {
    void setBooleanSetting(RIGHT_PANEL_PINNED_KEY, rightPanelPinned);
  }, [rightPanelPinned, setBooleanSetting]);

  // Open right panel when recording starts, keep it open when recording stops
  React.useEffect(() => {
    if (isRecording) {
      setRightPanelOpen(true);
      setActiveRightTab('transcription');
      openedForRecordingRef.current = true;
    } else if (openedForRecordingRef.current) {
      // Recording just stopped - keep panel open so user can read transcription
      // Don't close it automatically
      setRightPanelOpen(true);
    }
  }, [isRecording]);

  // Track last opened note route
  React.useEffect(() => {
    const path = location.pathname;
    const isNoteRoute = path === '/' || path.startsWith('/notes/') || path.startsWith('/binders/');

    if (isNoteRoute && path !== '/calendar' && !path.startsWith('/settings')) {
      void setSetting(LAST_NOTE_ROUTE_KEY, path);
    }
  }, [location.pathname, setSetting]);

  // Panel toggle handlers
  const handleToggleLeftPanel = React.useCallback(() => {
    setLeftPanelOpen((prev) => !prev);
  }, []);

  const handleToggleRightPanel = React.useCallback(() => {
    setRightPanelOpen((prev) => !prev);
  }, []);

  const handleLeftTabChange = React.useCallback((tab: LeftPanelTab) => {
    setActiveLeftTab(tab);
  }, []);

  const handleRightTabChange = React.useCallback((tab: RightPanelTab) => {
    setActiveRightTab(tab);
  }, []);

  const handleCloseLeftPanel = React.useCallback(() => {
    setLeftPanelOpen(false);
  }, []);

  const handleCloseRightPanel = React.useCallback(() => {
    setRightPanelOpen(false);
    openedForRecordingRef.current = false; // Clear ref so next recording session works correctly
  }, []);

  // Pin toggle handlers
  const handleToggleLeftPanelPin = React.useCallback(() => {
    setLeftPanelPinned((prev) => !prev);
  }, []);

  const handleToggleRightPanelPin = React.useCallback(() => {
    setRightPanelPinned((prev) => !prev);
  }, []);

  // Recording handlers
  const handleToggleRecording = React.useCallback(async () => {
    if (isRecording) {
      await stopRecording();
    } else {
      const editorBinderId = binderId || UNASSIGNED_BINDER_ID;
      await startRecording({ binderId: editorBinderId, noteId });
    }
  }, [isRecording, stopRecording, startRecording, binderId, noteId]);

  // Go home handler
  const handleGoHome = React.useCallback(() => {
    // Reset layout to default: close both panels
    setLeftPanelOpen(false);
    setRightPanelOpen(false);
    openedForRecordingRef.current = false;
    // Return the last note route (or index if none saved)
    return savedLastNoteRoute || '/';
  }, [savedLastNoteRoute]);

  // Handle breadcrumb binder click - opens the binders panel
  const handleBinderClick = React.useCallback(() => {
    setActiveLeftTab('binders');
    setLeftPanelOpen(true);
  }, []);

  // Handle opening transcriptions panel
  const handleOpenTranscriptions = React.useCallback(() => {
    // Close the right transcription sidebar to avoid stacking two right panels
    setRightPanelOpen(false);
    setTranscriptionsPanelOpen(true);
  }, []);

  // Native macOS menu integration
  useNativeMenu({ noteId, onOpenTranscriptions: handleOpenTranscriptions });

  const handleCloseTranscriptionsPanel = React.useCallback(() => {
    setTranscriptionsPanelOpen(false);
  }, []);

  // When a transcription is selected from the list, close the panel and open the sidebar
  const handleSelectTranscription = React.useCallback(() => {
    setTranscriptionsPanelOpen(false);
    setActiveRightTab('transcription');
    setRightPanelOpen(true);
  }, []);

  // Build breadcrumb items based on current route
  // We no longer show "Note" in breadcrumb - just the binder name
  const breadcrumbItems = React.useMemo<BreadcrumbItem[]>(() => {
    return [];
  }, []);

  // Keyboard shortcuts for panel toggles
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMod = event.metaKey || event.ctrlKey;

      // Cmd/Ctrl + B: Toggle left panel (Binders)
      if (isMod && event.key === 'b' && !event.shiftKey) {
        event.preventDefault();
        if (leftPanelOpen && activeLeftTab === 'binders') {
          setLeftPanelOpen(false);
        } else {
          setActiveLeftTab('binders');
          setLeftPanelOpen(true);
        }
      }

      // Cmd/Ctrl + Shift + B: Toggle left panel (Tags)
      if (isMod && event.key === 'b' && event.shiftKey) {
        event.preventDefault();
        if (leftPanelOpen && activeLeftTab === 'tags') {
          setLeftPanelOpen(false);
        } else {
          setActiveLeftTab('tags');
          setLeftPanelOpen(true);
        }
      }

      // Cmd/Ctrl + T: Toggle right panel (Transcription)
      if (isMod && event.key === 't' && !event.shiftKey) {
        event.preventDefault();
        if (rightPanelOpen && activeRightTab === 'transcription') {
          setRightPanelOpen(false);
        } else {
          setActiveRightTab('transcription');
          setRightPanelOpen(true);
        }
      }

      // Cmd/Ctrl + Shift + T: Toggle right panel (Summary)
      if (isMod && event.key === 't' && event.shiftKey) {
        event.preventDefault();
        if (rightPanelOpen && activeRightTab === 'summary') {
          setRightPanelOpen(false);
        } else {
          setActiveRightTab('summary');
          setRightPanelOpen(true);
        }
      }

      // Escape: Close open panels (only if not pinned)
      if (event.key === 'Escape') {
        if (rightPanelOpen && !rightPanelPinned) {
          setRightPanelOpen(false);
        } else if (leftPanelOpen && !leftPanelPinned) {
          setLeftPanelOpen(false);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    leftPanelOpen,
    rightPanelOpen,
    activeLeftTab,
    activeRightTab,
    leftPanelPinned,
    rightPanelPinned,
  ]);

  // Dispatch events for components that listen to panel state
  React.useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('rightSidebar:state', {
        detail: { isOpen: rightPanelOpen },
      })
    );
  }, [rightPanelOpen]);

  return (
    <FluentProvider theme={theme}>
      <Toaster position="bottom-right" richColors closeButton />
      <UpdateNotification />
      <div className={styles.root}>
        <Titlebar
          breadcrumbItems={breadcrumbItems}
          binderName={binderName}
          isRecording={isRecording}
          onGoHome={handleGoHome}
          onBinderClick={handleBinderClick}
          onOpenTranscriptions={handleOpenTranscriptions}
          rightPanelOpen={rightPanelOpen}
          onToggleRightPanel={handleToggleRightPanel}
          leftPanelOpen={leftPanelOpen}
          activeLeftTab={activeLeftTab}
          onToggleLeftPanel={handleToggleLeftPanel}
          onLeftTabChange={handleLeftTabChange}
        />
        <div className={styles.main}>
          <SlideInPanel
            isOpen={leftPanelOpen}
            position="left"
            width={280}
            isPinned={leftPanelPinned}
            onTogglePin={handleToggleLeftPanelPin}
            headerless
          >
            <NavigationPanel
              activeTab={activeLeftTab}
              onTabChange={handleLeftTabChange}
              onNavigate={leftPanelPinned ? undefined : handleCloseLeftPanel}
            />
          </SlideInPanel>

          <section
            className={`${styles.content} ${leftPanelOpen ? styles.leftPanelOpen : ''} ${rightPanelOpen ? styles.rightPanelOpen : ''}`}
          >
            <Outlet />
          </section>

          <SlideInPanel
            isOpen={rightPanelOpen}
            position="right"
            width={340}
            isPinned={rightPanelPinned}
            onTogglePin={handleToggleRightPanelPin}
            pinPosition="left"
            title="Transcription"
            titleContent={
              hasActiveLicense ? (
                <div className={sidebarStyles.tabsContainer}>
                  <button
                    type="button"
                    className={`${sidebarStyles.tab} ${activeRightTab === 'transcription' ? sidebarStyles.tabActive : ''}`}
                    onClick={() => handleRightTabChange('transcription')}
                  >
                    {t('transcription.tabs.transcription')}
                  </button>
                  <button
                    type="button"
                    className={`${sidebarStyles.tab} ${activeRightTab === 'summary' ? sidebarStyles.tabActive : ''}`}
                    onClick={() => handleRightTabChange('summary')}
                  >
                    {t('transcription.tabs.summary')}
                  </button>
                </div>
              ) : undefined
            }
          >
            <TranscriptionSidebar
              isOpen={rightPanelOpen}
              activeTab={activeRightTab}
              onTabChange={handleRightTabChange}
            />
          </SlideInPanel>

          <SlideInPanel
            isOpen={transcriptionsPanelOpen}
            position="right"
            width={340}
            onClose={handleCloseTranscriptionsPanel}
            title="Transcriptions"
          >
            <TranscriptionsContent
              onClose={handleCloseTranscriptionsPanel}
              onSelectTranscription={handleSelectTranscription}
            />
          </SlideInPanel>
        </div>
        <BottomBar
          isRecording={isRecording}
          onToggleRecording={handleToggleRecording}
          leftPanelOpen={leftPanelOpen}
          onToggleLeftPanel={handleToggleLeftPanel}
          activeLeftTab={activeLeftTab}
          onLeftTabChange={handleLeftTabChange}
        />
      </div>
    </FluentProvider>
  );
};
