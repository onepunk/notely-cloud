import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { net } from 'electron';

import { AuthService, type IAuthService } from '../auth';
import { logger } from '../logger';
import { type FeatureFlagsService, KnownFeatures } from '../services/featureFlags';
import type { CertificatePinningService } from '../services/security';
import { type IStorageService } from '../storage';

import { DebouncedSyncTrigger } from './services/DebouncedSyncTrigger';
import type { SyncNotificationPayload } from './services/network/types';
import { WebSocketManager } from './services/network/WebSocketManager';
import { SyncStateMachine, type SyncStateTransition, type SyncTrigger } from './SyncStateMachine';

/**
 * SyncLifecycleManager
 *
 * This is the single coordinator for sync lifecycle. It:
 * 1. Listens to auth, feature flags, settings, and network events
 * 2. Translates them into state machine events
 * 3. Manages periodic sync and performs sync operations via SyncService
 *
 * All sync lifecycle decisions flow through the state machine.
 */

export interface SyncLifecycleManagerDeps {
  authService: IAuthService;
  featureFlagsService: FeatureFlagsService;
  storage: IStorageService;
  getSyncService: () => import('../SyncService').SyncService;
  /** Certificate pinning service for WebSocket TLS verification */
  certificatePinningService?: CertificatePinningService;
  /** Callback to notify renderer that data has changed (for UI refresh after sync) */
  onDataChanged?: () => void;
}

export class SyncLifecycleManager extends EventEmitter {
  private readonly stateMachine: SyncStateMachine;
  private readonly deps: SyncLifecycleManagerDeps;
  private retryTimeoutId: NodeJS.Timeout | null = null;
  private initialized = false;
  private periodicSyncIntervalId: NodeJS.Timeout | null = null;
  private readonly defaultSyncIntervalMs = 5 * 60 * 1000; // 5 minutes

  // WebSocket for real-time sync notifications
  private wsManager: WebSocketManager | null = null;
  private wsInitialized = false;

  // Debounced sync trigger for local changes
  private debouncedSyncTrigger: DebouncedSyncTrigger | null = null;

  // Store bound event handlers for cleanup
  private boundHandlers: {
    onTokenRefreshed?: () => void;
    onLogout?: () => void;
    onAuthenticated?: () => void;
    onFeaturesChanged?: (features: string[]) => void;
  } = {};

  constructor(deps: SyncLifecycleManagerDeps) {
    super();
    this.deps = deps;
    this.stateMachine = new SyncStateMachine();

    // Subscribe to state machine transitions
    this.stateMachine.on('transition', this.onStateTransition.bind(this));

    logger.info('[SyncLifecycleManager] Created');
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Initialize the lifecycle manager and wire up all event listeners.
   * Should be called once during app startup after all services are ready.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.warn('[SyncLifecycleManager] Already initialized');
      return;
    }

    logger.info('[SyncLifecycleManager] Initializing...');

    // Wire up event listeners
    this.setupAuthServiceListeners();
    this.setupFeatureFlagsListeners();
    this.setupNetworkListeners();

    // Evaluate initial conditions
    await this.evaluateInitialConditions();

