import { Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components';
import { Mic16Filled, Star16Regular, Star16Filled, Warning16Filled } from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import { reportError } from '@shared/error';

import type { QuickViewKey } from '../../../app/types/quickViews';

import styles from './NoteList.module.css';

type NoteSummary = {
  id: string;
  title: string;
  binder_id: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  pinned: number;
  starred?: number;
  archived?: number;
};

type Props = {
  onToggleCollapse?: () => void;
  currentNoteId?: string;
  currentEditorTitle?: string;
  binderId?: string;
  view?: QuickViewKey;
};

export const NoteList: React.FC<Props> = ({
  onToggleCollapse,
  currentNoteId,
  currentEditorTitle,
  binderId: propsBinderId,
  view,
}) => {
  const { t } = useTranslation();
  const { binderId: routeBinderId, noteId } = useParams();
  const location = useLocation();
  const [notes, setNotes] = React.useState<NoteSummary[]>([]);
  const [notesWithTranscriptions, setNotesWithTranscriptions] = React.useState<Set<string>>(
    new Set()
  );
  // Track which notes have conflict copies (Phase 5)
  const [notesWithConflicts, setNotesWithConflicts] = React.useState<Set<string>>(new Set());
  // Track if we're viewing the Conflicts binder
  const [isConflictsBinder, setIsConflictsBinder] = React.useState(false);
  const navigate = useNavigate();
  const [menuState, setMenuState] = React.useState<{ id: string | null; target: Element | null }>({
    id: null,
    target: null,
  });
  const [isScrolling, setIsScrolling] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = React.useRef<NodeJS.Timeout>();

  // Check if filtering by tag
  const tagIdFilter = React.useMemo(() => {
    const search = new URLSearchParams(location.search);
    if (search.get('view') === 'tag') {
      return search.get('tagId');
    }
    return null;
  }, [location.search]);

  const quickViewSearch = React.useMemo(() => {
    if (!view) return '';
    if (view === 'all') return '';
    return `?view=${view}`;
  }, [view]);

  const createVirtualElement = (x: number, y: number): Element =>
    ({
      getBoundingClientRect: () =>
        ({
          x,
          y,
          top: y,
          left: x,
          bottom: y,
          right: x,
          width: 0,
          height: 0,
          toJSON: () => ({ x, y, top: y, left: x, bottom: y, right: x, width: 0, height: 0 }),
        }) as DOMRect,
    }) as Element;

  const refresh = React.useCallback(async () => {
    const effectiveBinderId = propsBinderId || routeBinderId;
    let rows: NoteSummary[] = [];
    let isConflicts = false;

    // Check if this is the conflicts binder
    if (effectiveBinderId) {
      try {
        const conflictsBinder = await window.api.storage.getConflictsBinder();
        if (conflictsBinder && conflictsBinder.id === effectiveBinderId) {
          isConflicts = true;
        }
      } catch {
        // Conflicts binder check failed, continue normally
      }
    }
    setIsConflictsBinder(isConflicts);

    // Handle tag filtering
    if (tagIdFilter) {
      rows = (await window.api.tags.getNotesByTag(tagIdFilter)) as NoteSummary[];
    } else if (view) {
      if (view === 'all') {
        rows = await window.api.storage.listAllNotes();
      } else if (view === 'today') {
        const now = new Date();
        const start = new Date(now);
        start.setHours(0, 0, 0, 0);
        const end = new Date(now);
        end.setHours(23, 59, 59, 999);
        rows = await window.api.storage.listNotesByCreatedBetween(start.getTime(), end.getTime());
      } else if (view === 'starred') {
        rows = await window.api.storage.listStarredNotes();
      } else if (view === 'archived') {
        rows = await window.api.storage.listArchivedNotes();
      } else if (view === 'trash') {
        rows = await window.api.storage.listDeletedNotes();
      } else {
        rows = [];
      }
    } else if (effectiveBinderId) {
      // If viewing conflicts binder, load conflict notes
      if (isConflicts) {
        rows = await window.api.storage.listConflicts();
      } else {
        rows = await window.api.storage.listNotesByBinder(effectiveBinderId);
      }
    }

    setNotes(rows);

    if (view === 'trash') {
      setNotesWithTranscriptions(new Set());
      setNotesWithConflicts(new Set());
      return;
    }

    // Fetch transcriptions and conflicts for notes in parallel
    const notesWithTrans = new Set<string>();
    let conflictNoteIds: string[] = [];

    // Load notes with conflicts (only for non-conflicts binder)
    if (!isConflicts) {
      try {
        conflictNoteIds = await window.api.storage.getNotesWithConflicts();
      } catch {
        // Failed to load conflict info
      }
    }
    setNotesWithConflicts(new Set(conflictNoteIds));

    await Promise.all(
      rows.map(async (note) => {
        try {
          const transcriptions = await window.api.transcription.listByNote(note.id);
          if (transcriptions && transcriptions.length > 0) {
            notesWithTrans.add(note.id);
          }
        } catch (err) {
          console.error('Failed to check transcriptions for note', note.id, err);
        }
      })
    );

    setNotesWithTranscriptions(notesWithTrans);
  }, [propsBinderId, routeBinderId, view, tagIdFilter]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    const handler = () => {
      refresh();
    };
    window.addEventListener('notes:changed', handler as EventListener);
    return () => window.removeEventListener('notes:changed', handler as EventListener);
  }, [refresh]);

  // Handle scroll events for auto-hide scrollbar
  React.useEffect(() => {
    const rootElement = rootRef.current;
    if (!rootElement) return;

    const handleScroll = () => {
      setIsScrolling(true);

      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }

      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false);
      }, 1000);
    };

    rootElement.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      rootElement.removeEventListener('scroll', handleScroll);
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  const listRootClass = `${styles.root} ${isScrolling ? styles.scrolling : ''}`;

  const navigateToNote = React.useCallback(
    (noteIdValue: string) => {
      if (view) {
        navigate(`/notes/${noteIdValue}${quickViewSearch}`);
      } else if (routeBinderId) {
        navigate(`/binders/${routeBinderId}/notes/${noteIdValue}`);
      } else {
        navigate(`/notes/${noteIdValue}`);
      }
    },
    [navigate, quickViewSearch, routeBinderId, view]
  );

  // Export handler for note context menu
  const handleExportNote = React.useCallback(
    async (exportNoteId: string, format: 'txt' | 'md' | 'docx' | 'rtf' | 'pdf') => {
      try {
        const result = await window.api.export.note(exportNoteId, format);
        if (result.success) {
          toast.success(t('export.success'));
        } else if (result.error !== 'Export cancelled') {
          reportError(result.error, 'E5001', { noteId: exportNoteId, format });
        }
      } catch (error) {
        reportError(error, 'E5001', { noteId: exportNoteId, format });
      }
    },
    [t]
  );

  return (
    <div ref={rootRef} className={listRootClass}>
      <ul className={styles.list}>
        {notes.map((n) => (
          <li
            key={n.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/notely-note-id', n.id);
              e.dataTransfer.effectAllowed = 'move';
              // Create a minimal drag image
              const dragImage = document.createElement('div');
              dragImage.textContent = n.title || 'Note';
              dragImage.style.cssText =
                'position: absolute; top: -1000px; padding: 8px 12px; background: var(--bg-container, #333); color: var(--text-primary, #fff); border-radius: 6px; font-size: 13px; font-weight: 500; white-space: nowrap; pointer-events: none;';
              document.body.appendChild(dragImage);
              e.dataTransfer.setDragImage(dragImage, 0, 0);
              // Clean up the element after drag starts
              requestAnimationFrame(() => {
                document.body.removeChild(dragImage);
              });
            }}
          >
            <Menu
              open={menuState.id === n.id}
              onOpenChange={(_, d) => {
                if (!d.open) setMenuState({ id: null, target: null });
              }}
              positioning={{
                position: 'below',
                align: 'start',
                target: menuState.target,
                offset: 0,
              }}
            >
              <MenuTrigger disableButtonEnhancement>
                <Link
                  to={
                    view
                      ? { pathname: `/notes/${n.id}`, search: quickViewSearch }
                      : routeBinderId
                        ? `/binders/${routeBinderId}/notes/${n.id}`
                        : `/notes/${n.id}`
                  }
                  className={`${styles.item} ${noteId === n.id ? styles['item-active'] : ''}`}
                  onClick={() => {
                    // Dispatch event to close transcription panel when note is selected
                    window.dispatchEvent(
                      new CustomEvent('sidebar:navigate', {
                        detail: { type: 'note', noteId: n.id },
                      })
                    );
                    // Close navigation panel if not pinned
                    onToggleCollapse?.();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenuState({ id: n.id, target: createVirtualElement(e.clientX, e.clientY) });
                  }}
                >
                  <div className={styles['item-content']}>
                    <div className={styles['item-header']}>
                      <div className={styles['item-title']}>
                        {currentNoteId === n.id && currentEditorTitle !== undefined
                          ? currentEditorTitle || t('notes.untitled')
                          : n.title || t('notes.untitled')}
                      </div>
                      <button
                        className={styles['star-button']}
                        onClick={async (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          try {
                            await window.api.storage.setStarred(n.id, !n.starred);
                            await refresh();
                          } catch (error) {
                            reportError(error, 'E4011', { noteId: n.id });
                          }
                        }}
                        title={n.starred ? t('notes.unstar') : t('notes.star')}
                      >
                        {n.starred ? <Star16Filled /> : <Star16Regular />}
                      </button>
                    </div>
                    <div className={styles['time-row']}>
                      <span className={styles.time}>{new Date(n.updated_at).toLocaleString()}</span>
                      <div className={styles['indicators-row']}>
                        {/* Conflict indicator - shows when note has conflict copies */}
                        {notesWithConflicts.has(n.id) && (
                          <div
                            className={styles['conflict-indicator']}
                            title={t('notes.hasConflicts')}
                          >
                            <Warning16Filled />
                          </div>
                        )}
                        {notesWithTranscriptions.has(n.id) && (
                          <div
                            className={styles['transcription-indicator']}
                            title={t('notes.hasTranscriptions')}
                          >
                            <Mic16Filled />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </Link>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem
                    onClick={(e) => {
                      e.preventDefault();
                      navigateToNote(n.id);
                    }}
                  >
                    {t('common.open')}
                  </MenuItem>
                  {view !== 'trash' && view !== 'archived' && (
                    <MenuItem
                      onClick={async (e) => {
                        e.preventDefault();
                        try {
                          await window.api.storage.setArchived(n.id, true);
                          await refresh();
                          if (noteId === n.id) {
                            if (view) {
                              const fallback =
                                quickViewSearch.length > 0 ? `/${quickViewSearch}` : '/';
                              navigate(fallback);
                            } else if (routeBinderId) {
                              navigate(`/binders/${routeBinderId}`);
                            } else {
                              navigate('/');
                            }
                          }
                          window.dispatchEvent(new Event('notes:changed'));
                        } catch (error) {
                          reportError(error, 'E4009', { noteId: n.id });
                        }
                      }}
                    >
                      {t('common.archive')}
                    </MenuItem>
                  )}
                  {view === 'archived' && (
                    <MenuItem
                      onClick={async (e) => {
                        e.preventDefault();
                        try {
                          await window.api.storage.setArchived(n.id, false);
                          await refresh();
                          window.dispatchEvent(new Event('notes:changed'));
                        } catch (error) {
                          reportError(error, 'E4010', { noteId: n.id });
                        }
                      }}
                    >
                      {t('common.unarchive')}
                    </MenuItem>
                  )}
                  {view !== 'trash' && (
                    <MenuItem
                      onClick={async (e) => {
                        e.preventDefault();
                        try {
                          await window.api.storage.deleteNote(n.id);
                          await refresh();
                          if (noteId === n.id) {
                            if (view) {
                              const fallback =
                                quickViewSearch.length > 0 ? `/${quickViewSearch}` : '/';
                              navigate(fallback);
                            } else if (routeBinderId) {
                              navigate(`/binders/${routeBinderId}`);
                            } else {
                              navigate('/');
                            }
                          }
                          window.dispatchEvent(new Event('notes:changed'));
                        } catch (error) {
                          reportError(error, 'E4006', { noteId: n.id });
                        }
                      }}
                    >
                      {t('common.delete')}
                    </MenuItem>
                  )}
                  {view !== 'trash' && (
                    <Menu>
                      <MenuTrigger disableButtonEnhancement>
                        <MenuItem>{t('notes.export')}</MenuItem>
                      </MenuTrigger>
                      <MenuPopover>
                        <MenuList>
                          <MenuItem
                            onClick={async (e) => {
                              e.preventDefault();
                              await handleExportNote(n.id, 'txt');
                              setMenuState({ id: null, target: null });
                            }}
                          >
                            {t('export.txt')}
                          </MenuItem>
                          <MenuItem
                            onClick={async (e) => {
                              e.preventDefault();
                              await handleExportNote(n.id, 'md');
                              setMenuState({ id: null, target: null });
                            }}
                          >
                            {t('export.md')}
                          </MenuItem>
                          <MenuItem
                            onClick={async (e) => {
                              e.preventDefault();
                              await handleExportNote(n.id, 'docx');
                              setMenuState({ id: null, target: null });
                            }}
                          >
                            {t('export.docx')}
                          </MenuItem>
                          <MenuItem
                            onClick={async (e) => {
                              e.preventDefault();
                              await handleExportNote(n.id, 'rtf');
                              setMenuState({ id: null, target: null });
                            }}
                          >
                            {t('export.rtf')}
                          </MenuItem>
                          <MenuItem
                            onClick={async (e) => {
                              e.preventDefault();
                              await handleExportNote(n.id, 'pdf');
                              setMenuState({ id: null, target: null });
                            }}
                          >
                            {t('export.pdf')}
                          </MenuItem>
                        </MenuList>
                      </MenuPopover>
                    </Menu>
                  )}
                </MenuList>
              </MenuPopover>
            </Menu>
          </li>
        ))}
      </ul>
    </div>
  );
};
