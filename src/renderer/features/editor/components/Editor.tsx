import { Button } from '@fluentui/react-components';
import { Warning24Regular } from '@fluentui/react-icons';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import LexicalErrorBoundary from '@lexical/react/LexicalErrorBoundary';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { $getRoot, EditorState } from 'lexical';
import debounce from 'lodash.debounce';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { reportError } from '@shared/error';

import { useTranscriptionStore } from '../../transcription/model/transcription.store';
import { ToolbarPlugin } from '../plugins/ToolbarPlugin';

import { ConflictResolutionPanel } from './ConflictResolutionPanel';
import styles from './Editor.module.css';

type Props = {
  binderId: string;
  noteId?: string;
  initialJSON?: string;
  initialTitle?: string;
  onTitleChange?: (title: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Called when a draft note becomes a real note (ID is assigned) */
  onNoteIdChange?: (noteId: string) => void;
};

export const Editor: React.FC<Props> = ({
  binderId,
  noteId,
  initialJSON,
  initialTitle,
  onTitleChange,
  onDirtyChange,
  onNoteIdChange,
}) => {
  const { t } = useTranslation();
  const [title, setTitle] = React.useState(initialTitle || '');

  const [currentNoteId, setCurrentNoteId] = React.useState<string | undefined>(noteId);
  const noteIdRef = React.useRef<string | undefined>(noteId);
  const creatingRef = React.useRef(false);
  const latestChangeIdRef = React.useRef(0);
  // Conflict state (Phase 5)
  const [hasConflicts, setHasConflicts] = React.useState(false);
  const [conflictCount, setConflictCount] = React.useState(0);
  const [showConflictPanel, setShowConflictPanel] = React.useState(false);

  const initialConfig = React.useMemo(
    () => ({
      namespace: 'NoteEditor:' + (noteId || 'draft:' + binderId),
      editorState: initialJSON && initialJSON !== 'null' ? initialJSON : undefined,
      onError(err: Error) {
        console.error(err);
      },
      theme: { paragraph: 'editor-paragraph' },
    }),
    [noteId, initialJSON, binderId]
  );

  // Keep local refs/state in sync when the selected note changes via routing
  React.useEffect(() => {
    // When switching notes, refresh the note list to show updated titles from database
    const prevNoteId = noteIdRef.current;
    if (prevNoteId && prevNoteId !== noteId) {
      window.dispatchEvent(new Event('notes:changed'));
    }

    noteIdRef.current = noteId;
    setCurrentNoteId(noteId);
    setTitle(initialTitle || '');
    onDirtyChange?.(false);
  }, [noteId, initialTitle, onDirtyChange]);

  // Load transcriptions for the current note when noteId changes
  React.useEffect(() => {
    const store = useTranscriptionStore.getState();
    if (!currentNoteId) {
      store.clearHistoricalView();
      return;
    }
    // Only load historical transcriptions if not currently recording
    if (!store.isRecording) {
      store.loadTranscriptionsForNote(currentNoteId);
    }
  }, [currentNoteId]);

  // Check for conflicts when note changes (Phase 5)
  React.useEffect(() => {
    if (!currentNoteId) {
      setHasConflicts(false);
      setConflictCount(0);
      setShowConflictPanel(false);
      return;
    }

    const checkConflicts = async () => {
      try {
        const conflicts = await window.api.storage.getConflictsForNote(currentNoteId);
        setHasConflicts(conflicts.length > 0);
        setConflictCount(conflicts.length);
      } catch {
        setHasConflicts(false);
        setConflictCount(0);
      }
    };

    checkConflicts();
  }, [currentNoteId]);

  // Handle conflict resolution callback
  const handleConflictResolved = React.useCallback(() => {
    setShowConflictPanel(false);
    // Reload conflict state
    if (currentNoteId) {
      window.api.storage
        .getConflictsForNote(currentNoteId)
        .then((conflicts) => {
          setHasConflicts(conflicts.length > 0);
          setConflictCount(conflicts.length);
        })
        .catch(() => {
          setHasConflicts(false);
          setConflictCount(0);
        });
    }
  }, [currentNoteId]);

  const debouncedSave = React.useMemo(
    () =>
      debounce(async (targetNoteId: string, state: EditorState, titleVal: string) => {
        const changeId = latestChangeIdRef.current;
        let plain = '';
        state.read(() => {
          plain = $getRoot().getTextContent();
        });
        const json = JSON.stringify(state.toJSON());
        try {
          await window.api.storage.saveNote({
            noteId: targetNoteId,
            lexicalJson: json,
            plainText: plain,
            title: titleVal,
          });
          if (changeId === latestChangeIdRef.current) {
            onDirtyChange?.(false);
          }
        } catch (error) {
          reportError(error, 'E4001', { noteId });
        }
      }, 400),
    [onDirtyChange]
  );

  const createIfNeeded = React.useCallback(
    async (hasContent: boolean) => {
      if (noteIdRef.current || creatingRef.current) return noteIdRef.current;
      if (!hasContent) return undefined;
      try {
        creatingRef.current = true;
        const newId = await window.api.storage.createNote(binderId);
        noteIdRef.current = newId;
        setCurrentNoteId(newId);

        // Notify parent that this draft now has a real note ID.
        // The parent (WorkspacePage) handles navigation and note list refresh
        // so the Editor is not unmounted/remounted during the transition.
        onNoteIdChange?.(newId);

        return newId;
      } catch (error) {
        reportError(error, 'E4005', { binderId });
        return undefined;
      } finally {
        creatingRef.current = false;
      }
    },
    [binderId, onNoteIdChange]
  );

  // If showing conflict panel, render it instead of editor
  if (showConflictPanel && currentNoteId) {
    return (
      <div className={styles.wrapper}>
        <div className={styles.editorColumn}>
          <ConflictResolutionPanel noteId={currentNoteId} onResolved={handleConflictResolved} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.editorColumn}>
        <div className={styles.editorContent}>
          {/* Conflict Banner (Phase 5) */}
          {hasConflicts && currentNoteId && (
            <div className={styles.conflictBanner}>
              <div className={styles.conflictBannerContent}>
                <Warning24Regular className={styles.conflictIcon} />
                <span className={styles.conflictText}>
                  {t('conflicts.bannerText', { count: conflictCount })}
                </span>
              </div>
              <Button appearance="primary" size="small" onClick={() => setShowConflictPanel(true)}>
                {t('conflicts.resolve')}
              </Button>
            </div>
          )}
          <div className={styles.header}>
            <input
              className={styles.title}
              value={title}
              onChange={async (e) => {
                const next = e.target.value;
                latestChangeIdRef.current += 1;
                onDirtyChange?.(true);
                setTitle(next);
                onTitleChange?.(next);
                // If typing a title and no note exists, create one.
                if (!noteIdRef.current && next.trim().length > 0) {
                  const createdId = await createIfNeeded(true);
                  if (createdId) {
                    try {
                      await window.api.storage.saveNote({
                        noteId: createdId,
                        lexicalJson: 'null',
                        plainText: '',
                        title: next,
                      });
                    } catch (error) {
                      reportError(error, 'E4007', { noteId: createdId });
                    }
                  }
                }
              }}
              onBlur={async () => {
                const changeId = ++latestChangeIdRef.current;
                const currentId = noteIdRef.current;
                if (currentId) {
                  try {
                    // Save title only (lexicalJson: 'null' signals title-only update)
                    await window.api.storage.saveNote({
                      noteId: currentId,
                      lexicalJson: 'null',
                      plainText: '',
                      title,
                    });
                    if (changeId === latestChangeIdRef.current) {
                      onDirtyChange?.(false);
                    }
                    // Refresh note list to show updated title
                    window.dispatchEvent(new Event('notes:changed'));
                  } catch (error) {
                    reportError(error, 'E4007', { noteId: currentId });
                  }
                } else {
                  onDirtyChange?.(false);
                }
              }}
              placeholder={t('notes.untitled')}
            />
          </div>
          <div className={styles.container}>
            {/* Key the composer so it fully remounts when switching notes or binders */}
            <LexicalComposer key={noteId || 'draft:' + binderId} initialConfig={initialConfig}>
              <div className={styles.editorSurface}>
                <ToolbarPlugin />
                <RichTextPlugin
                  contentEditable={<ContentEditable className={styles.input} />}
                  placeholder={<span />}
                  ErrorBoundary={LexicalErrorBoundary}
                />
                <HistoryPlugin />
                <OnChangePlugin
                  ignoreSelectionChange={true}
                  onChange={async (editorState) => {
                    let plain = '';
                    editorState.read(() => {
                      plain = $getRoot().getTextContent();
                    });
                    const hasContent = plain.trim().length > 0 || title.trim().length > 0;
                    if (!noteIdRef.current && !hasContent) {
                      // Nothing to persist yet and no note created
                      return;
                    }

                    const changeId = ++latestChangeIdRef.current;
                    onDirtyChange?.(true);

                    // If there is no note yet, only create when there is content.
                    let idToUse = noteIdRef.current;
                    if (!idToUse) {
                      idToUse = await createIfNeeded(hasContent);
                      if (idToUse && hasContent) {
                        // Save immediately on first creation to not lose content.
                        try {
                          const json = JSON.stringify(editorState.toJSON());
                          await window.api.storage.saveNote({
                            noteId: idToUse,
                            lexicalJson: json,
                            plainText: plain,
                            title,
                          });
                          if (changeId === latestChangeIdRef.current) {
                            onDirtyChange?.(false);
                          }
                        } catch (error) {
                          reportError(error, 'E4001', { noteId: idToUse });
                        }
                      }
                      return;
                    }
                    debouncedSave(idToUse, editorState, title);
                  }}
                />
              </div>
            </LexicalComposer>
          </div>
        </div>
      </div>
    </div>
  );
};
