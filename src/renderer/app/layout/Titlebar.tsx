import {
  Input,
  Button,
  Menu,
  MenuTrigger,
  MenuPopover,
  MenuList,
  MenuItem,
  Tooltip,
} from '@fluentui/react-components';
import {
  Dismiss20Regular,
  Subtract20Regular,
  Maximize20Regular,
  Navigation20Regular,
  Home20Regular,
} from '@fluentui/react-icons';
import DOMPurify from 'dompurify';
import { FolderOpen, PanelRight } from 'lucide-react';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { reportError } from '@shared/error';
import { useIsAuthenticated } from '@shared/hooks/useAuthStore';
import { useLicense } from '@shared/hooks/useLicense';
import { useUpgradeAction } from '@shared/hooks/useUpgradeAction';

import { useSettingsStore } from '../../shared/state/settings.store';

import type { LeftPanelTab } from './BottomBar';
import { Breadcrumb, type BreadcrumbItem } from './Breadcrumb';
import notelyLogoDark from './notely-dark.png';
import notelyLogo from './notely.png';
import { RecordingIndicator } from './RecordingIndicator';
import styles from './Titlebar.module.css';

const UNASSIGNED_BINDER_ID = 'ab6eb598-eeee-4d13-8dde-3eb2b496e91e';
const CONTENT_FONT_SCALE_KEY = 'ui.contentFontScale';
const FONT_SCALE_MIN = 0.8;
const FONT_SCALE_MAX = 1.6;
const FONT_SCALE_STEP = 0.1;

const clampFontScale = (value: number) => {
  if (!Number.isFinite(value)) return 1;
  if (value < FONT_SCALE_MIN) return FONT_SCALE_MIN;
  if (value > FONT_SCALE_MAX) return FONT_SCALE_MAX;
  return value;
};

interface TitlebarProps {
  breadcrumbItems?: BreadcrumbItem[];
  binderName?: string | null;
  isRecording?: boolean;
  onGoHome?: () => string;
  onBinderClick?: () => void;
  onOpenTranscriptions?: () => void;
  rightPanelOpen?: boolean;
  onToggleRightPanel?: () => void;
  leftPanelOpen?: boolean;
  activeLeftTab?: LeftPanelTab;
  onToggleLeftPanel?: () => void;
  onLeftTabChange?: (tab: LeftPanelTab) => void;
}

