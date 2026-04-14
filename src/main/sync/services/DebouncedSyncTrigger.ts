/**
 * DebouncedSyncTrigger - Manages debounced sync triggers for local changes
 *
 * This utility provides intelligent sync triggering that:
 * 1. Debounces rapid changes (waits for typing to stop)
 * 2. Enforces a max wait time (force sync even if still typing)
 * 3. Prevents redundant syncs when already syncing
 *
 * Best practice pattern used by Notion, Linear, Figma, etc.
 *
 * Date: 2025-12-09
 */

import { logger } from '../../logger';

export interface DebouncedSyncTriggerConfig {
  /** Debounce delay - wait this long after last change before syncing (default: 2000ms) */
  debounceMs: number;
  /** Max wait time - force sync even if changes keep coming (default: 10000ms) */
  maxWaitMs: number;
}

const DEFAULT_CONFIG: DebouncedSyncTriggerConfig = {
  debounceMs: 2000, // 2 seconds after last change
  maxWaitMs: 10000, // Force sync after 10 seconds max
};

export class DebouncedSyncTrigger {
  private debounceTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private firstChangeAt: number | null = null;
  private pendingChanges = false;
  private readonly config: DebouncedSyncTriggerConfig;
  private readonly onTrigger: () => void;

  constructor(onTrigger: () => void, config: Partial<DebouncedSyncTriggerConfig> = {}) {
    this.onTrigger = onTrigger;
    this.config = { ...DEFAULT_CONFIG, ...config };

    logger.debug('[DebouncedSyncTrigger] Created', {
      debounceMs: this.config.debounceMs,
      maxWaitMs: this.config.maxWaitMs,
    });
  }

  /**
   * Signal that a local change has occurred.
   * This will schedule a sync after the debounce period,
   * or immediately if maxWait has been exceeded.
   */
  notifyChange(): void {
    const now = Date.now();

    // Track first change time for max wait calculation
    if (this.firstChangeAt === null) {
      this.firstChangeAt = now;
      this.startMaxWaitTimer();
    }

    this.pendingChanges = true;

    // Check if we've exceeded max wait time
    const elapsed = now - this.firstChangeAt;
    if (elapsed >= this.config.maxWaitMs) {
      logger.debug('[DebouncedSyncTrigger] Max wait exceeded, triggering immediately', {
        elapsed,
        maxWaitMs: this.config.maxWaitMs,
      });
      this.trigger();
      return;
    }

    // Reset debounce timer
    this.resetDebounceTimer();
  }

  /**
   * Force an immediate sync (e.g., on app blur)
   * Only triggers if there are pending changes
   */
  flush(): void {
    if (this.pendingChanges) {
      logger.debug('[DebouncedSyncTrigger] Flush requested with pending changes');
      this.trigger();
    }
  }

  /**
   * Cancel any pending sync trigger
   */
  cancel(): void {
    this.clearTimers();
    this.pendingChanges = false;
    this.firstChangeAt = null;
    logger.debug('[DebouncedSyncTrigger] Cancelled');
  }

  /**
   * Check if there are pending changes waiting to sync
   */
  hasPendingChanges(): boolean {
    return this.pendingChanges;
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.clearTimers();
    logger.debug('[DebouncedSyncTrigger] Destroyed');
  }

  private resetDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingChanges) {
        logger.debug('[DebouncedSyncTrigger] Debounce timer fired');
        this.trigger();
      }
    }, this.config.debounceMs);
  }

  private startMaxWaitTimer(): void {
    if (this.maxWaitTimer) {
      return; // Already running
    }

    this.maxWaitTimer = setTimeout(() => {
      this.maxWaitTimer = null;
      if (this.pendingChanges) {
        logger.debug('[DebouncedSyncTrigger] Max wait timer fired');
        this.trigger();
      }
    }, this.config.maxWaitMs);
  }

  private trigger(): void {
    this.clearTimers();
    this.pendingChanges = false;
    this.firstChangeAt = null;

    logger.info('[DebouncedSyncTrigger] Triggering sync');
    this.onTrigger();
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = null;
    }
  }
}