    this.initialized = true;
    logger.info('[SyncLifecycleManager] Initialized', {
      state: this.stateMachine.state,
      conditions: this.stateMachine.context.conditions,
    });
  }

  /**
   * Trigger a sync operation
   */
  triggerSync(trigger: SyncTrigger): void {
    logger.info('[SyncLifecycleManager] Sync triggered', { trigger });
    this.stateMachine.send({ type: 'TRIGGER_SYNC', trigger });
  }

  /**
   * Notify that sync has completed successfully
   */
  notifySyncComplete(processedCount: number): void {
    this.stateMachine.send({ type: 'SYNC_COMPLETE', processedCount });
  }

  /**
   * Notify that sync has failed
   */
  notifySyncError(error: string, retryable: boolean = true): void {
    this.stateMachine.send({ type: 'SYNC_ERROR', error, retryable });
  }

  /**
   * Notify that a local change has occurred (note created, updated, deleted, etc.)
   * This will trigger a debounced sync to push changes to the server.
   */
  notifyLocalChange(): void {
    if (!this.debouncedSyncTrigger) {
      // Initialize debounced trigger on first use
      this.debouncedSyncTrigger = new DebouncedSyncTrigger(() => this.triggerSync('local_change'), {
        debounceMs: 2000, // 2 seconds after last change
        maxWaitMs: 10000, // Force sync after 10 seconds max
      });
    }

    this.debouncedSyncTrigger.notifyChange();
  }

  /**
   * Flush any pending local changes immediately (e.g., on app blur)
   */
  flushPendingChanges(): void {
    if (this.debouncedSyncTrigger?.hasPendingChanges()) {
      logger.info('[SyncLifecycleManager] Flushing pending changes');
      this.debouncedSyncTrigger.flush();
    }
  }

  /**
   * Re-evaluate sync enabled setting (call when setting might have changed)
   */
  async reevaluateSyncSetting(): Promise<void> {
    const syncEnabled = await this.deps.storage.settings.get('syncEnabled');
    const isEnabled = syncEnabled === 'true';

    logger.debug('[SyncLifecycleManager] Re-evaluating sync setting', { isEnabled });

    if (isEnabled) {
      this.stateMachine.send({ type: 'SYNC_ENABLED' });
    } else {
      this.stateMachine.send({ type: 'SYNC_DISABLED' });
    }
  }

  /**
   * Get current state machine state
   */
  get state() {
    return this.stateMachine.state;
  }

  /**
   * Check if sync is currently possible
   */
  get canSync() {
    return this.stateMachine.canSync;
  }

  /**
   * Check if currently syncing
   */
  get isSyncing() {
    return this.stateMachine.isSyncing;
  }

  /**
   * Shutdown the lifecycle manager
   */
  async shutdown(): Promise<void> {
    logger.info('[SyncLifecycleManager] Shutting down...');

    // Clear any pending retry timer
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    // Clear periodic sync interval
    if (this.periodicSyncIntervalId) {
      clearInterval(this.periodicSyncIntervalId);
      this.periodicSyncIntervalId = null;
    }

    // Clean up debounced sync trigger
    if (this.debouncedSyncTrigger) {
      this.debouncedSyncTrigger.destroy();
      this.debouncedSyncTrigger = null;
    }

    // Clean up WebSocket connection
    if (this.wsManager) {
      try {
        this.wsManager.destroy();
      } catch (error) {
        logger.warn('[SyncLifecycleManager] Failed to destroy WebSocket during shutdown', {
          error: error instanceof Error ? error.message : error,
        });
      }
      this.wsManager = null;
      this.wsInitialized = false;
    }

    // Remove event listeners to prevent memory leaks
    this.cleanupEventListeners();

    this.initialized = false;
    logger.info('[SyncLifecycleManager] Shutdown complete');
  }

  /**
   * Remove all event listeners to prevent memory leaks
   */
  private cleanupEventListeners(): void {
    const authService = this.deps.authService as unknown as EventEmitter;
    const featureFlagsService = this.deps.featureFlagsService as unknown as EventEmitter;

    // Remove auth service listeners
    if (this.boundHandlers.onTokenRefreshed) {
      authService.off('token-refreshed', this.boundHandlers.onTokenRefreshed);
    }
    if (this.boundHandlers.onLogout) {
      authService.off('logout', this.boundHandlers.onLogout);
    }
    if (this.boundHandlers.onAuthenticated) {
      authService.off('authenticated', this.boundHandlers.onAuthenticated);
    }

    // Remove feature flags listener
    if (this.boundHandlers.onFeaturesChanged) {
      featureFlagsService.off('features-changed', this.boundHandlers.onFeaturesChanged);
    }

    // Clear handler references
    this.boundHandlers = {};

    logger.debug('[SyncLifecycleManager] Event listeners cleaned up');
  }

  // ============================================================================
  // Event Listeners Setup
  // ============================================================================

  private setupAuthServiceListeners(): void {
    // AuthService extends EventEmitter, cast to access event methods
    const authService = this.deps.authService as unknown as EventEmitter;

    // Create bound handlers for cleanup
    this.boundHandlers.onTokenRefreshed = () => {
      logger.debug('[SyncLifecycleManager] Token refreshed event');
      this.stateMachine.send({ type: 'AUTH_SUCCESS' });
    };

    this.boundHandlers.onLogout = () => {
      logger.debug('[SyncLifecycleManager] Logout event');
      this.stateMachine.send({ type: 'AUTH_LOGOUT' });
    };

    this.boundHandlers.onAuthenticated = () => {
      logger.debug('[SyncLifecycleManager] Authenticated event');
      this.stateMachine.send({ type: 'AUTH_SUCCESS' });
    };

    // Register listeners
    authService.on('token-refreshed', this.boundHandlers.onTokenRefreshed);
    authService.on('logout', this.boundHandlers.onLogout);
    authService.on('authenticated', this.boundHandlers.onAuthenticated);
  }

  private setupFeatureFlagsListeners(): void {
    const featureFlagsService = this.deps.featureFlagsService as unknown as EventEmitter;

    // Create bound handler for cleanup
    this.boundHandlers.onFeaturesChanged = (features: string[]) => {
      logger.debug('[SyncLifecycleManager] Features changed', { features });

      const hasSyncFeature = features.includes(KnownFeatures.CROSS_DEVICE_SYNC);
      if (hasSyncFeature) {
        this.stateMachine.send({ type: 'FEATURE_GRANTED' });
        // FeatureFlagsService auto-enables sync when cross-device-sync feature is granted
        // Re-evaluate sync setting after a small delay to catch the auto-enable
        setTimeout(() => {
          void this.reevaluateSyncSetting();
        }, 100);
      } else {
        this.stateMachine.send({ type: 'FEATURE_REVOKED' });
      }
    };

    // Register listener
    featureFlagsService.on('features-changed', this.boundHandlers.onFeaturesChanged);
  }

  private setupNetworkListeners(): void {
    // Network status is typically monitored via Electron's online/offline events
    // For now, we'll rely on external calls to update network status
    // The AppManager already has network monitoring that can call these methods
  }

  // ============================================================================
  // External Network Status Updates
  // ============================================================================

  /**
   * Call when network comes online
   */
  onNetworkOnline(): void {
    logger.debug('[SyncLifecycleManager] Network online');
    this.stateMachine.send({ type: 'NETWORK_ONLINE' });
  }

  /**
   * Call when network goes offline
   */
  onNetworkOffline(): void {
    logger.debug('[SyncLifecycleManager] Network offline');
    this.stateMachine.send({ type: 'NETWORK_OFFLINE' });
  }

  // ============================================================================
  // Initial Conditions Evaluation
  // ============================================================================

  private async evaluateInitialConditions(): Promise<void> {
    logger.debug('[SyncLifecycleManager] Evaluating initial conditions');

    // Check authentication status
    const authStatus = await this.deps.authService.getAuthStatus();
    const isAuthenticated = authStatus.isConfigured && authStatus.hasValidAccessToken;

    // Check feature flags
    const hasSyncFeature = this.deps.featureFlagsService.hasFeature(
      KnownFeatures.CROSS_DEVICE_SYNC
    );

    // Check sync setting
    const syncEnabled = await this.deps.storage.settings.get('syncEnabled');
    const syncSettingEnabled = syncEnabled === 'true';

    // Check actual network status using Electron's net module
    const isOnline = net.isOnline();

    logger.info('[SyncLifecycleManager] Initial conditions', {
      isAuthenticated,
      hasSyncFeature,
      syncSettingEnabled,
      isOnline,
    });

    // Set all conditions at once
    this.stateMachine.setConditions({
      isAuthenticated,
      hasSyncFeature,
      syncSettingEnabled,
      isOnline,
    });
  }

  // ============================================================================
  // State Transition Handler
  // ============================================================================

  private onStateTransition(transition: SyncStateTransition): void {
    logger.info('[SyncLifecycleManager] State transition', {
      from: transition.from,
      to: transition.to,
      event: transition.event.type,
    });

    // Handle state entry actions
    // Note: async handlers are intentionally fire-and-forget here because:
    // 1. State machine transitions must be synchronous
    // 2. The async operation (sync) will notify completion via notifySyncComplete/notifySyncError
    // 3. This prevents blocking the state machine
    switch (transition.to) {
      case 'idle':
        this.onEnterIdle(transition);
        break;
      case 'syncing':
        // Fire-and-forget: sync completion notifies state machine via notifySyncComplete/notifySyncError
        void this.onEnterSyncing(transition);
        break;
      case 'error':
        this.onEnterError(transition);
        break;
      case 'disabled':
        this.onEnterDisabled(transition);
        break;
    }

    // Emit transition for external observers
    this.emit('state-changed', {
      state: transition.to,
      previousState: transition.from,
      event: transition.event.type,
    });
  }

  private onEnterIdle(transition: SyncStateTransition): void {
    // Clear any retry timer
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    // Start periodic sync if not already running
    this.startPeriodicSync();

    // Initialize WebSocket for real-time sync notifications
    void this.initializeWebSocket();

    // If coming from disabled (first time enabling), trigger startup sync
    if (transition.from === 'disabled') {
      logger.info('[SyncLifecycleManager] Sync enabled, triggering startup sync');
      // Small delay to allow UI to settle
      setTimeout(() => {
        this.triggerSync('startup');
      }, 1000);
    }
  }

  private async onEnterSyncing(transition: SyncStateTransition): Promise<void> {
    const trigger = this.stateMachine.context.currentTrigger || 'manual';

    logger.info('[SyncLifecycleManager] Starting sync', { trigger });

    try {
      // Perform the actual sync using SyncService
      const syncService = this.deps.getSyncService();
      const result = await syncService.sync();

      if (result.success) {
        this.notifySyncComplete(result.processed || 0);

        // Notify renderer to refresh data views after successful sync
        // This ensures UI updates when server changes are applied
        if (this.deps.onDataChanged) {
          logger.debug('[SyncLifecycleManager] Notifying renderer of data change');
          this.deps.onDataChanged();
        }
      } else {
        this.notifySyncError(result.error || 'Unknown sync error', true);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[SyncLifecycleManager] Sync threw exception', { error: errorMessage });
      this.notifySyncError(errorMessage, true);
    }
  }

  private onEnterError(transition: SyncStateTransition): void {
    // Schedule retry
    const backoffDelay = this.stateMachine.getBackoffDelay();

    logger.info('[SyncLifecycleManager] Sync failed, scheduling retry', {
      retryCount: this.stateMachine.context.retryCount,
      backoffDelayMs: backoffDelay,
      error: this.stateMachine.context.lastError,
    });

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null;
      this.stateMachine.send({ type: 'RETRY_TIMER_EXPIRED' });
    }, backoffDelay);
  }

  private onEnterDisabled(transition: SyncStateTransition): void {
    // Stop periodic sync
    this.stopPeriodicSync();

    // Disconnect WebSocket
    this.destroyWebSocket();

    // Clear any retry timer
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }

    logger.info('[SyncLifecycleManager] Sync disabled', {
      conditions: this.stateMachine.context.conditions,
    });
  }

  // ============================================================================
  // Periodic Sync Management
  // ============================================================================

  private async startPeriodicSync(): Promise<void> {
    if (this.periodicSyncIntervalId) {
      return; // Already running
    }

    // Get interval from settings or use default
    const intervalSetting = await this.deps.storage.settings.get('sync.auto_sync_interval');
    const intervalMs = intervalSetting ? parseInt(intervalSetting, 10) : this.defaultSyncIntervalMs;

    logger.info('[SyncLifecycleManager] Starting periodic sync', { intervalMs });

    this.periodicSyncIntervalId = setInterval(() => {
      if (this.stateMachine.canSync) {
        this.triggerSync('periodic');
      }
    }, intervalMs);
  }

  private stopPeriodicSync(): void {
    if (this.periodicSyncIntervalId) {
      clearInterval(this.periodicSyncIntervalId);
      this.periodicSyncIntervalId = null;
      logger.info('[SyncLifecycleManager] Stopped periodic sync');
    }
  }

  // ============================================================================
  // WebSocket Real-Time Sync Notifications
  // ============================================================================

  /**
   * Initialize WebSocket connection for real-time sync notifications.
   * WebSocket triggers go through the state machine to ensure proper coordination.
   */
  private async initializeWebSocket(): Promise<void> {
    if (this.wsInitialized || this.wsManager) {
      return; // Already initialized
    }

    try {
      // Get auth context to determine WebSocket URL
      const authContext = await this.deps.authService.getAuthContext();
      if (!authContext?.serverUrl) {
        logger.debug('[SyncLifecycleManager] Cannot initialize WebSocket - no server URL');
        return;
      }

      // Derive WebSocket URL from server URL
      // e.g., https://api.yourdomain.com -> wss://ws.yourdomain.com
      const serverUrl = new URL(authContext.serverUrl);
      const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsHost = serverUrl.host.replace(/^api\./, 'ws.');
      const wsUrl = `${wsProtocol}//${wsHost}`;

      // Get or create device ID for WebSocket authentication.
      // The device ID must exist before connecting so the ws-gateway can distinguish
      // multiple devices for the same user. Without a unique device ID, all connections
      // register as "unknown-device" and the gateway replaces them (single-slot).
      const DEVICE_ID_KEY = 'sync.device_id';
      let deviceId = await this.deps.storage.settings.get(DEVICE_ID_KEY);
      if (!deviceId) {
        deviceId = randomUUID();
        await this.deps.storage.settings.set(DEVICE_ID_KEY, deviceId);
        logger.info('[SyncLifecycleManager] Created device ID for WebSocket auth', {
          deviceId: deviceId.substring(0, 8) + '...',
        });
      }

      logger.info('[SyncLifecycleManager] Initializing WebSocket', {
        wsUrl,
        deviceId: deviceId.substring(0, 8) + '...',
      });

      // Create WebSocket manager with config that provides auth info
      this.wsManager = new WebSocketManager(
        {
          getAccessToken: async () => {
            const ctx = await this.deps.authService.getAuthContext();
            return ctx?.accessToken || '';
          },
          getDeviceId: () => deviceId,
        },
        this.deps.authService as AuthService,
        this.deps.certificatePinningService
      );

      // Set up event handlers
      this.wsManager.on('sync:needed', (payload: SyncNotificationPayload) => {
        logger.info('[SyncLifecycleManager] WebSocket sync notification received', payload);
        // Route through state machine - it will check if sync is possible
        this.stateMachine.send({ type: 'TRIGGER_SYNC', trigger: 'websocket' });
      });

      this.wsManager.on('connected', () => {
        logger.info('[SyncLifecycleManager] WebSocket connected');
      });

      this.wsManager.on('disconnected', (event: { code: number; reason: string }) => {
        logger.debug('[SyncLifecycleManager] WebSocket disconnected', event);
      });

      this.wsManager.on('reconnect-failed', (event: { attempts: number }) => {
        logger.warn('[SyncLifecycleManager] WebSocket reconnect failed', event);
        // Don't disable sync - periodic sync will continue
      });

      this.wsManager.on('error', (error: Error) => {
        logger.error('[SyncLifecycleManager] WebSocket error', {
          error: error.message,
        });
      });

      // Connect to WebSocket server
      await this.wsManager.connect(wsUrl);
      this.wsInitialized = true;
    } catch (error) {
      logger.error('[SyncLifecycleManager] Failed to initialize WebSocket', {
        error: error instanceof Error ? error.message : error,
      });
      // Don't throw - WebSocket is optional, periodic sync will continue
    }
  }

  /**
   * Clean up WebSocket connection
   */
  private destroyWebSocket(): void {
    if (this.wsManager) {
      try {
        this.wsManager.destroy();
      } catch (error) {
        logger.warn('[SyncLifecycleManager] Error destroying WebSocket', {
          error: error instanceof Error ? error.message : error,
        });
      }
      this.wsManager = null;
      this.wsInitialized = false;
      logger.info('[SyncLifecycleManager] WebSocket destroyed');
    }
  }

  // ============================================================================
  // Pre-quit Sync
  // ============================================================================

  /**
   * Perform a sync before app quits (best effort)
   */
  async syncBeforeQuit(): Promise<void> {
    if (!this.stateMachine.canSync) {
      logger.info('[SyncLifecycleManager] Cannot sync before quit - not in idle state');
      return;
    }

    logger.info('[SyncLifecycleManager] Performing pre-quit sync');

    try {
      const syncService = this.deps.getSyncService();
      const result = await syncService.sync();

      if (result.success) {
        logger.info('[SyncLifecycleManager] Pre-quit sync completed', {
          processed: result.processed,
        });
      } else {
        logger.warn('[SyncLifecycleManager] Pre-quit sync failed', {
          error: result.error,
        });
      }
    } catch (error) {
      logger.error('[SyncLifecycleManager] Pre-quit sync error', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
