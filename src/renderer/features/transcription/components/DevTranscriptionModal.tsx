import * as React from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';

import { reportError } from '@shared/error';

import styles from './DevTranscriptionModal.module.css';

type Props = {
  binderId: string;
  noteId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
};

export const DevTranscriptionModal: React.FC<Props> = ({
  binderId,
  noteId,
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [text, setText] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  // Focus textarea when modal opens
  React.useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  // Reset text when modal closes
  React.useEffect(() => {
    if (!isOpen) {
      setText('');
    }
  }, [isOpen]);

  const handleSave = async () => {
    if (!text.trim()) {
      toast.error('Please paste some text first');
      return;
    }

    setIsSaving(true);
    try {
      const result = await window.api.transcription.createDevSession({
        binderId,
        noteId,
        text: text.trim(),
      });

      if (result.success) {
        onSuccess?.();
        onClose();
      } else {
        reportError(result.error || 'Failed to create transcription', 'E3008', {
          noteId,
          binderId,
        });
      }
    } catch (error) {
      console.error('Failed to create dev transcription:', error);
      reportError(error, 'E3008', { noteId, binderId });
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Allow Escape to close
    if (e.key === 'Escape' && !isSaving) {
      onClose();
    }
    // Cmd/Ctrl+Enter to save
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isSaving) {
      handleSave();
    }
  };

  if (!isOpen) return null;

  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return createPortal(
    <div
      className={styles.backdrop}
      onClick={(e) => {
        // Only close if clicking the backdrop itself, not its children
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.header}>
          <h2 className={styles.title}>Dev: Add Test Transcription</h2>
          <button
            className={styles.closeButton}
            onClick={onClose}
            disabled={isSaving}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.instructions}>
            Paste transcription text below. This will create a completed transcription session for
            testing purposes.
          </div>

          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste your transcription text here..."
            disabled={isSaving}
            spellCheck={false}
          />

          <div className={styles.stats}>
            <span>{charCount.toLocaleString()} characters</span>
            <span className={styles.separator}>•</span>
            <span>{wordCount.toLocaleString()} words</span>
            {charCount > 16000 && (
              <>
                <span className={styles.separator}>•</span>
                <span className={styles.chunkingNote}>
                  Will use chunking pipeline ({'>'} 16k chars)
                </span>
              </>
            )}
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.cancelButton} onClick={onClose} disabled={isSaving}>
            Cancel
          </button>
          <button
            className={styles.saveButton}
            onClick={handleSave}
            disabled={isSaving || !text.trim()}
          >
            {isSaving ? 'Saving...' : 'Save Transcription'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
