import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { toast } from 'sonner';

import type { MeetingReminderRecordCommand } from '@common/meetingReminder';

import { AppWithSetup } from './app/AppWithSetup';
import { initI18n } from './app/i18n';
import RoutesView from './app/routes';
import { useTranscriptionStore } from './features/transcription/model/transcription.store';
import { ErrorBoundary } from './shared/components';
import { reportError } from './shared/error';
import { AuthStoreProvider } from './shared/hooks/useAuthStore';
import { LicenseProvider } from './shared/hooks/useLicense';
import { useSettingsStore } from './shared/state/settings.store';
import './shared/styles/app.css';

async function handleMeetingReminderRecordCommand(
  command: MeetingReminderRecordCommand
): Promise<void> {
  window.api?.log?.info?.('Meeting reminder: record command received', {
    eventKey: command.eventKey,
    binderId: command.binderId,
  });

  const transcriptionStore = useTranscriptionStore.getState();
  let titleUpdateFailed = false;
  try {
    if (command.shouldStopExisting && transcriptionStore.isRecording) {
      await transcriptionStore.stop();
    }

    const { noteId } = await transcriptionStore.start({ binderId: command.binderId });

    if (noteId) {
      let lexicalJson = 'null';
      let plainText = '';
      try {
        const existing = await window.api.storage.getNote(noteId);
        lexicalJson = existing?.content?.lexicalJson ?? 'null';
        plainText = existing?.content?.plainText ?? '';
      } catch (fetchError) {
        window.api?.log?.warn?.('Meeting reminder: failed to fetch note before updating title', {
          noteId,
          error: fetchError instanceof Error ? fetchError.message : fetchError,
        });
      }

      try {
        await window.api.storage.saveNote({
          noteId,
          lexicalJson,
          plainText,
          title: command.meetingTitle,
        });
      } catch (saveError) {
        titleUpdateFailed = true;
        window.api?.log?.warn?.('Meeting reminder: failed to update meeting note title', {
          noteId,
          error: saveError instanceof Error ? saveError.message : saveError,
        });
      }

      window.dispatchEvent(new Event('notes:changed'));

      const targetHash = `#/binders/${command.binderId}/notes/${noteId}`;
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
      }
    } else {
      window.api?.log?.warn?.('Meeting reminder: transcription start did not return noteId', {
        binderId: command.binderId,
      });
    }

    toast.success(`Recording "${command.meetingTitle}"`, {
      description: titleUpdateFailed
        ? 'Recording started, but we could not update the meeting note title automatically.'
        : undefined,
    });

    window.api?.log?.info?.('Meeting reminder: recording pipeline started', {
      eventKey: command.eventKey,
      binderId: command.binderId,
      titleUpdateFailed,
    });
  } catch (error) {
    reportError(error, 'E3007', { eventKey: command.eventKey });
  }
}

/**
 * Global error handlers for uncaught errors
 * These catch errors that escape React's error boundary
 */
function setupGlobalErrorHandlers(): void {
  // Handle uncaught synchronous errors
  window.onerror = (message, source, lineno, colno, error) => {
    reportError(error ?? message, 'E8002', {
      source,
      lineno,
      colno,
      globalHandler: 'onerror',
    });
    // Return false to allow default browser error handling (console logging)
    return false;
  };

  // Handle unhandled promise rejections
  window.onunhandledrejection = (event) => {
    reportError(event.reason, 'E8002', {
      type: 'unhandledrejection',
      globalHandler: 'onunhandledrejection',
    });
  };
}

async function bootstrap() {
  // Setup global error handlers first
  setupGlobalErrorHandlers();

  await initI18n();
  // Hydrate settings from DB at app start and subscribe to remote changes
  try {
    // Prefer snapshot from main to avoid initial IPC roundtrip
    const onHydrate =
      typeof window.api?.onSettingsHydrate === 'function' ? window.api.onSettingsHydrate : null;
    let didHydrateFromSnapshot = false;
    const offHydrate = onHydrate
      ? onHydrate((rows) => {
          useSettingsStore.getState().hydrateFromSnapshot(rows);
          didHydrateFromSnapshot = true;
        })
      : () => {};
    if (!didHydrateFromSnapshot) {
      await useSettingsStore.getState().hydrate();
    }
    const subscribe =
      typeof window.api?.onSettingsChanged === 'function' ? window.api.onSettingsChanged : null;
    const off = subscribe
      ? subscribe((key, value) => {
          useSettingsStore.getState().onRemoteChange(key, value);
        })
      : () => {};
    window.addEventListener('beforeunload', () => {
      try {
        off?.();
        offHydrate?.();
      } catch (err) {
        window.api?.log?.debug?.('settings off() threw during unload', {
          error: err instanceof Error ? err.message : err,
        });
      }
    });
  } catch (err) {
    window.api?.log?.error?.('Failed to hydrate settings on startup', {
      error: err instanceof Error ? err.message : err,
    });
  }

  // Forward notes:changed IPC events as DOM events for the NoteList component
  try {
    const onNotesChanged =
      typeof window.api?.onNotesChanged === 'function' ? window.api.onNotesChanged : null;
    const offNotesChanged = onNotesChanged
      ? onNotesChanged(() => {
          window.dispatchEvent(new Event('notes:changed'));
        })
      : () => {};
    window.addEventListener('beforeunload', () => {
      try {
        offNotesChanged?.();
      } catch (err) {
        window.api?.log?.debug?.('notes:changed off() threw during unload', {
          error: err instanceof Error ? err.message : err,
        });
      }
    });
  } catch (err) {
    window.api?.log?.error?.('Failed to setup notes:changed event forwarding', {
      error: err instanceof Error ? err.message : err,
    });
  }

  // Register meeting reminder record command handler
  try {
    const onRecordCommand =
      typeof window.api?.meetingReminder?.onRecordCommand === 'function'
        ? window.api.meetingReminder.onRecordCommand
        : null;
    const offRecordCommand = onRecordCommand
      ? onRecordCommand((command) => {
          void handleMeetingReminderRecordCommand(command);
        })
      : () => {};
    window.addEventListener('beforeunload', () => {
      try {
        offRecordCommand();
      } catch (err) {
        window.api?.log?.debug?.('meetingReminder off() threw during unload', {
          error: err instanceof Error ? err.message : err,
        });
      }
    });
  } catch (err) {
    window.api?.log?.error?.('Failed to register meeting reminder record handler', {
      error: err instanceof Error ? err.message : err,
    });
  }

  const container = document.querySelector('.app-root')!;

  // Set platform data attribute for platform-specific styling
  if (window.api?.platform) {
    container.setAttribute('data-platform', window.api.platform);
  }

  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <AppWithSetup>
          <AuthStoreProvider>
            <LicenseProvider>
              <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
                <RoutesView />
              </HashRouter>
            </LicenseProvider>
          </AuthStoreProvider>
        </AppWithSetup>
      </ErrorBoundary>
    </React.StrictMode>
  );

  // Opt-in HMR boundary at the app root to avoid full reloads for non-React modules
  if (
    import.meta &&
    (import.meta as { hot?: { accept: () => void; dispose: (cb: () => void) => void } }).hot
  ) {
    (
      import.meta as unknown as { hot: { accept: () => void; dispose: (cb: () => void) => void } }
    ).hot.accept();
    (
      import.meta as unknown as { hot: { accept: () => void; dispose: (cb: () => void) => void } }
    ).hot.dispose(() => {
      try {
        root.unmount();
      } catch {
        /* ignore unmount errors during HMR */
      }
    });
  }
}

bootstrap();
