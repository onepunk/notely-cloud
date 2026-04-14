import { BrowserWindow, Notification } from 'electron';

import { logger } from '../logger';

import { SummaryJobStatus } from './SummaryJobPoller';

export interface SummaryNotificationManagerDependencies {
  mainWindow: BrowserWindow | null;
}

export interface SummaryNotification {
  id: string;
  type: 'summary-started' | 'summary-completed' | 'summary-failed';
  title: string;
  message: string;
  jobId?: string;
  summaryId?: string;
  transcriptionId?: string;
  timestamp: Date;
}

/**
 * SummaryNotificationManager handles user notifications for summary generation events.
 * Provides both native OS notifications and in-app notification events.
 */
export class SummaryNotificationManager {
  constructor(private deps: SummaryNotificationManagerDependencies) {}

  /**
   * Show notification when summary generation starts
   */
  notifySummaryStarted(jobId: string, transcriptionId: string): void {
    const notification: SummaryNotification = {
      id: `summary-started-${jobId}`,
      type: 'summary-started',
      title: 'Summary Generation Started',
      message: 'Your AI summary is being generated in the background.',
      jobId,
      transcriptionId,
      timestamp: new Date(),
    };

    logger.info('SummaryNotificationManager: Summary generation started', {
      jobId,
      transcriptionId,
    });

    this.showNotification(notification);
    this.sendToRenderer('summary-notification', notification);
  }

  /**
   * Show notification when summary generation completes
   */
  notifySummaryCompleted(job: SummaryJobStatus, transcriptionId: string): void {
    const notification: SummaryNotification = {
      id: `summary-completed-${job.id}`,
      type: 'summary-completed',
      title: 'Summary Ready!',
      message: 'Your AI summary has been generated and is ready to view.',
      jobId: job.id,
      summaryId: job.summaryId,
      transcriptionId,
      timestamp: new Date(),
    };

    logger.info('SummaryNotificationManager: Summary generation completed', {
      jobId: job.id,
      summaryId: job.summaryId,
      transcriptionId,
      processingTime: job.processingStats,
    });

    this.showNotification(notification);
    this.sendToRenderer('summary-notification', notification);
  }

  /**
   * Show notification when summary generation fails
   */
  notifySummaryFailed(job: SummaryJobStatus, transcriptionId: string): void {
    const notification: SummaryNotification = {
      id: `summary-failed-${job.id}`,
      type: 'summary-failed',
      title: 'Summary Generation Failed',
      message: job.errorMessage || 'Failed to generate summary. Please try again.',
      jobId: job.id,
      transcriptionId,
      timestamp: new Date(),
    };

    logger.warn('SummaryNotificationManager: Summary generation failed', {
      jobId: job.id,
      transcriptionId,
      error: job.errorMessage,
    });

    this.showNotification(notification);
    this.sendToRenderer('summary-notification', notification);
  }

  /**
   * Show progress notification (less intrusive)
   */
  notifyProgress(job: SummaryJobStatus, transcriptionId: string): void {
    // Only log progress, don't show intrusive notifications
    logger.debug('SummaryNotificationManager: Summary generation progress', {
      jobId: job.id,
      transcriptionId,
      progress: job.progressPercent,
      currentStep: job.currentStep,
    });

    // Send progress update to renderer for in-app indicators
    this.sendToRenderer('summary-progress', {
      jobId: job.id,
      transcriptionId,
      progress: job.progressPercent,
      currentStep: job.currentStep,
      timestamp: new Date(),
    });
  }

  /**
   * Show native OS notification
   */
  private showNotification(notification: SummaryNotification): void {
    try {
      // Check if notifications are supported
      if (!Notification.isSupported()) {
        logger.debug('SummaryNotificationManager: Native notifications not supported');
        return;
      }

      const nativeNotification = new Notification({
        title: notification.title,
        body: notification.message,
        silent: false,
        urgency: notification.type === 'summary-failed' ? 'critical' : 'normal',
      });

      // Handle notification click to focus window
      nativeNotification.on('click', () => {
        logger.debug('SummaryNotificationManager: Notification clicked', {
          notificationId: notification.id,
        });

        if (this.deps.mainWindow) {
          if (this.deps.mainWindow.isMinimized()) {
            this.deps.mainWindow.restore();
          }
          this.deps.mainWindow.focus();
          this.deps.mainWindow.show();

          // If it's a completed summary, navigate to transcription view
          if (notification.type === 'summary-completed' && notification.transcriptionId) {
            this.sendToRenderer('navigate-to-transcription', {
              transcriptionId: notification.transcriptionId,
              highlightSummary: true,
            });
          }
        }
      });

      nativeNotification.show();

      // Auto-close notification after delay for non-critical notifications
      if (notification.type !== 'summary-failed') {
        setTimeout(() => {
          nativeNotification.close();
        }, 5000); // 5 seconds
      }
    } catch (error) {
      logger.error('SummaryNotificationManager: Failed to show native notification', {
        error: error instanceof Error ? error.message : error,
        notification: notification.id,
      });
    }
  }

  /**
   * Send notification data to renderer process
   */
  private sendToRenderer(channel: string, data: unknown): void {
    try {
      if (!this.deps.mainWindow || !this.deps.mainWindow.webContents) {
        logger.debug(
          'SummaryNotificationManager: No main window available for renderer communication'
        );
        return;
      }

      this.deps.mainWindow.webContents.send(channel, data);
      logger.debug('SummaryNotificationManager: Sent data to renderer', {
        channel,
        dataType: typeof data,
      });
    } catch (error) {
      logger.error('SummaryNotificationManager: Failed to send to renderer', {
        channel,
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
