/**
 * SetupScreen - Unified startup screen for loading, checking, and downloading components
 *
 * Single screen that displays throughout the entire startup process, updating status
 * text as the app progresses through loading -> checking -> downloading (if needed).
 * Auto-proceeds to the main app once all components are ready.
 */

import * as React from 'react';

import type { DownloadProgress } from '../../../shared/types/components';
import notelyLogo from '../../public/notely.png';

import styles from './SetupScreen.module.css';

export interface SetupScreenProps {
  /** Callback when all components are ready */
  onReady?: () => void;
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

type Phase = 'loading' | 'checking' | 'downloading' | 'starting-server' | 'error';

export function SetupScreen({ onReady }: SetupScreenProps): JSX.Element {
  const [phase, setPhase] = React.useState<Phase>('loading');
  const [overallProgress, setOverallProgress] = React.useState(0);
  const [currentDownload, setCurrentDownload] = React.useState<string | null>(null);
  const [downloadSpeed, setDownloadSpeed] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Derive status message from phase
  const statusMessage = React.useMemo(() => {
    switch (phase) {
      case 'error':
        return 'Setup encountered an error';
      case 'loading':
        return 'Loading...';
      case 'checking':
        return 'Checking components...';
      case 'downloading':
        if (currentDownload === 'audio-engine') return 'Downloading speech engine...';
        if (currentDownload === 'model-small.en') return 'Downloading speech model...';
        if (currentDownload) return `Downloading ${currentDownload}...`;
        return 'Preparing download...';
      case 'starting-server':
        return 'Starting speech engine...';
      default:
        return 'Loading...';
    }
  }, [phase, currentDownload]);

  // Initialize: check components and start downloads if needed
  React.useEffect(() => {
    const init = async () => {
      if (!window.api?.components) {
        // No components API - development mode or legacy build
        onReady?.();
        return;
      }

      try {
        // Quick check if everything is already ready
        const ready = await window.api.components.areAllReady();
        if (ready) {
          onReady?.();
          return;
        }

        // Check if main process has already reported a setup status (Phase 2.5)
        const setupStatus = await window.api.components.getSetupStatus?.();
        if (setupStatus) {
          if (setupStatus.phase === 'error') {
            setError(setupStatus.message || 'Setup failed');
            setPhase('error');
            return;
          }
          if (setupStatus.phase === 'ready') {
            onReady?.();
            return;
          }
        }

        // Components need checking
        setPhase('checking');

        const info = await window.api.components.checkAll();
        const needsDownload = info.some(
          (c) => c.status === 'not_downloaded' || c.status === 'corrupted'
        );

        if (!needsDownload) {
          // All components present, no download needed
          onReady?.();
          return;
        }

        // Start downloads
        setPhase('downloading');
        await window.api.components.downloadAll();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to check components');
        setPhase('error');
      }
    };

    void init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for component events
  React.useEffect(() => {
    if (!window.api?.components) return;

    const unsubProgress = window.api.components.onDownloadProgress((progress: DownloadProgress) => {
      setCurrentDownload(progress.componentId);
      setOverallProgress(progress.overallPercent);
      setDownloadSpeed(progress.speedBps || null);
    });

    const unsubError = window.api.components.onDownloadError((data) => {
      setError(`Failed to download ${data.componentId}: ${data.error}`);
      setPhase('error');
    });

    const unsubAllReady = window.api.components.onAllReady(() => {
      onReady?.();
    });

    const unsubSetupStatus = window.api.components.onSetupStatus?.((status) => {
      if (status.phase === 'error') {
        setError(status.message || 'Setup failed');
        setPhase('error');
      } else if (status.phase === 'ready') {
        onReady?.();
      } else if (status.phase === 'starting-server') {
        setPhase('starting-server');
      } else if (status.phase === 'downloading') {
        setPhase('downloading');
      } else if (status.phase === 'verifying') {
        setPhase('checking');
      }
    });

    return () => {
      unsubProgress();
      unsubError();
      unsubAllReady();
      unsubSetupStatus?.();
    };
  }, [onReady]);

  const handleRetry = React.useCallback(async () => {
    if (!window.api?.components) return;

    setError(null);
    setPhase('downloading');
    setOverallProgress(0);
    setCurrentDownload(null);

    try {
      await window.api.components.downloadAll();
      // Download succeeded — tell main process to start the transcription server
      setPhase('starting-server');
      await window.api.components.setupRetryComplete?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download components');
      setPhase('error');
    }
  }, []);

  return (
    <div className={styles.container}>
      <img src={notelyLogo} alt="Notely" className={styles.logo} />
      <h1 className={styles.title}>{phase === 'error' ? 'Setup Failed' : 'Notely'}</h1>
      <p className={styles.subtitle}>{statusMessage}</p>

      {phase === 'downloading' && overallProgress > 0 ? (
        <div className={styles.progressSection}>
          <div className={styles.progressBarContainer}>
            <div className={styles.progressBar} style={{ width: `${overallProgress}%` }} />
          </div>
          <div className={styles.progressInfo}>
            <span>{overallProgress}%</span>
            {downloadSpeed && downloadSpeed > 0 && <span>{formatBytes(downloadSpeed)}/s</span>}
          </div>
        </div>
      ) : phase === 'loading' || phase === 'checking' || phase === 'starting-server' ? (
        <div className={styles.indeterminateBar} />
      ) : null}

      {phase === 'error' && error && (
        <>
          <div className={styles.errorBanner}>
            <span>{error}</span>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.retryButton} onClick={handleRetry}>
              Retry Download
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default SetupScreen;
