/**
 * UpdateNotification Component
 * Shows a notification popup in the bottom-right corner when an update is available
 * Automatically downloads the update and prompts user to restart
 */

import {
  Button,
  Card,
  CardHeader,
  Link,
  ProgressBar,
  Text,
  tokens,
} from '@fluentui/react-components';
import { ArrowSync24Regular, Dismiss24Regular, ErrorCircle24Regular } from '@fluentui/react-icons';
import * as React from 'react';

import type { UpdateInfo } from '../../../preload/index';

import styles from './UpdateNotification.module.css';

export interface UpdateNotificationProps {
  className?: string;
}

type NotificationState = 'hidden' | 'downloading' | 'ready' | 'error';

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({ className }) => {
  const [updateInfo, setUpdateInfo] = React.useState<UpdateInfo | null>(null);
  const [notificationState, setNotificationState] = React.useState<NotificationState>('hidden');
  const [downloadProgress, setDownloadProgress] = React.useState(0);
  const [downloadError, setDownloadError] = React.useState<string | null>(null);
  const [isVisible, setIsVisible] = React.useState(false);

  // Check for updates on mount and handle auto-download
  React.useEffect(() => {
    let mounted = true;

    const checkForUpdates = async () => {
      try {
        // Check for updates (no authentication required)
        const result = await window.api?.update?.check?.();
        if (!mounted) return;

        if (result?.success && result.data?.updateAvailable) {
          // Check if this version was dismissed (only for non-force updates)
          const dismissed =
            !result.data.forceUpdate &&
            (await window.api?.update?.isDismissed?.(result.data.latestVersion || ''));
          if (!mounted) return;

          if (!dismissed) {
            setUpdateInfo(result.data);

            // Check current download status
            const status = await window.api?.update?.getDownloadStatus?.();
            if (!mounted) return;

            if (status?.state === 'complete') {
              // Already downloaded
              setNotificationState('ready');
              setDownloadProgress(100);
            } else if (status?.state === 'downloading') {
              // Download in progress
              setNotificationState('downloading');
              setDownloadProgress(status.progress);
            } else if (status?.state === 'error') {
              // Previous download failed
              setNotificationState('error');
              setDownloadError(status.error);
            } else {
              // Start auto-download
              setNotificationState('downloading');
              void window.api?.update?.startDownload?.();
            }

            // Small delay before showing to avoid flicker
            setTimeout(() => {
              if (mounted) setIsVisible(true);
            }, 500);
          }
        }
      } catch (error) {
        window.api?.log?.error?.('UpdateNotification: Failed to check for updates', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void checkForUpdates();

    // Listen for update available events (e.g., from periodic checks)
    const unsubscribeAvailable = window.api?.update?.onAvailable?.((info) => {
      if (!mounted) return;
      setUpdateInfo(info);
      setNotificationState('downloading');
      setIsVisible(true);
      // Start download automatically
      void window.api?.update?.startDownload?.();
    });

    // Listen for download started events
    const unsubscribeDownloadStarted = window.api?.update?.onDownloadStarted?.(() => {
      if (!mounted) return;
      setNotificationState('downloading');
      setDownloadProgress(0);
      setDownloadError(null);
    });

    // Listen for download progress events
    const unsubscribeDownloadProgress = window.api?.update?.onDownloadProgress?.((progress) => {
      if (!mounted) return;
      setDownloadProgress(progress);
    });

    // Listen for download complete events
    const unsubscribeDownloadComplete = window.api?.update?.onDownloadComplete?.(() => {
      if (!mounted) return;
      setNotificationState('ready');
      setDownloadProgress(100);
    });

    // Listen for download error events
    const unsubscribeDownloadError = window.api?.update?.onDownloadError?.((error) => {
      if (!mounted) return;
      setNotificationState('error');
      setDownloadError(error);
    });

    // Listen for update dismissed events
    const unsubscribeDismissed = window.api?.update?.onDismissed?.(() => {
      if (!mounted) return;
      setIsVisible(false);
      setNotificationState('hidden');
    });

    return () => {
      mounted = false;
      unsubscribeAvailable?.();
      unsubscribeDownloadStarted?.();
      unsubscribeDownloadProgress?.();
      unsubscribeDownloadComplete?.();
      unsubscribeDownloadError?.();
      unsubscribeDismissed?.();
    };
  }, []);

  const handleRestartNow = React.useCallback(async () => {
    try {
      window.api?.log?.info?.('UpdateNotification: User clicked restart now', {
        version: updateInfo?.latestVersion,
      });
      const result = await window.api?.update?.installAndRestart?.();
      if (!result?.success) {
        setNotificationState('error');
        setDownloadError(result?.error || 'Failed to start installer');
      }
    } catch (error) {
      window.api?.log?.error?.('UpdateNotification: Failed to install and restart', {
        error: error instanceof Error ? error.message : String(error),
      });
      setNotificationState('error');
      setDownloadError(error instanceof Error ? error.message : 'Unknown error');
    }
  }, [updateInfo?.latestVersion]);

  const handleWhatsNew = React.useCallback(() => {
    window.api?.window?.openExternal?.('https://yourdomain.com/releases/');
    window.api?.log?.info?.("UpdateNotification: User clicked what's new");
  }, []);

  const handleLater = React.useCallback(async () => {
    if (!updateInfo?.latestVersion) return;

    try {
      await window.api?.update?.dismiss?.(updateInfo.latestVersion);
      setIsVisible(false);
      setNotificationState('hidden');
      window.api?.log?.info?.('UpdateNotification: User clicked later', {
        version: updateInfo.latestVersion,
      });
    } catch (error) {
      window.api?.log?.error?.('UpdateNotification: Failed to dismiss update', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [updateInfo?.latestVersion]);

  const handleRetry = React.useCallback(async () => {
    try {
      await window.api?.update?.resetDownload?.();
      setNotificationState('downloading');
      setDownloadProgress(0);
      setDownloadError(null);
      void window.api?.update?.startDownload?.();
      window.api?.log?.info?.('UpdateNotification: User clicked retry');
    } catch (error) {
      window.api?.log?.error?.('UpdateNotification: Failed to retry download', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleDismiss = React.useCallback(async () => {
    // For force updates, don't allow dismiss
    if (updateInfo?.forceUpdate) return;

    if (!updateInfo?.latestVersion) return;

    try {
      await window.api?.update?.dismiss?.(updateInfo.latestVersion);
      setIsVisible(false);
      setNotificationState('hidden');
      window.api?.log?.info?.('UpdateNotification: User dismissed notification', {
        version: updateInfo.latestVersion,
      });
    } catch (error) {
      window.api?.log?.error?.('UpdateNotification: Failed to dismiss', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [updateInfo?.forceUpdate, updateInfo?.latestVersion]);

  // Don't render if hidden or no update
  if (!updateInfo?.updateAvailable || notificationState === 'hidden' || !isVisible) {
    return null;
  }

  const containerClassName = className ? `${styles.container} ${className}` : styles.container;
  const isForceUpdate = updateInfo.forceUpdate;

  // Render different states
  const renderContent = () => {
    switch (notificationState) {
      case 'downloading':
        return (
          <>
            <CardHeader
              header={
                <Text weight="semibold" className={styles.title}>
                  Downloading Update
                </Text>
              }
              description={
                <Text size={200} className={styles.description}>
                  Version {updateInfo.latestVersion} ({downloadProgress}%)
                </Text>
              }
            />
            <div className={styles.progressContainer}>
              <ProgressBar value={downloadProgress / 100} className={styles.progressBar} />
            </div>
          </>
        );

      case 'ready':
        return (
          <>
            <CardHeader
              header={
                <Text weight="semibold" className={styles.title}>
                  Update Ready
                </Text>
              }
              description={
                <Text size={200} className={styles.description}>
                  Version {updateInfo.latestVersion} is ready to install
                </Text>
              }
              action={
                !isForceUpdate ? (
                  <Button
                    appearance="transparent"
                    size="small"
                    icon={<Dismiss24Regular />}
                    onClick={handleDismiss}
                    aria-label="Dismiss update notification"
                    className={styles.dismissButton}
                  />
                ) : undefined
              }
            />
            <div className={styles.actions}>
              <div className={styles.buttonRow}>
                <Button
                  appearance="primary"
                  size="small"
                  icon={<ArrowSync24Regular />}
                  onClick={handleRestartNow}
                >
                  Restart Now
                </Button>
                {!isForceUpdate && (
                  <Button appearance="subtle" size="small" onClick={handleLater}>
                    Later
                  </Button>
                )}
              </div>
              <Link className={styles.whatsNewLink} onClick={handleWhatsNew}>
                {"What's new"}
              </Link>
            </div>
            {isForceUpdate && (
              <Text
                size={100}
                style={{ color: tokens.colorPaletteRedForeground1 }}
                className={styles.forceUpdate}
              >
                This update is required
              </Text>
            )}
          </>
        );

      case 'error':
        return (
          <>
            <CardHeader
              header={
                <Text weight="semibold" className={styles.title}>
                  <ErrorCircle24Regular
                    style={{
                      color: tokens.colorPaletteRedForeground1,
                      marginRight: '8px',
                      verticalAlign: 'middle',
                    }}
                  />
                  Download Failed
                </Text>
              }
              description={
                <Text size={200} className={styles.description}>
                  {downloadError || 'Failed to download update'}
                </Text>
              }
              action={
                !isForceUpdate ? (
                  <Button
                    appearance="transparent"
                    size="small"
                    icon={<Dismiss24Regular />}
                    onClick={handleDismiss}
                    aria-label="Dismiss update notification"
                    className={styles.dismissButton}
                  />
                ) : undefined
              }
            />
            <div className={styles.actions}>
              <Button appearance="primary" size="small" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          </>
        );

      default:
        return null;
    }
  };

  return (
    <div className={containerClassName} data-testid="update-notification">
      <Card className={styles.card}>{renderContent()}</Card>
    </div>
  );
};

UpdateNotification.displayName = 'UpdateNotification';
