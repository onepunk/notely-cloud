import { EventEmitter } from 'node:events';

import { logger } from '../logger';

/**
 * Sync State Machine
 *
 * This implements a finite state machine for managing sync lifecycle.
 * Instead of scattered boolean checks and ad-hoc start/stop calls,
 * all sync state transitions flow through this machine.
 *
 * States:
 * - disabled: Sync is not available (no feature, setting off, or not authenticated)
 * - idle: Sync is available and waiting for triggers
 * - syncing: Actively synchronizing
 * - error: In error state with backoff
 *
 * The machine ensures:
 * - Only valid transitions occur
 * - State changes are logged and observable
 * - Single source of truth for sync availability
 */

// ============================================================================
// Types
// ============================================================================

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'error';

export type SyncEvent =
  | { type: 'AUTH_SUCCESS' }
  | { type: 'AUTH_LOGOUT' }
  | { type: 'SYNC_ENABLED' }
  | { type: 'SYNC_DISABLED' }
  | { type: 'FEATURE_GRANTED' }
  | { type: 'FEATURE_REVOKED' }
  | { type: 'NETWORK_ONLINE' }
  | { type: 'NETWORK_OFFLINE' }
  | { type: 'TRIGGER_SYNC'; trigger: SyncTrigger }
  | { type: 'SYNC_COMPLETE'; processedCount: number }
  | { type: 'SYNC_ERROR'; error: string; retryable: boolean }
  | { type: 'RETRY_TIMER_EXPIRED' }
  | { type: 'CONDITIONS_CHECK' }; // Re-evaluate all conditions

export type SyncTrigger =
  | 'startup'
  | 'periodic'
  | 'manual'
  | 'network_reconnect'
  | 'pre_quit'
  | 'websocket'
  | 'local_change'
  | 'app_blur';

export interface SyncConditions {
  isAuthenticated: boolean;
  hasSyncFeature: boolean;
  syncSettingEnabled: boolean;
  isOnline: boolean;
}

export interface SyncContext {
  conditions: SyncConditions;
  lastSyncAt: number | null;
  lastError: string | null;
  retryCount: number;
  currentTrigger: SyncTrigger | null;
}

export interface SyncStateTransition {
  from: SyncState;
  to: SyncState;
  event: SyncEvent;
  context: SyncContext;
  timestamp: number;
}

// ============================================================================
// State Machine Implementation
// ============================================================================

export class SyncStateMachine extends EventEmitter {
  private _state: SyncState = 'disabled';
  private _context: SyncContext = {
    conditions: {
      isAuthenticated: false,
      hasSyncFeature: false,
      syncSettingEnabled: false,
      isOnline: true, // Assume online initially
    },
    lastSyncAt: null,
    lastError: null,
    retryCount: 0,
    currentTrigger: null,
  };

  private readonly maxRetries = 3;
  private readonly baseBackoffMs = 2000;

  constructor() {
    super();
    logger.info('[SyncStateMachine] Initialized in disabled state');
  }

  // ============================================================================
  // Public API
  // ============================================================================

  get state(): SyncState {
    return this._state;
  }

  get context(): Readonly<SyncContext> {
    return { ...this._context };
  }

  get canSync(): boolean {
    return this._state === 'idle';
  }

  get isSyncing(): boolean {
    return this._state === 'syncing';
  }

  get isEnabled(): boolean {
    return this._state !== 'disabled';
  }

  /**
   * Send an event to the state machine, triggering potential state transitions
   */
  send(event: SyncEvent): void {
    const previousState = this._state;

    // Update context based on event
    this.updateContextFromEvent(event);

    // Calculate next state
    const nextState = this.getNextState(event);

    if (nextState !== previousState) {
      this.transition(previousState, nextState, event);
    } else {
      // Even without state change, log significant events
      if (event.type !== 'CONDITIONS_CHECK') {
        logger.debug('[SyncStateMachine] Event processed, no state change', {
          state: this._state,
          event: event.type,
        });
      }
    }
  }

  /**
   * Update all conditions at once (useful for initialization)
   */
  setConditions(conditions: Partial<SyncConditions>): void {
    this._context.conditions = {
      ...this._context.conditions,
      ...conditions,
    };

    logger.debug('[SyncStateMachine] Conditions updated', {
      conditions: this._context.conditions,
    });

    // Re-evaluate state based on new conditions
    this.send({ type: 'CONDITIONS_CHECK' });
  }

  /**
   * Get the backoff delay for current retry count
   */
  getBackoffDelay(): number {
    return this.baseBackoffMs * Math.pow(2, this._context.retryCount);
  }

  // ============================================================================
  // State Transition Logic
  // ============================================================================

