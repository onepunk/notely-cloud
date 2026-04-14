import { Button } from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import * as React from 'react';

import type { MeetingReminderState, MeetingReminderTriggerPayload } from '@common/meetingReminder';
import { formatErrorForDisplay } from '@shared/error';

import styles from './ReminderPopup.module.css';

type ReminderOrNull = MeetingReminderTriggerPayload | null;

const CONFIRMATION_FALLBACK_MESSAGE =
  'Starting a new recording will stop the current transcription in progress.';

// Utility function for formatting timestamps (currently unused but may be needed for future features)
// const formatTime = (timestamp: number): string => {
//   const formatter = new Intl.DateTimeFormat(undefined, {
//     hour: 'numeric',
//     minute: '2-digit',
//   });
//   return formatter.format(new Date(timestamp));
// };

export function ReminderPopup(): JSX.Element {
  const [reminder, setReminder] = React.useState<ReminderOrNull>(null);
  const [_managerState, setManagerState] = React.useState<MeetingReminderState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isBusy, setIsBusy] = React.useState(false);
  const [pendingConfirmation, setPendingConfirmation] = React.useState(false);
  const [confirmationMessage, setConfirmationMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!window.api?.meetingReminder) {
      setError('Meeting reminder APIs unavailable in preload.');
      return;
    }

    let isDisposed = false;

    window.api.meetingReminder
      .getState()
      .then((state) => {
        if (!isDisposed) {
          setManagerState(state);
        }
      })
      .catch((err) => {
        if (!isDisposed) {
          setError(formatErrorForDisplay(err, 'E6001'));
        }
      });

    const offReminder = window.api.meetingReminder.onReminderDue((payload) => {
      setReminder(payload);
      setPendingConfirmation(false);
      setConfirmationMessage(null);
    });
    const offState = window.api.meetingReminder.onStateChanged((state) => {
      setManagerState(state);
    });

    return () => {
      isDisposed = true;
      try {
        offReminder?.();
        offState?.();
      } catch (err) {
        console.warn('[MeetingReminderPopup] Failed to clean up listeners', err);
      }
    };
  }, []);

  const handleDismiss = React.useCallback(async () => {
    if (!window.api?.meetingReminder) {
      setReminder(null);
      setPendingConfirmation(false);
      setConfirmationMessage(null);
      return;
    }
    setIsBusy(true);
    try {
      // Dismiss will hide the window and refresh the schedule
      await window.api.meetingReminder.dismiss();
    } catch (err) {
      setError(formatErrorForDisplay(err, 'E6001', { action: 'dismiss' }));
    } finally {
      setReminder(null);
      setPendingConfirmation(false);
      setConfirmationMessage(null);
      setIsBusy(false);
    }
  }, []);

  const attemptStartRecording = React.useCallback(
    async ({ force = false }: { force?: boolean } = {}) => {
      if (!reminder || !window.api?.meetingReminder) {
        return;
      }
      setIsBusy(true);
      setError(null);
      try {
        const result = await window.api.meetingReminder.startRecording({
          payload: reminder,
          force,
        });
        if (result.status === 'needs-confirmation') {
          setPendingConfirmation(true);
          setConfirmationMessage(result.reason ?? CONFIRMATION_FALLBACK_MESSAGE);
          return;
        }
        setPendingConfirmation(false);
        setConfirmationMessage(null);
        setReminder(null);
        try {
          await window.api.meetingReminder.refresh();
        } catch (refreshErr) {
          console.warn('Meeting reminder: refresh failed after starting recording', refreshErr);
        }
      } catch (err) {
        setError(formatErrorForDisplay(err, 'E3003', { action: 'startRecording' }));
      } finally {
        setIsBusy(false);
      }
    },
    [reminder]
  );

  const handleRecord = React.useCallback(() => {
    void attemptStartRecording();
  }, [attemptStartRecording]);

  const handleConfirmRecord = React.useCallback(() => {
    void attemptStartRecording({ force: true });
  }, [attemptStartRecording]);

  const handleCancelConfirmation = React.useCallback(() => {
    setPendingConfirmation(false);
    setConfirmationMessage(null);
  }, []);

  return (
    <div className={styles.container} data-busy={isBusy}>
      <Button
        appearance="transparent"
        size="small"
        className={styles.closeButton}
        onClick={() => void handleDismiss()}
        disabled={isBusy}
        aria-label="Close"
      >
        <Dismiss20Regular />
      </Button>
      <header className={styles.header}>
        <p className={styles.title}>Upcoming Meeting</p>
        {reminder && <p className={styles.subtitle}>{reminder.event.title ?? 'Untitled'}</p>}
      </header>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {reminder && (
        <section className={styles.actions}>
          <button
            className={styles.recordButton}
            type="button"
            onClick={handleRecord}
            disabled={isBusy || pendingConfirmation}
          >
            Record
          </button>
          {pendingConfirmation && (
            <div className={styles.confirmationBar}>
              <p className={styles.confirmationMessage}>
                {confirmationMessage ?? CONFIRMATION_FALLBACK_MESSAGE}
              </p>
              <div className={styles.confirmationActions}>
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={handleCancelConfirmation}
                  disabled={isBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={styles.confirmButton}
                  onClick={handleConfirmRecord}
                  disabled={isBusy}
                >
                  Stop &amp; Record
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default ReminderPopup;
