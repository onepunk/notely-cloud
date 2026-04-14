import { EventEmitter } from 'events';

import { logger } from '../logger';

export interface SummaryJobStatus {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  jobType: string;
  progressPercent?: number;
  currentStep?: string;
  errorMessage?: string;
  processingStats?: Record<string, unknown>;
  createdAt: Date;
  completedAt?: Date;
  summaryId?: string;
}

export interface SummaryJobPollerEvents {
  'job-completed': (job: SummaryJobStatus) => void;
  'job-failed': (job: SummaryJobStatus) => void;
  'job-progress': (job: SummaryJobStatus) => void;
}

export interface SummaryJobPollerDependencies {
  getAuthToken: () => Promise<string | null>;
  getServerUrl: () => Promise<string>;
}

/**
 * SummaryJobPoller manages background polling for summary generation jobs.
 * Uses exponential backoff for failed requests and caching for active jobs.
 */
export class SummaryJobPoller extends EventEmitter {
  private activeJobs: Map<string, SummaryJobStatus> = new Map();
  private pollIntervals: Map<string, NodeJS.Timeout> = new Map();
  private retryDelays: Map<string, number> = new Map();

  private readonly BASE_POLL_INTERVAL = 10000; // 10 seconds
  private readonly MAX_POLL_INTERVAL = 300000; // 5 minutes
  private readonly MAX_RETRIES = 5;
  private readonly BASE_RETRY_DELAY = 1000; // 1 second

  constructor(private deps: SummaryJobPollerDependencies) {
    super();
    this.setMaxListeners(100); // Allow many listeners for job status updates
  }

  /**
   * Start polling for a summary job
   */
  startPolling(jobId: string, initialStatus?: SummaryJobStatus): void {
    logger.info('SummaryJobPoller: Starting polling for job', { jobId });

    if (this.pollIntervals.has(jobId)) {
      logger.debug('SummaryJobPoller: Job already being polled', { jobId });
      return;
    }

    if (initialStatus) {
      this.activeJobs.set(jobId, initialStatus);
    }

    this.scheduleNextPoll(jobId, this.BASE_POLL_INTERVAL);
  }

  /**
   * Stop polling for a job
   */
  stopPolling(jobId: string): void {
    logger.debug('SummaryJobPoller: Stopping polling for job', { jobId });

    const interval = this.pollIntervals.get(jobId);
    if (interval) {
      clearTimeout(interval);
      this.pollIntervals.delete(jobId);
    }

    this.activeJobs.delete(jobId);
    this.retryDelays.delete(jobId);
  }

  /**
   * Get current status of a job from cache
   */
  getJobStatus(jobId: string): SummaryJobStatus | null {
    return this.activeJobs.get(jobId) || null;
  }

  /**
   * Get all active job IDs
   */
  getActiveJobIds(): string[] {
    return Array.from(this.activeJobs.keys());
  }

  /**
   * Stop all polling
   */
  stopAllPolling(): void {
    logger.info('SummaryJobPoller: Stopping all job polling');

    for (const jobId of this.activeJobs.keys()) {
      this.stopPolling(jobId);
    }
  }

  /**
   * Schedule the next poll for a job
   */
  private scheduleNextPoll(jobId: string, delay: number): void {
    const timeout = setTimeout(() => {
      this.pollJob(jobId);
    }, delay);

    this.pollIntervals.set(jobId, timeout);
  }

  /**
   * Poll a single job status
   */
  private async pollJob(jobId: string): Promise<void> {
    try {
      logger.debug('SummaryJobPoller: Polling job status', { jobId });

      const authToken = await this.deps.getAuthToken();
      if (!authToken) {
        logger.error('SummaryJobPoller: No auth token available for polling', { jobId });
        this.handlePollError(jobId, new Error('No authentication token'));
        return;
      }

      const serverUrl = await this.deps.getServerUrl();
      const response = await fetch(`${serverUrl}/api/summaries/jobs/${jobId}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.success) {
        throw new Error(data.error || 'Job status request failed');
      }

      const job: SummaryJobStatus = {
        id: data.job.id,
        status: data.job.status,
        jobType: data.job.job_type,
        progressPercent: data.job.progress_percent,
        currentStep: data.job.current_step,
        errorMessage: data.job.error_message,
        processingStats: data.job.processing_stats,
        createdAt: new Date(data.job.created_at),
        completedAt: data.job.completed_at ? new Date(data.job.completed_at) : undefined,
        summaryId: data.job.summary_id,
      };

      this.updateJobStatus(job);
    } catch (error) {
      logger.error('SummaryJobPoller: Failed to poll job status', {
        jobId,
        error: error instanceof Error ? error.message : error,
      });
      this.handlePollError(jobId, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Update job status and emit events
   */
  private updateJobStatus(job: SummaryJobStatus): void {
    const _previousJob = this.activeJobs.get(job.id);
    this.activeJobs.set(job.id, job);

    // Reset retry delay on successful poll
    this.retryDelays.delete(job.id);

    // Emit progress event if job is still running
    if (job.status === 'processing' || job.status === 'pending') {
      this.emit('job-progress', job);
      // Schedule next poll
      this.scheduleNextPoll(job.id, this.BASE_POLL_INTERVAL);
      return;
    }

    // Job is complete - emit appropriate event and stop polling
    if (job.status === 'completed') {
      logger.info('SummaryJobPoller: Job completed', {
        jobId: job.id,
        summaryId: job.summaryId,
        processingTime: job.processingStats,
      });
      this.emit('job-completed', job);
    } else if (job.status === 'failed') {
      logger.warn('SummaryJobPoller: Job failed', {
        jobId: job.id,
        error: job.errorMessage,
      });
      this.emit('job-failed', job);
    }

    this.stopPolling(job.id);
  }

  /**
   * Handle polling errors with exponential backoff
   */
  private handlePollError(jobId: string, error: Error): void {
    const currentRetries = this.retryDelays.get(jobId) || 0;

    if (currentRetries >= this.MAX_RETRIES) {
      logger.error('SummaryJobPoller: Max retries exceeded for job', {
        jobId,
        retries: currentRetries,
        error: error.message,
      });

      // Create a failed job status
      const failedJob: SummaryJobStatus = {
        id: jobId,
        status: 'failed',
        jobType: 'unknown',
        errorMessage: `Polling failed after ${currentRetries} retries: ${error.message}`,
        createdAt: new Date(),
        completedAt: new Date(),
      };

      this.emit('job-failed', failedJob);
      this.stopPolling(jobId);
      return;
    }

    // Calculate exponential backoff delay
    const retryDelay = this.BASE_RETRY_DELAY * Math.pow(2, currentRetries);
    const jitteredDelay = retryDelay + Math.random() * 1000; // Add jitter
    const finalDelay = Math.min(jitteredDelay, this.MAX_POLL_INTERVAL);

    logger.warn('SummaryJobPoller: Retrying job poll with backoff', {
      jobId,
      retries: currentRetries + 1,
      delay: finalDelay,
      error: error.message,
    });

    this.retryDelays.set(jobId, currentRetries + 1);
    this.scheduleNextPoll(jobId, finalDelay);
  }

  // Type-safe event emitter methods
  on<K extends keyof SummaryJobPollerEvents>(event: K, listener: SummaryJobPollerEvents[K]): this {
    return super.on(event, listener);
  }

  emit<K extends keyof SummaryJobPollerEvents>(
    event: K,
    ...args: Parameters<SummaryJobPollerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  off<K extends keyof SummaryJobPollerEvents>(event: K, listener: SummaryJobPollerEvents[K]): this {
    return super.off(event, listener);
  }
}