  private getNextState(event: SyncEvent): SyncState {
    const { conditions } = this._context;

    // Check if all conditions for sync are met
    const allConditionsMet =
      conditions.isAuthenticated &&
      conditions.hasSyncFeature &&
      conditions.syncSettingEnabled &&
      conditions.isOnline;

    switch (this._state) {
      case 'disabled':
        // Can transition to idle if all conditions are met
        if (allConditionsMet) {
          return 'idle';
        }
        return 'disabled';

      case 'idle':
        // If conditions no longer met, go back to disabled
        if (!allConditionsMet) {
          return 'disabled';
        }
        // If sync triggered, go to syncing
        if (event.type === 'TRIGGER_SYNC') {
          return 'syncing';
        }
        return 'idle';

      case 'syncing':
        // If conditions lost during sync, still complete but then go to disabled
        if (event.type === 'SYNC_COMPLETE') {
          return allConditionsMet ? 'idle' : 'disabled';
        }
        if (event.type === 'SYNC_ERROR') {
          const errorEvent = event as { type: 'SYNC_ERROR'; error: string; retryable: boolean };
          if (errorEvent.retryable && this._context.retryCount < this.maxRetries) {
            return 'error';
          }
          // Non-retryable or max retries exceeded
          return allConditionsMet ? 'idle' : 'disabled';
        }
        // Auth logout during sync should cancel
        if (event.type === 'AUTH_LOGOUT') {
          return 'disabled';
        }
        return 'syncing';

      case 'error':
        // If conditions lost, go to disabled
        if (!allConditionsMet) {
          return 'disabled';
        }
        // If retry timer expired, try syncing again
        if (event.type === 'RETRY_TIMER_EXPIRED') {
          return 'syncing';
        }
        // Manual trigger can override backoff
        if (event.type === 'TRIGGER_SYNC') {
          const triggerEvent = event as { type: 'TRIGGER_SYNC'; trigger: SyncTrigger };
          if (triggerEvent.trigger === 'manual') {
            return 'syncing';
          }
        }
        return 'error';

      default:
        return this._state;
    }
  }

  private transition(from: SyncState, to: SyncState, event: SyncEvent): void {
    this._state = to;

    // Handle state entry actions
    this.onStateEnter(to, event);

    const transition: SyncStateTransition = {
      from,
      to,
      event,
      context: { ...this._context },
      timestamp: Date.now(),
    };

    logger.info('[SyncStateMachine] State transition', {
      from,
      to,
      event: event.type,
      conditions: this._context.conditions,
    });

    this.emit('transition', transition);
    this.emit(`state:${to}`, transition);
  }

  private onStateEnter(state: SyncState, event: SyncEvent): void {
    switch (state) {
      case 'idle':
        // Reset retry count when entering idle
        this._context.retryCount = 0;
        this._context.lastError = null;
        this._context.currentTrigger = null;
        break;

      case 'syncing':
        // Set current trigger
        if (event.type === 'TRIGGER_SYNC') {
          this._context.currentTrigger = (
            event as { type: 'TRIGGER_SYNC'; trigger: SyncTrigger }
          ).trigger;
        } else if (event.type === 'RETRY_TIMER_EXPIRED') {
          // Keep previous trigger for retry
        }
        break;

      case 'error':
        // Increment retry count
        this._context.retryCount++;
        if (event.type === 'SYNC_ERROR') {
          this._context.lastError = (event as { type: 'SYNC_ERROR'; error: string }).error;
        }
        break;

      case 'disabled':
        // Reset all sync-related context
        this._context.retryCount = 0;
        this._context.lastError = null;
        this._context.currentTrigger = null;
        break;
    }
  }

  private updateContextFromEvent(event: SyncEvent): void {
    switch (event.type) {
      case 'AUTH_SUCCESS':
        this._context.conditions.isAuthenticated = true;
        break;
      case 'AUTH_LOGOUT':
        this._context.conditions.isAuthenticated = false;
        break;
      case 'SYNC_ENABLED':
        this._context.conditions.syncSettingEnabled = true;
        break;
      case 'SYNC_DISABLED':
        this._context.conditions.syncSettingEnabled = false;
        break;
      case 'FEATURE_GRANTED':
        this._context.conditions.hasSyncFeature = true;
        break;
      case 'FEATURE_REVOKED':
        this._context.conditions.hasSyncFeature = false;
        break;
      case 'NETWORK_ONLINE':
        this._context.conditions.isOnline = true;
        break;
      case 'NETWORK_OFFLINE':
        this._context.conditions.isOnline = false;
        break;
      case 'SYNC_COMPLETE':
        this._context.lastSyncAt = Date.now();
        break;
    }
  }
}

// Export singleton type for type safety
export type SyncStateMachineEvents = {
  transition: (transition: SyncStateTransition) => void;
  'state:disabled': (transition: SyncStateTransition) => void;
  'state:idle': (transition: SyncStateTransition) => void;
  'state:syncing': (transition: SyncStateTransition) => void;
  'state:error': (transition: SyncStateTransition) => void;
};