export const Titlebar: React.FC<TitlebarProps> = ({
  breadcrumbItems = [],
  binderName,
  isRecording = false,
  onGoHome,
  onBinderClick,
  onOpenTranscriptions,
  rightPanelOpen = false,
  onToggleRightPanel,
  leftPanelOpen = false,
  activeLeftTab = 'binders',
  onToggleLeftPanel,
  onLeftTabChange,
}) => {
  const { t } = useTranslation();
  const platform = window.api?.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';
  const [q, setQ] = React.useState('');
  const [results, setResults] = React.useState<
    Array<{
      type: 'note' | 'transcription' | 'tag';
      id: string;
      noteId: string | null;
      binderId: string | null;
      title: string;
      snippet: string;
      tagColor?: string | null;
      tagNoteCount?: number;
    }>
  >([]);
  const [open, setOpen] = React.useState(false);
  const [dropdownPosition, setDropdownPosition] = React.useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);
  const searchRef = React.useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  // Is the user inside a binder viewing notes (vs. on the binder list)?
  const isViewingNotes = React.useMemo(() => {
    const path = location.pathname;
    const searchParams = new URLSearchParams(location.search);
    return path.startsWith('/binders/') || searchParams.has('view');
  }, [location.pathname, location.search]);

  const handleBinderToggle = React.useCallback(() => {
    // Ensure left tab is set to binders
    onLeftTabChange?.('binders');

    if (!leftPanelOpen) {
      // Panel closed -> open it
      onToggleLeftPanel?.();
    } else if (isViewingNotes) {
      // Panel open + viewing notes inside a binder -> navigate back to binder list
      navigate('/');
    } else {
      // Panel open + showing binder list -> close it
      onToggleLeftPanel?.();
    }
  }, [leftPanelOpen, onToggleLeftPanel, onLeftTabChange, isViewingNotes, navigate]);

  // Auth state
  const isAuthenticated = useIsAuthenticated();
  const { handleUpgrade, isPendingAuth } = useUpgradeAction();
  const { license } = useLicense();
  const savedFontScale = useSettingsStore((state) => state.values[CONTENT_FONT_SCALE_KEY]);
  const themePreference = useSettingsStore((state) => state.values['system.theme'] ?? 'system');
  const setSetting = useSettingsStore((state) => state.setValue);
  const [fontScale, setFontScale] = React.useState<number>(() =>
    clampFontScale(parseFloat(savedFontScale ?? '1'))
  );

  // Resolve effective theme for logo swap
  const effectiveTheme = React.useMemo<'light' | 'dark'>(() => {
    if (themePreference === 'dark') return 'dark';
    if (themePreference === 'light') return 'light';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }, [themePreference]);

  // Show sign-in button when user is not authenticated
  const showSignInButton = !isAuthenticated;

  React.useEffect(() => {
    setFontScale(clampFontScale(parseFloat(savedFontScale ?? '1')));
  }, [savedFontScale]);

  React.useEffect(() => {
    document.documentElement.style.setProperty('--content-font-scale', fontScale.toString());
  }, [fontScale]);

  const updateFontScale = React.useCallback(
    (delta: number) => {
      setFontScale((current) => {
        const next = clampFontScale(parseFloat((current + delta).toFixed(2)));
        void setSetting(CONTENT_FONT_SCALE_KEY, next.toString());
        return next;
      });
    },
    [setSetting]
  );

  const resetFontScale = React.useCallback(() => {
    setFontScale((current) => {
      const next = 1;
      if (current === next) return current;
      void setSetting(CONTENT_FONT_SCALE_KEY, next.toString());
      return next;
    });
  }, [setSetting]);

  const fontScalePercent = Math.round(fontScale * 100);

  // Extract noteId from current route (e.g., /binders/:binderId/notes/:noteId)
  const currentNoteId = React.useMemo(() => {
    const match = location.pathname.match(/\/notes\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
  }, [location.pathname]);

  // Export handler
  const handleExport = React.useCallback(
    async (format: 'txt' | 'md' | 'docx' | 'rtf' | 'pdf') => {
      if (!currentNoteId) {
        reportError(null, 'E5002');
        return;
      }
      try {
        const result = await window.api.export.note(currentNoteId, format);
        if (result.success) {
          toast.success(t('export.success'));
        } else if (result.error !== 'Export cancelled') {
          reportError(result.error, 'E5001', { noteId: currentNoteId, format });
        }
      } catch (error) {
        reportError(error, 'E5001', { noteId: currentNoteId, format });
      }
    },
    [currentNoteId, t]
  );

  const searchNow = React.useCallback(async () => {
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    try {
      const res = await window.api.storage.search(q.trim());
      setResults(res);
      setOpen(res.length > 0);
    } catch (error) {
      reportError(error, 'E8005');
    }
  }, [q]);

  // Debounced live search
  React.useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (q.trim()) {
        searchNow();
      } else {
        setResults([]);
        setOpen(false);
      }
    }, 300); // 300ms debounce

    return () => clearTimeout(timeoutId);
  }, [q, searchNow]);

  // Update dropdown position when opening
  React.useEffect(() => {
    if (open && searchRef.current) {
      const rect = searchRef.current.getBoundingClientRect();
      setDropdownPosition({
        top: rect.bottom + 4,
        left: rect.left,
        width: rect.width,
      });
    } else {
      setDropdownPosition(null);
    }
  }, [open]);

  // Close search dropdown when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;
      if (
        open &&
        !target.closest(`.${styles.center}`) &&
        !target.closest('[data-search-dropdown]')
      ) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  // Update Windows titlebar overlay colors from CSS tokens (no dimming on modal)
  React.useEffect(() => {
    if (!isWindows || typeof window.api?.setTitlebarOverlay !== 'function') return;
    try {
      const getVar = (name: string, fallback: string) =>
        getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
      const bg = getVar('--titlebar-bg', '#e2e2e2');
      const fg = getVar('--titlebar-fg', '#132e2d');
      // apply once on mount; hover visuals remain handled by the OS
      void window.api.setTitlebarOverlay({ color: bg, symbolColor: fg, height: 36 });
    } catch (err) {
      console.warn('Failed to set titlebar overlay colors', err);
    }
  }, [isWindows]);

  return (
    <div className={`${styles.root} ${isWindows ? styles.win : ''} ${isMac ? styles.mac : ''}`}>
      <div className={styles['left-group']}>
        {!isMac && (
          <img
            src={effectiveTheme === 'light' ? notelyLogoDark : notelyLogo}
            alt="Notely Logo"
            className={styles.logo}
          />
        )}
        <Button
          appearance="transparent"
          size="small"
          className={styles['home-button']}
          aria-label="Go home"
          onClick={() => {
            if (onGoHome) {
              const route = onGoHome();
              navigate(route);
            }
          }}
        >
          <Home20Regular />
        </Button>
        <button
          type="button"
          className={`${styles['binder-button']} ${leftPanelOpen && activeLeftTab === 'binders' ? styles['binder-button-active'] : ''}`}
          aria-label={t('sidebar.binders')}
          data-panel-toggle="left"
          data-testid="titlebar-binder-toggle"
          onClick={handleBinderToggle}
        >
          <FolderOpen size={16} strokeWidth={1.6} />
        </button>
        {showSignInButton && (
          <Button
            appearance="secondary"
            size="small"
            className={styles['upgrade-button']}
            onClick={handleUpgrade}
            disabled={isPendingAuth}
          >
            {isPendingAuth ? 'Signing in...' : 'Sign-in'}
          </Button>
        )}
      </div>

      {/* Breadcrumb navigation */}
      <div className={styles.breadcrumbArea}>
        <Breadcrumb
          items={breadcrumbItems}
          binderName={binderName}
          onBinderClick={onBinderClick}
          onGoHome={onGoHome}
        />
      </div>

      {/* Recording indicator - always render the wrapper to keep grid column count stable */}
      <div className={styles.recordingArea}>
        {isRecording && <RecordingIndicator isRecording={isRecording} />}
      </div>

      <div className={styles.center} ref={searchRef}>
        <Input
          className={styles.search}
          size="small"
          placeholder={t('search.placeholder')}
          value={q}
          onChange={(_, d) => setQ(d.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              searchNow();
            }
          }}
        />
      </div>

      {/* Search dropdown rendered as portal */}
      {open &&
        results.length > 0 &&
        dropdownPosition &&
        createPortal(
          <div
            className={styles.dropdown}
            data-search-dropdown
            style={{
              position: 'fixed',
              top: dropdownPosition.top,
              left: dropdownPosition.left,
              width: dropdownPosition.width,
            }}
          >
            {results.map((r) => (
              <div
                key={r.id}
                className={styles.item}
                onClick={() => {
                  if (r.type === 'tag') {
                    // Navigate to tag filter view
                    navigate(`/?view=tag&tagId=${r.id}`);
                  } else {
                    // Navigate to note/transcription
                    navigate('/binders/' + r.binderId + '/notes/' + r.noteId);
                  }
                  setOpen(false);
                  setQ(''); // Clear search after selection
                }}
              >
                <div className={styles.itemHeader}>
                  {r.type === 'tag' && r.tagColor && (
                    <span className={styles.tagDot} style={{ backgroundColor: r.tagColor }} />
                  )}
                  <span className={styles.title}>{r.title || 'Untitled'}</span>
                  <span
                    className={`${styles.badge} ${
                      r.type === 'transcription'
                        ? styles.badgeTranscription
                        : r.type === 'tag'
                          ? styles.badgeTag
                          : styles.badgeNote
                    }`}
                  >
                    {r.type === 'transcription'
                      ? 'Transcription'
                      : r.type === 'tag'
                        ? 'Tag'
                        : 'Note'}
                  </span>
                </div>
                <div
                  className={styles.snippet}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(r.snippet) }}
                />
              </div>
            ))}
          </div>,
          document.body
        )}

      <div className={styles['right-group']}>
        <Button
          appearance="primary"
          size="small"
          className={styles['new-button']}
          onClick={async () => {
            try {
              const parts = location.pathname.split('/').filter(Boolean);
              const inBinder = parts[0] === 'binders' && parts[1];
              const binderId = inBinder ? parts[1] : UNASSIGNED_BINDER_ID;
              const id = await window.api.storage.createNote(binderId);
              navigate('/binders/' + binderId + '/notes/' + id);
            } catch (error) {
              reportError(error, 'E4005');
            }
          }}
        >
          {t('notes.new')}
        </Button>
        <Tooltip content={t('common.transcriptions')} relationship="label">
          <button
            type="button"
            className={`${styles['panel-toggle']} ${rightPanelOpen ? styles['panel-toggle-active'] : ''}`}
            onClick={onToggleRightPanel}
            data-panel-toggle="right"
            aria-label={t('common.transcriptions')}
          >
            <PanelRight size={18} strokeWidth={1.6} />
          </button>
        </Tooltip>
        {!isMac && (
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                appearance="transparent"
                size="small"
                className={styles['menu-button']}
                aria-label="Menu"
              >
                <Navigation20Regular />
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem onClick={() => navigate('/settings/about')}>About Notely</MenuItem>
                <MenuItem onClick={() => onOpenTranscriptions?.()}>Transcriptions</MenuItem>
                <MenuItem onClick={() => navigate('/settings/general')}>Settings</MenuItem>
                {currentNoteId && (
                  <Menu>
                    <MenuTrigger disableButtonEnhancement>
                      <MenuItem>{t('notes.export')}</MenuItem>
                    </MenuTrigger>
                    <MenuPopover>
                      <MenuList>
                        <MenuItem onClick={() => handleExport('txt')}>{t('export.txt')}</MenuItem>
                        <MenuItem onClick={() => handleExport('md')}>{t('export.md')}</MenuItem>
                        <MenuItem onClick={() => handleExport('docx')}>{t('export.docx')}</MenuItem>
                        <MenuItem onClick={() => handleExport('rtf')}>{t('export.rtf')}</MenuItem>
                        <MenuItem onClick={() => handleExport('pdf')}>{t('export.pdf')}</MenuItem>
                      </MenuList>
                    </MenuPopover>
                  </Menu>
                )}
                <MenuItem
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <div className={styles.fontScaleRow}>
                    <span className={styles.fontScaleLabel}>Font</span>
                    <div className={styles.fontScaleControls}>
                      <Button
                        appearance="subtle"
                        size="small"
                        className={styles.fontScaleButton}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          updateFontScale(-FONT_SCALE_STEP);
                        }}
                        disabled={fontScale <= FONT_SCALE_MIN}
                        aria-label="Decrease font size"
                      >
                        -
                      </Button>
                      <button
                        type="button"
                        className={styles.fontScaleValue}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          resetFontScale();
                        }}
                        aria-label="Reset font size to 100%"
                      >
                        {fontScalePercent}%
                      </button>
                      <Button
                        appearance="subtle"
                        size="small"
                        className={styles.fontScaleButton}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          updateFontScale(FONT_SCALE_STEP);
                        }}
                        disabled={fontScale >= FONT_SCALE_MAX}
                        aria-label="Increase font size"
                      >
                        +
                      </Button>
                    </div>
                  </div>
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        )}
        {/* Render custom caption buttons only when not Windows/macOS */}
        {!isWindows && !isMac && (
          <div className={styles['win-btns']}>
            <Button
              appearance="transparent"
              size="small"
              className={styles['caption-btn']}
              aria-label="Minimize"
              onClick={() => window.api.windowControl('min')}
            >
              <Subtract20Regular />
            </Button>
            <Button
              appearance="transparent"
              size="small"
              className={styles['caption-btn']}
              aria-label="Maximize"
              onClick={() => window.api.windowControl('max')}
            >
              <Maximize20Regular />
            </Button>
            <Button
              appearance="transparent"
              size="small"
              className={`${styles['caption-btn']} ${styles['close-btn']}`}
              aria-label="Close"
              onClick={() => window.api.windowControl('close')}
            >
              <Dismiss20Regular />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};
