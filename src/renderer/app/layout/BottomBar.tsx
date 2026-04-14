import { Button, Tooltip } from '@fluentui/react-components';
import { Mic20Regular, Stop20Filled } from '@fluentui/react-icons';
import { Tag } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import styles from './BottomBar.module.css';

export type LeftPanelTab = 'binders' | 'tags';
export type RightPanelTab = 'transcription' | 'summary';

interface BottomBarProps {
  isRecording: boolean;
  onToggleRecording: () => Promise<void>;
  leftPanelOpen: boolean;
  onToggleLeftPanel: () => void;
  activeLeftTab: LeftPanelTab;
  onLeftTabChange: (tab: LeftPanelTab) => void;
}

export const BottomBar: React.FC<BottomBarProps> = ({
  isRecording,
  onToggleRecording,
  leftPanelOpen,
  onToggleLeftPanel,
  activeLeftTab,
  onLeftTabChange,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [isBusy, setIsBusy] = React.useState(false);

  // Check if we're viewing notes (binder selected or quick view selected)
  const isViewingNotes = React.useMemo(() => {
    const path = location.pathname;
    const searchParams = new URLSearchParams(location.search);
    return path.startsWith('/binders/') || searchParams.has('view');
  }, [location.pathname, location.search]);

  const handleRecordClick = React.useCallback(async () => {
    if (isBusy) return;
    setIsBusy(true);
    try {
      await onToggleRecording();
    } finally {
      setIsBusy(false);
    }
  }, [isBusy, onToggleRecording]);

  const handleLeftTabClick = React.useCallback(
    (tab: LeftPanelTab) => {
      if (leftPanelOpen && activeLeftTab === tab) {
        onToggleLeftPanel();
      } else {
        // If viewing notes and switching tabs, navigate back to show binders/tags view
        if (isViewingNotes && activeLeftTab !== tab) {
          navigate('/');
        }
        onLeftTabChange(tab);
        if (!leftPanelOpen) {
          onToggleLeftPanel();
        }
      }
    },
    [leftPanelOpen, activeLeftTab, onToggleLeftPanel, onLeftTabChange, isViewingNotes, navigate]
  );

  const primaryIcon = isRecording ? <Stop20Filled /> : <Mic20Regular />;
  const primaryLabel = isRecording ? t('transcription.stop') : t('transcription.record');

  return (
    <footer className={styles.footer}>
      <div className={styles.container}>
        {/* Left panel toggles */}
        <div className={styles.leftGroup}>
          <Tooltip content={t('sidebar.tags')} relationship="label">
            <button
              type="button"
              className={`${styles.toggleButton} ${leftPanelOpen && activeLeftTab === 'tags' ? styles.active : ''}`}
              onClick={() => handleLeftTabClick('tags')}
              data-panel-toggle="left"
              aria-label={t('sidebar.tags')}
            >
              <Tag size={18} strokeWidth={1.6} />
            </button>
          </Tooltip>
        </div>

        {/* Center recording button */}
        <div className={styles.centerGroup} data-panel-toggle="record">
          <Button
            appearance="primary"
            size="large"
            className={`${styles.recordButton} ${isRecording ? styles.recording : ''}`}
            onClick={handleRecordClick}
            disabled={isBusy}
            icon={primaryIcon}
            aria-label={primaryLabel}
          />
        </div>

        {/* Empty right group for layout balance */}
        <div className={styles.rightGroup} />
      </div>
    </footer>
  );
};
