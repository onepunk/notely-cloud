import * as React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { toast } from 'sonner';

import { reportError } from '@shared/error';

import { useSettingsStore } from '../state/settings.store';

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

interface UseNativeMenuOptions {
  noteId?: string;
  onOpenTranscriptions: () => void;
}

/**
 * Listens for native macOS menu events and dispatches the
 * corresponding renderer actions. No-op on non-darwin platforms.
 */
export function useNativeMenu({ noteId, onOpenTranscriptions }: UseNativeMenuOptions): void {
  const navigate = useNavigate();
  const location = useLocation();
  const setSetting = useSettingsStore((s) => s.setValue);
  const isMac = window.api?.platform === 'darwin';

  // Keep latest noteId in a ref so IPC callbacks always see the current value
  const noteIdRef = React.useRef(noteId);
  React.useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  // Keep latest onOpenTranscriptions in a ref
  const onOpenTranscriptionsRef = React.useRef(onOpenTranscriptions);
  React.useEffect(() => {
    onOpenTranscriptionsRef.current = onOpenTranscriptions;
  }, [onOpenTranscriptions]);

  // Keep location in a ref for new-note handler
  const locationRef = React.useRef(location);
  React.useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // Notify main process of current noteId so Export menu can be toggled
  React.useEffect(() => {
    if (!isMac) return;
    window.api.menu.updateState({ noteId: noteId ?? null });
  }, [noteId, isMac]);

  // Register all menu event listeners once
  React.useEffect(() => {
    if (!isMac) return;

    const cleanups: Array<() => void> = [];

    cleanups.push(
      window.api.menu.onNavigate((route: string) => {
        navigate(route);
      })
    );

    cleanups.push(
      window.api.menu.onOpenTranscriptions(() => {
        onOpenTranscriptionsRef.current();
      })
    );

    cleanups.push(
      window.api.menu.onExport(async (format: string) => {
        const id = noteIdRef.current;
        if (!id) return;
        try {
          const result = await window.api.export.note(
            id,
            format as 'txt' | 'md' | 'docx' | 'rtf' | 'pdf'
          );
          if (result.success) {
            toast.success('Export successful');
          } else if (result.error !== 'Export cancelled') {
            reportError(result.error, 'E5001', { noteId: id, format });
          }
        } catch (error) {
          reportError(error, 'E5001', { noteId: id, format });
        }
      })
    );

    cleanups.push(
      window.api.menu.onFontZoomIn(() => {
        const current = parseFloat(
          useSettingsStore.getState().values[CONTENT_FONT_SCALE_KEY] ?? '1'
        );
        const next = clampFontScale(parseFloat((current + FONT_SCALE_STEP).toFixed(2)));
        void setSetting(CONTENT_FONT_SCALE_KEY, next.toString());
      })
    );

    cleanups.push(
      window.api.menu.onFontZoomOut(() => {
        const current = parseFloat(
          useSettingsStore.getState().values[CONTENT_FONT_SCALE_KEY] ?? '1'
        );
        const next = clampFontScale(parseFloat((current - FONT_SCALE_STEP).toFixed(2)));
        void setSetting(CONTENT_FONT_SCALE_KEY, next.toString());
      })
    );

    cleanups.push(
      window.api.menu.onFontZoomReset(() => {
        void setSetting(CONTENT_FONT_SCALE_KEY, '1');
      })
    );

    cleanups.push(
      window.api.menu.onNewNote(async () => {
        try {
          const parts = locationRef.current.pathname.split('/').filter(Boolean);
          const inBinder = parts[0] === 'binders' && parts[1];
          const binderId = inBinder ? parts[1] : UNASSIGNED_BINDER_ID;
          const id = await window.api.storage.createNote(binderId);
          navigate('/binders/' + binderId + '/notes/' + id);
        } catch (error) {
          reportError(error, 'E4005');
        }
      })
    );

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [isMac, navigate, setSetting]);
}
