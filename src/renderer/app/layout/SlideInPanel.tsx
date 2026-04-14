import { Tooltip } from '@fluentui/react-components';
import { Pin, X } from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import styles from './SlideInPanel.module.css';

interface SlideInPanelProps {
  isOpen: boolean;
  position: 'left' | 'right';
  width?: number | string;
  children: React.ReactNode;
  onClose?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  pinPosition?: 'left' | 'right';
  headerless?: boolean;
  title?: string;
  titleContent?: React.ReactNode;
}

export const SlideInPanel: React.FC<SlideInPanelProps> = ({
  isOpen,
  position,
  width = 280,
  children,
  onClose,
  isPinned = false,
  onTogglePin,
  pinPosition = 'right',
  headerless = false,
  title,
  titleContent,
}) => {
  const { t } = useTranslation();
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Handle click outside to close (only when not pinned)
  React.useEffect(() => {
    if (!isOpen || !onClose || isPinned) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        const target = event.target as HTMLElement;
        // Don't close if clicking on the bottom bar toggle buttons
        if (target.closest('[data-panel-toggle]')) return;
        // Don't close if clicking inside another slide-in panel
        if (target.closest('[data-slide-panel]')) return;
        // Don't close if clicking inside a dialog (e.g., LoadModelModal)
        if (target.closest('[role="dialog"]')) return;
        onClose();
      }
    };

    // Add listener with a small delay to avoid closing immediately on open
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, onClose, isPinned]);

  // Handle escape key to close (only when not pinned)
  React.useEffect(() => {
    if (!isOpen || !onClose || isPinned) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose, isPinned]);

  const widthValue = typeof width === 'number' ? `${width}px` : width;

  const showHeader = !headerless && (title || titleContent || onTogglePin || onClose);

  const pinButton = onTogglePin ? (
    <Tooltip
      content={isPinned ? t('common.unpin', 'Unpin') : t('common.pin', 'Pin')}
      relationship="label"
    >
      <button
        type="button"
        className={`${styles.headerButton} ${isPinned ? styles.pinActive : ''}`}
        onClick={onTogglePin}
        aria-label={isPinned ? t('common.unpin', 'Unpin') : t('common.pin', 'Pin')}
        aria-pressed={isPinned}
      >
        <Pin size={16} strokeWidth={1.6} />
      </button>
    </Tooltip>
  ) : null;

  return (
    <div
      ref={panelRef}
      data-slide-panel
      className={`${styles.panel} ${styles[position]} ${isOpen ? styles.open : styles.closed} ${isPinned ? styles.pinned : ''}`}
      style={{ width: widthValue }}
      aria-hidden={!isOpen}
    >
      {showHeader && (
        <div className={styles.header}>
          {pinPosition === 'left' && pinButton}
          {titleContent ? (
            <div className={styles.titleContent}>{titleContent}</div>
          ) : (
            title && <h2 className={styles.title}>{title}</h2>
          )}
          <div className={styles.headerActions}>
            {pinPosition === 'right' && pinButton}
            {onClose && (
              <Tooltip content={t('common.close')} relationship="label">
                <button
                  type="button"
                  className={styles.headerButton}
                  onClick={onClose}
                  aria-label={t('common.close')}
                >
                  <X size={16} strokeWidth={1.6} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      )}
      <div className={styles.content}>
        {headerless && pinButton && <div className={styles.floatingPin}>{pinButton}</div>}
        {children}
      </div>
    </div>
  );
};
