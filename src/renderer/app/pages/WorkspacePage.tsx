import * as React from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { Editor } from '../../features/editor/components/Editor';
import type { QuickViewKey } from '../types/quickViews';

import styles from './WorkspacePage.module.css';

// System binder ID (matches backend UUIDv5 generation)
// Generated from namespace "notely.system.unassigned.binder"
const UNASSIGNED_BINDER_ID = 'ab6eb598-eeee-4d13-8dde-3eb2b496e91e';
const ALL_VIEWS: QuickViewKey[] = ['all', 'today', 'starred', 'archived', 'trash'];

export default function WorkspacePage() {
  const { binderId, noteId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [note, setNote] = React.useState<{
    meta: {
      id: string;
      binderId: string;
      title: string;
      createdAt: Date;
      updatedAt: Date;
      deleted: boolean;
      pinned: boolean;
    };
    content: { lexicalJson: string; plainText: string };
  } | null>(null);
  const [currentEditorTitle, setCurrentEditorTitle] = React.useState<string>('');
  const isEditorDirtyRef = React.useRef(false);
  const suppressReloadUntilRef = React.useRef<number>(0);

  const selectedView = React.useMemo<QuickViewKey>(() => {
    const search = new URLSearchParams(location.search);
    const candidate = search.get('view') as QuickViewKey | null;
    return candidate && ALL_VIEWS.includes(candidate) ? candidate : 'all';
  }, [location.search]);
  const isQuickView = !binderId;

  React.useEffect(() => {
    let cancelled = false;

    if (!noteId) {
      setNote(null);
      setCurrentEditorTitle('');
      return () => {
        cancelled = true;
      };
    }

    const targetNoteId = noteId;

    const loadNote = async () => {
      try {
        const data = await window.api.storage.getNote(targetNoteId);
        if (cancelled) return;
        setNote(data);
        setCurrentEditorTitle(data.meta.title || '');
        // Suppress notes:changed reloads for 2 seconds after initial load
        // to avoid IPC echo from createNote/saveNote causing a remount
        suppressReloadUntilRef.current = Date.now() + 2000;
      } catch (error) {
        if (cancelled) return;
        console.error('Failed to load note:', targetNoteId, error);
        setNote(null);
      }
    };

    loadNote();

    return () => {
      cancelled = true;
    };
  }, [binderId, noteId]);

  // Reset dirty flag when switching notes
  React.useEffect(() => {
    isEditorDirtyRef.current = false;
  }, [noteId]);

  // Refresh current note when sync pulls new data from the server
  React.useEffect(() => {
    if (!noteId) return;

    const handler = async () => {
      // Don't clobber in-progress edits
      if (isEditorDirtyRef.current) return;
      // Suppress IPC echo from createNote/saveNote shortly after loading
      if (Date.now() < suppressReloadUntilRef.current) return;
      try {
        const data = await window.api.storage.getNote(noteId);
        setNote(data);
      } catch (error) {
        console.error('Failed to reload note after sync:', noteId, error);
      }
    };

    window.addEventListener('notes:changed', handler);
    return () => window.removeEventListener('notes:changed', handler);
  }, [noteId]);

  // Persist last opened binder id for initial navigation on next app launch
  React.useEffect(() => {
    if (binderId) {
      try {
        window.api.settings.set('ui.lastBinderId', binderId);
      } catch (error) {
        console.warn('Failed to persist last binder ID:', error);
      }
    }
  }, [binderId]);

  const handleEditorTitleChange = React.useCallback((newTitle: string) => {
    setCurrentEditorTitle(newTitle);
  }, []);

  const handleEditorDirtyChange = React.useCallback((dirty: boolean) => {
    isEditorDirtyRef.current = dirty;
  }, []);

  // Track the note ID assigned during draft→saved transition so the Editor
  // key stays stable (no remount) while we navigate to the new URL.
  const draftNoteIdRef = React.useRef<string | null>(null);
  // Capture the draftKey at promotion time so the Editor key is truly stable
  // across the navigate() call (isQuickView / binderId may change in the URL).
  const promotedDraftKeyRef = React.useRef<string | null>(null);

  const editorBinderId = note?.meta.binderId || binderId || UNASSIGNED_BINDER_ID;

  const handleNoteIdChange = React.useCallback(
    (newNoteId: string) => {
      draftNoteIdRef.current = newNoteId;
      // Snapshot the current draftKey BEFORE navigate() changes the URL params.
      // isQuickView and editorBinderId may shift after navigation, which would
      // alter the computed draftKey and cause React to remount the Editor.
      const currentBinderId = note?.meta.binderId || binderId || UNASSIGNED_BINDER_ID;
      const qv = !binderId;
      promotedDraftKeyRef.current = `draft-${currentBinderId}-${qv ? selectedView : 'binder'}`;
      // Notify NoteList that a new note was created
      window.dispatchEvent(new Event('notes:changed'));
      // Update the URL so transcription recording and deep-links work.
      // replace: true avoids a back-button entry for the draft URL.
      const targetBinder = binderId || UNASSIGNED_BINDER_ID;
      navigate(`/binders/${targetBinder}/notes/${newNoteId}`, { replace: true });
    },
    [binderId, navigate, note?.meta.binderId, selectedView]
  );

  // Determine editor to render:
  // - No noteId: show draft editor
  // - noteId matches a draft that was just promoted: keep the same Editor instance
  // - noteId but note not loaded yet (or stale): show nothing (loading)
  // - noteId and correct note loaded: show note editor
  // IMPORTANT: Check note.meta.id === noteId to avoid showing stale note data
  // when switching between notes (note state might still have old note's data)
  const isCorrectNoteLoaded = note && note.meta.id === noteId;
  const isDraftPromotion = noteId && noteId === draftNoteIdRef.current;

  // Clear draft promotion refs when navigating to a different note
  if (noteId && noteId !== draftNoteIdRef.current) {
    draftNoteIdRef.current = null;
    promotedDraftKeyRef.current = null;
  }

  const draftKey = `draft-${editorBinderId}-${isQuickView ? selectedView : 'binder'}`;

  const editor = !noteId ? (
    <Editor
      key={draftKey}
      binderId={editorBinderId}
      onNoteIdChange={handleNoteIdChange}
      onTitleChange={handleEditorTitleChange}
      onDirtyChange={handleEditorDirtyChange}
    />
  ) : isDraftPromotion ? (
    // Draft was just promoted to a saved note — use the key snapshotted
    // BEFORE navigate() so it matches the previous render exactly.
    // Without this, isQuickView flips when binderId appears in the URL,
    // changing the computed draftKey and causing an unwanted remount.
    <Editor
      key={promotedDraftKeyRef.current || draftKey}
      binderId={editorBinderId}
      onNoteIdChange={handleNoteIdChange}
      onTitleChange={handleEditorTitleChange}
      onDirtyChange={handleEditorDirtyChange}
    />
  ) : isCorrectNoteLoaded ? (
    <Editor
      key={`note-${note.meta.id}`}
      binderId={editorBinderId}
      noteId={note.meta.id}
      initialJSON={note.content.lexicalJson}
      initialTitle={note.meta.title}
      onTitleChange={handleEditorTitleChange}
      onDirtyChange={handleEditorDirtyChange}
    />
  ) : null; // Loading state - noteId exists but correct note not loaded yet

  return (
    <div className={styles.wrapper}>
      <div className={styles.editorArea}>{editor}</div>
    </div>
  );
}
