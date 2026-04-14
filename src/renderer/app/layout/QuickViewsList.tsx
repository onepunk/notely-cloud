import { Archive, Calendar, Files, Star, Trash2, type LucideIcon } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import type { QuickViewKey } from '../types/quickViews';

import styles from './QuickViewsList.module.css';

interface QuickViewsListProps {
  onNavigate?: () => void;
}

interface QuickViewConfig {
  key: QuickViewKey;
  labelKey: string;
  icon: LucideIcon;
  droppable?: boolean; // Whether notes can be dropped here
}

const QUICK_VIEWS: QuickViewConfig[] = [
  { key: 'all', labelKey: 'sidebar.allNotes', icon: Files },
  { key: 'today', labelKey: 'sidebar.today', icon: Calendar },
  { key: 'starred', labelKey: 'sidebar.starred', icon: Star, droppable: true },
  { key: 'archived', labelKey: 'sidebar.archived', icon: Archive, droppable: true },
  { key: 'trash', labelKey: 'sidebar.trash', icon: Trash2, droppable: true },
];

export const QuickViewsList: React.FC<QuickViewsListProps> = ({ onNavigate }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const currentView = React.useMemo(() => {
    // Only show as active on root path or notes path
    if (location.pathname !== '/' && !location.pathname.startsWith('/notes/')) {
      return null;
    }
    const viewParam = searchParams.get('view');
    if (viewParam) {
      return viewParam as QuickViewKey;
    }
    // Root without view param - backwards compatibility, treat as 'all'
    return location.pathname === '/' ? 'all' : null;
  }, [location.pathname, searchParams]);

  const handleViewClick = React.useCallback(
    (viewKey: QuickViewKey) => {
      // Always include view param so NavigationPanel can detect the selection
      // Don't close panel here - let user browse notes list first
      navigate(`/?view=${viewKey}`);
    },
    [navigate]
  );

  const handleEmptyTrash = React.useCallback(async () => {
    try {
      const result = await window.api.storage.emptyTrash();
      if (result.removed > 0) {
        toast.success(t('sidebar.trashEmptied'));
        window.dispatchEvent(new Event('notes:changed'));
      } else {
        toast.info(t('sidebar.trashAlreadyEmpty'));
      }
    } catch (error) {
      console.error('Failed to empty trash:', error);
      toast.error(t('sidebar.trashEmptyFailed'));
    }
  }, [t]);

  // Track which view is being dragged over
  const [dragOverView, setDragOverView] = React.useState<QuickViewKey | null>(null);

  // Handle dropping a note on a quick view
  const handleNoteDrop = React.useCallback(async (noteId: string, viewKey: QuickViewKey) => {
    try {
      if (viewKey === 'starred') {
        await window.api.storage.setStarred(noteId, true);
      } else if (viewKey === 'archived') {
        await window.api.storage.setArchived(noteId, true);
      } else if (viewKey === 'trash') {
        await window.api.storage.deleteNote(noteId);
      }
      window.dispatchEvent(new Event('notes:changed'));
    } catch (error) {
      console.error('Failed to move note:', error);
    }
  }, []);

  return (
    <div className={styles.container}>
      <nav className={styles.list} role="navigation" aria-label="Quick views">
        {QUICK_VIEWS.map((view) => {
          const isActive = currentView === view.key;
          const isDragOver = dragOverView === view.key;
          const Icon = view.icon;

          return (
            <div key={view.key} className={styles.itemWrapper}>
              <button
                type="button"
                className={`${styles.item} ${isActive ? styles.active : ''} ${isDragOver ? styles.dragOver : ''}`}
                onClick={() => handleViewClick(view.key)}
                aria-current={isActive ? 'page' : undefined}
                onDragOver={
                  view.droppable
                    ? (e) => {
                        if (e.dataTransfer.types.includes('text/notely-note-id')) {
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'move';
                          setDragOverView(view.key);
                        }
                      }
                    : undefined
                }
                onDragEnter={
                  view.droppable
                    ? (e) => {
                        if (e.dataTransfer.types.includes('text/notely-note-id')) {
                          e.preventDefault();
                          e.stopPropagation();
                          setDragOverView(view.key);
                        }
                      }
                    : undefined
                }
                onDragLeave={
                  view.droppable
                    ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverView(null);
                      }
                    : undefined
                }
                onDrop={
                  view.droppable
                    ? async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setDragOverView(null);
                        const noteId = e.dataTransfer.getData('text/notely-note-id');
                        if (noteId) {
                          await handleNoteDrop(noteId, view.key);
                        }
                      }
                    : undefined
                }
              >
                <Icon size={16} strokeWidth={1.6} />
                <span className={styles.label}>{t(view.labelKey)}</span>
              </button>
              {view.key === 'trash' && isActive && (
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={handleEmptyTrash}
                  title={t('sidebar.emptyTrash')}
                  aria-label={t('sidebar.emptyTrash')}
                >
                  {t('sidebar.emptyTrash')}
                </button>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
};
