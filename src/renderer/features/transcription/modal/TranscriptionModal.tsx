import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import LexicalErrorBoundary from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useTranscriptionStore } from '../model/transcription.store';
import { TranscriptionViewerPlugin } from '../plugins/TranscriptionViewerPlugin';

import styles from './TranscriptionModal.module.css';

type Props = {
  isClosing: boolean;
  onClose: () => void;
  anchorEl?: HTMLElement | null;
  transcriptJSON?: string;
};

export const TranscriptionModal: React.FC<Props> = ({
  isClosing,
  onClose,
  anchorEl,
  transcriptJSON,
}) => {
  const { t } = useTranslation();
  const seekAudioTo = useTranscriptionStore((s) => s.seekAudioTo);
  const audioFilePath = useTranscriptionStore((s) => s.audioPlayer.filePath);
  const [isVisible, setIsVisible] = React.useState(false);
  const closeTimeoutRef = React.useRef<number | null>(null);
  const hasFiredCloseRef = React.useRef(false);
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null);
  const modalRef = React.useRef<HTMLDivElement | null>(null);
  const initialConfig = React.useMemo(
    () => ({
      namespace: 'TranscriptionViewer',
      editable: false,
      theme: { paragraph: 'editor-paragraph' },
      onError(err: Error) {
        console.error(err);
      },
      editorState: transcriptJSON && transcriptJSON !== 'null' ? transcriptJSON : undefined,
    }),
    [transcriptJSON]
  );

  React.useEffect(() => {
    // Find the content area and prevent scrolling while modal is open
    const contentElement = document.querySelector('[class*="content"]') as HTMLElement;
    if (contentElement) {
      contentElement.style.overflow = 'hidden';
    }

    // Start the entrance animation
    setIsVisible(true);

    return () => {
      if (contentElement) {
        contentElement.style.overflow = '';
      }
    };
  }, []);

  // Compute anchor position relative to viewport so the modal stays attached to the controls
  React.useLayoutEffect(() => {
    const updatePosition = () => {
      if (!anchorEl || !modalRef.current) {
        setPosition(null);
        return;
      }

      const rect = anchorEl.getBoundingClientRect();
      const modalHeight = modalRef.current.offsetHeight;
      const modalWidth = modalRef.current.offsetWidth;
      const margin = 16;
      const verticalOffset = 20;
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      const spaceAbove = rect.top - margin - verticalOffset;
      const spaceBelow = viewportHeight - rect.bottom - margin - verticalOffset;

      const canPlaceAbove = spaceAbove >= modalHeight;
      const canPlaceBelow = spaceBelow >= modalHeight;

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

      let top = placeAbove
        ? rect.top - modalHeight - margin - verticalOffset
        : rect.bottom + margin + verticalOffset;

      if (top < margin) {
        top = margin;
      }
      if (top + modalHeight > viewportHeight - margin) {
        top = Math.max(margin, viewportHeight - margin - modalHeight);
      }

      const desiredLeft = rect.left + rect.width / 2 - modalWidth / 2;
      const minLeft = margin;
      const maxLeft = Math.max(margin, viewportWidth - margin - modalWidth);
      const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

      setPosition({ left, top });
    };

    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    let resizeObserver: ResizeObserver | undefined;
    if (modalRef.current) {
      resizeObserver = new ResizeObserver(() => updatePosition());
      resizeObserver.observe(modalRef.current);
    }

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [anchorEl, transcriptJSON]);

  React.useEffect(() => {
    if (isClosing) {
      setIsVisible(false);
      hasFiredCloseRef.current = false;
      if (closeTimeoutRef.current !== null) {
        clearTimeout(closeTimeoutRef.current);
      }
      // Fallback in case transitionend doesn't fire
      closeTimeoutRef.current = window.setTimeout(() => {
        if (!hasFiredCloseRef.current) {
          closeTimeoutRef.current = null;
          onClose();
        }
      }, 400);
    }
  }, [isClosing, onClose]);

  React.useEffect(() => {
    return () => {
      if (closeTimeoutRef.current !== null) {
        clearTimeout(closeTimeoutRef.current);
        closeTimeoutRef.current = null;
      }
    };
  }, []);

  // Handle clicks on timestamp markers in the viewer
  const handleTimestampClick = React.useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const text = target.textContent || '';

      // Check if clicked on a timestamp marker [MM:SS]
      const timestampMatch = text.match(/^\[(\d+):(\d{2})\]/);
      if (timestampMatch) {
        const mins = parseInt(timestampMatch[1], 10);
        const secs = parseInt(timestampMatch[2], 10);
        const timeMs = (mins * 60 + secs) * 1000;

        if (audioFilePath) {
          seekAudioTo(timeMs);
        } else {
          toast.info('Recording not available for playback');
        }
      }
    },
    [audioFilePath, seekAudioTo]
  );

  const modalElement = (
    <div
      className={styles.overlay}
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      <div
        ref={modalRef}
        className={`${styles.modal} ${isVisible ? styles.visible : ''}`}
        onTransitionEnd={(e) => {
          if (
            !isVisible &&
            isClosing &&
            (e.propertyName === 'opacity' || e.propertyName === 'transform')
          ) {
            if (closeTimeoutRef.current !== null) {
              clearTimeout(closeTimeoutRef.current);
              closeTimeoutRef.current = null;
            }
            if (!hasFiredCloseRef.current) {
              hasFiredCloseRef.current = true;
              onClose();
            }
          }
        }}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{t('transcription.title')}</h2>
        </div>
        <div className={styles.content} onClick={handleTimestampClick}>
          <LexicalComposer initialConfig={initialConfig}>
            <RichTextPlugin
              contentEditable={<ContentEditable className={styles.readonly} />}
              placeholder={null}
              ErrorBoundary={LexicalErrorBoundary}
            />
            <TranscriptionViewerPlugin />
          </LexicalComposer>
        </div>
      </div>
    </div>
  );
  return createPortal(modalElement, document.body);
};
