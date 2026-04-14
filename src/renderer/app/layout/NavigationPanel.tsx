import { ArrowLeft } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Sidebar as BindersSidebar } from '../../features/binders/components/BinderList';
import { useBindersStore } from '../../features/binders/model/binders.store';
import { NoteList } from '../../features/notes/components/NoteList';
import { TagList } from '../../features/tags';
import type { QuickViewKey } from '../types/quickViews';

import styles from './NavigationPanel.module.css';
import { QuickViewsList } from './QuickViewsList';

export type NavigationTab = 'binders' | 'tags';

interface NavigationPanelProps {
  activeTab: NavigationTab;
  onTabChange?: (tab: NavigationTab) => void;
  onNavigate?: () => void;
}

const QUICK_VIEW_TITLES: Record<QuickViewKey, string> = {
  all: 'sidebar.allNotes',
  today: 'sidebar.today',
  starred: 'sidebar.starred',
  archived: 'sidebar.archived',
  trash: 'sidebar.trash',
};

export const NavigationPanel: React.FC<NavigationPanelProps> = ({
  activeTab,
  onTabChange: _onTabChange,
  onNavigate,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { binderId } = useParams();
  const [searchParams] = useSearchParams();
  const binders = useBindersStore((state) => state.binders);

  // Get current quick view from URL params
  const quickView = searchParams.get('view') as QuickViewKey | null;

  // Determine if we should show notes list (binder selected or quick view selected)
  const showingNotes = Boolean(binderId || quickView);

  // Track drag state for visual feedback
  const [isDraggingOverBack, setIsDraggingOverBack] = React.useState(false);

  // Get binder name from store
  const binderName = React.useMemo(() => {
    if (!binderId) return null;
    const binder = binders.find((b) => b.id === binderId);
    return binder?.name ?? null;
  }, [binderId, binders]);

  // Handle back button - navigate to root to clear binder/view selection
  const handleBack = React.useCallback(() => {
    navigate('/');
  }, [navigate]);

  // Handle drag over back button - switch to binders view to allow drop
  const handleBackDragOver = React.useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/notely-note-id')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setIsDraggingOverBack(true);
    }
  }, []);

  const handleBackDragEnter = React.useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes('text/notely-note-id')) {
        e.preventDefault();
        setIsDraggingOverBack(true);
        // Navigate back to binders view so user can drop on a binder
        navigate('/');
      }
    },
    [navigate]
  );

  const handleBackDragLeave = React.useCallback(() => {
    setIsDraggingOverBack(false);
  }, []);

  // Get the header title for notes view
  const getNotesTitle = React.useCallback(() => {
    if (binderId && binderName) {
      return binderName;
    }
    if (quickView && QUICK_VIEW_TITLES[quickView]) {
      return t(QUICK_VIEW_TITLES[quickView]);
    }
    return t('sidebar.notes');
  }, [binderId, binderName, quickView, t]);

  React.useEffect(() => {
    console.info('[NavigationPanel] Focus mode panel loaded');
  }, []);

  return (
    <div className={styles.panel}>
      {showingNotes ? (
        // Notes list view with back button
        <div className={styles.notesView}>
          <div className={styles.notesHeader}>
            <button
              onClick={handleBack}
              onDragOver={handleBackDragOver}
              onDragEnter={handleBackDragEnter}
              onDragLeave={handleBackDragLeave}
              className={`${styles.backButton} ${isDraggingOverBack ? styles.dragOver : ''}`}
              type="button"
              aria-label={t('common.back')}
            >
              <ArrowLeft size={15} strokeWidth={1.8} />
            </button>
            <h3 className={styles.notesTitle}>{getNotesTitle()}</h3>
          </div>
          <div className={styles.notesListContainer}>
            <NoteList
              key={`${binderId ?? ''}-${quickView ?? 'default'}`}
              binderId={binderId}
              view={quickView ?? undefined}
            />
          </div>
        </div>
      ) : (
        // Default binders/tags view
        <div className={styles.content}>
          {/* Quick Views - always visible */}
          <div className={styles.quickViewsSection}>
            <QuickViewsList onNavigate={onNavigate} />
          </div>

          <div className={styles.divider} />

          {activeTab === 'binders' && (
            <div className={styles.section}>
              <BindersSidebar compactHeader={false} />
            </div>
          )}
          {activeTab === 'tags' && (
            <div className={styles.section}>
              <TagList />
            </div>
          )}
        </div>
      )}
    </div>
  );
};
