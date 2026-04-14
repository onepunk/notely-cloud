import { BrowserWindow } from 'electron';

import type {
  MeetingReminderState,
  MeetingReminderTriggerPayload,
} from '../../common/meetingReminder';
import { type IAuthService } from '../auth';
import { DEFAULT_API_URL } from '../config';
import { logger } from '../logger';
import { AuthManager } from '../managers/AuthManager';
import type { ExportService } from '../services/export';
import { type FeatureFlagsService } from '../services/featureFlags';
import { type HeartbeatService } from '../services/heartbeat/HeartbeatService';
import { LicenseService } from '../services/license/LicenseService';
import type { UpgradePollingService } from '../services/license/UpgradePollingService';
import { MeetingReminderManager } from '../services/MeetingReminderManager';
import { getKeystoreService } from '../services/security';
import { SummaryJobPoller } from '../services/SummaryJobPoller';
import { SummaryNotificationManager } from '../services/SummaryNotificationManager';
import { type UpdateService } from '../services/update';
import { type IStorageService } from '../storage/index';

import { AuthHandlers } from './AuthHandlers';
import { CalendarHandlers } from './CalendarHandlers';
import { DiagnosticsHandlers } from './DiagnosticsHandlers';
import { ExportHandlers } from './ExportHandlers';
import { LicenseHandlers } from './LicenseHandlers';
import { MeetingReminderHandlers } from './MeetingReminderHandlers';
import { SecurityHandlers } from './SecurityHandlers';
import { SettingsHandlers } from './SettingsHandlers';
import { StorageHandlers } from './StorageHandlers';
import { SummaryHandlers } from './SummaryHandlers';
import { SyncHandlers } from './SyncHandlers';
import { SyncVersionHandlers } from './SyncVersionHandlers';
import { SystemAudioHandlers } from './SystemAudioHandlers';
import { TagHandlers } from './TagHandlers';
import { TranscriptionHandlers } from './TranscriptionHandlers';
import { UpdateHandlers } from './UpdateHandlers';
import { WindowHandlers } from './WindowHandlers';

export interface IPCHandlerRegistryDependencies {
  storage: IStorageService;
  authService: IAuthService;
  authManager: AuthManager;
  mainWindow?: BrowserWindow | null;
  getActiveTranscriptionSessionId: () => string | null;
  setActiveTranscriptionSessionId: (sessionId: string | null) => void;
  restartTranscriptionServer?: () => Promise<void>;
  getTranscriptionServerPort?: () => number;
  refineTranscription?: (
    wavPath: string,
    hints?: string
  ) => Promise<{ text: string; used_hints?: boolean }>;
  meetingReminderManager?: MeetingReminderManager;
  showReminderWindow?: (
    payload: MeetingReminderTriggerPayload,
    state: MeetingReminderState
  ) => Promise<void>;
  hideReminderWindow?: () => void;
  licenseService: LicenseService;
  featureFlagsService: FeatureFlagsService;
  heartbeatService: HeartbeatService;
  upgradePollingService?: UpgradePollingService;
  updateService?: UpdateService;
  /** Base directory for storage (needed for security handlers) */
  baseDir?: string;
  /** Skip security handlers registration (if already registered early for password unlock) */
  skipSecurityHandlers?: boolean;
  /** Export service for note export functionality */
  exportService?: ExportService;
  /** Sync service for sync handlers */
  syncService?: {
    push?: () => Promise<{ success: boolean; processed: number }>;
    pull?: () => Promise<{ success: boolean; changes: number }>;
    [key: string]: unknown;
  } | null;
  /** Callback to trigger sync via lifecycle manager */
  triggerSync?: (trigger: 'manual') => void;
  /** Callback to check if sync is possible */
  canSync?: () => boolean;
  /** Callback to notify when local data changes (triggers debounced sync push) */
  onLocalChange?: () => void;
}

/**
 * IPCHandlerRegistry coordinates all IPC handler modules and provides
 * centralized registration, cleanup, and dependency management.
 *
 * This follows the registry pattern to organize related handlers
 * and ensure proper lifecycle management.
 */
export class IPCHandlerRegistry {
  private storageHandlers: StorageHandlers;
  private settingsHandlers: SettingsHandlers;
  private summaryHandlers: SummaryHandlers;
  private transcriptionHandlers: TranscriptionHandlers;
  private windowHandlers: WindowHandlers;
  private summaryJobPoller: SummaryJobPoller;
  private summaryNotificationManager: SummaryNotificationManager;
  private calendarHandlers: CalendarHandlers;
  private licenseHandlers: LicenseHandlers;
  private meetingReminderHandlers?: MeetingReminderHandlers;
  private meetingReminderManager?: MeetingReminderManager;
  private authHandlers: AuthHandlers;
  private updateHandlers?: UpdateHandlers;
  private systemAudioHandlers: SystemAudioHandlers;
  private tagHandlers: TagHandlers;
  private securityHandlers?: SecurityHandlers;
  private exportHandlers?: ExportHandlers;
  private diagnosticsHandlers: DiagnosticsHandlers;
  private syncHandlers: SyncHandlers;
  private syncVersionHandlers: SyncVersionHandlers;

  constructor(private deps: IPCHandlerRegistryDependencies) {
    logger.debug('IPCHandlerRegistry: Initializing handler modules');

    // Initialize summary services
    this.summaryNotificationManager = new SummaryNotificationManager({
      mainWindow: deps.mainWindow || null,
    });

    this.summaryJobPoller = new SummaryJobPoller({
      getAuthToken: async () => {
        try {
          const keystoreService = getKeystoreService();
          const accessToken = await keystoreService.getAccessToken();
          return accessToken || null;
        } catch (error) {
          logger.error('IPCHandlerRegistry: Failed to get auth token', { error });
          return null;
        }
      },
      getServerUrl: async () => {
        try {
          const serverUrl = await deps.storage.settings.get('auth.serverUrl');
          if (!serverUrl) {
            logger.warn('IPCHandlerRegistry: auth.serverUrl not configured, using default API URL');
            return DEFAULT_API_URL;
          }
          return serverUrl;
        } catch (error) {
          logger.error('IPCHandlerRegistry: Failed to get server URL, using default API URL', {
            error,
          });
          return DEFAULT_API_URL;
        }
      },
    });

    // Initialize all handler modules with their dependencies
    this.storageHandlers = new StorageHandlers({
      storage: deps.storage,
      mainWindow: deps.mainWindow || null,
      onLocalChange: deps.onLocalChange,
    });

    this.settingsHandlers = new SettingsHandlers({
      storage: deps.storage,
      mainWindow: deps.mainWindow || null,
      authProvider: deps.authService,
    });

    this.summaryHandlers = new SummaryHandlers({
      storage: deps.storage,
      notificationManager: this.summaryNotificationManager,
      syncPush: deps.syncService?.push
        ? async () => {
            const result = await deps.syncService!.push!();
            return { success: result.success };
          }
        : undefined,
    });

    this.transcriptionHandlers = new TranscriptionHandlers({
      storage: deps.storage,
      getActiveTranscriptionSessionId: deps.getActiveTranscriptionSessionId,
      setActiveTranscriptionSessionId: deps.setActiveTranscriptionSessionId,
      restartTranscriptionServer: deps.restartTranscriptionServer,
      getTranscriptionServerPort: deps.getTranscriptionServerPort,
      refineTranscription: deps.refineTranscription,
      mainWindow: deps.mainWindow,
    });

    this.windowHandlers = new WindowHandlers({
      mainWindow: deps.mainWindow || null,
      onRendererReady: this.handleRendererReady.bind(this),
      settings: deps.storage.settings,
    });

    this.calendarHandlers = new CalendarHandlers({
      authProvider: deps.authService,
      mainWindow: deps.mainWindow || null,
      calendarService: deps.storage.calendarEvents,
    });

    if (deps.meetingReminderManager) {
      this.meetingReminderManager = deps.meetingReminderManager;
      this.meetingReminderHandlers = new MeetingReminderHandlers({
        mainWindow: deps.mainWindow || null,
        meetingReminderManager: deps.meetingReminderManager,
        storage: deps.storage,
        showReminderWindow: deps.showReminderWindow,
        hideReminderWindow: deps.hideReminderWindow,
      });
    }

    this.licenseHandlers = new LicenseHandlers({
      licenseService: deps.licenseService,
      featureFlagsService: deps.featureFlagsService,
      heartbeatService: deps.heartbeatService,
      upgradePollingService: deps.upgradePollingService,
      mainWindow: deps.mainWindow || null,
    });

    this.authHandlers = new AuthHandlers({
      authService: deps.authService,
      authManager: deps.authManager,
    });

    // Initialize UpdateHandlers if updateService is provided
    if (deps.updateService) {
      this.updateHandlers = new UpdateHandlers({
        updateService: deps.updateService,
        mainWindow: deps.mainWindow || null,
      });
    }

    // Initialize SystemAudioHandlers for system audio capture
    this.systemAudioHandlers = new SystemAudioHandlers();

    // Initialize TagHandlers
    this.tagHandlers = new TagHandlers({
      storage: deps.storage,
      mainWindow: deps.mainWindow || null,
      onLocalChange: deps.onLocalChange,
    });

    // Initialize SecurityHandlers if baseDir is provided and not skipped
    // Security handlers may be registered early for password unlock flow
    if (deps.baseDir && !deps.skipSecurityHandlers) {
      this.securityHandlers = new SecurityHandlers({
        mainWindow: deps.mainWindow || null,
        baseDir: deps.baseDir,
      });
    }

    // Initialize ExportHandlers if exportService is provided
    if (deps.exportService) {
      this.exportHandlers = new ExportHandlers({
        exportService: deps.exportService,
      });
    }

    // Initialize DiagnosticsHandlers (reuses auth token and server URL closures from SummaryJobPoller)
    this.diagnosticsHandlers = new DiagnosticsHandlers({
      getAuthToken: async () => {
        try {
          const keystoreService = getKeystoreService();
          const accessToken = await keystoreService.getAccessToken();
          return accessToken || null;
        } catch (error) {
          logger.error('IPCHandlerRegistry: Failed to get auth token for diagnostics', { error });
          return null;
        }
      },
      getServerUrl: async () => {
        try {
          const serverUrl = await deps.storage.settings.get('auth.serverUrl');
          if (!serverUrl) {
            return DEFAULT_API_URL;
          }
          return serverUrl;
        } catch (error) {
          logger.error('IPCHandlerRegistry: Failed to get server URL for diagnostics', { error });
          return DEFAULT_API_URL;
        }
      },
    });

    // Initialize SyncHandlers and SyncVersionHandlers
    this.syncHandlers = new SyncHandlers({
      storage: deps.storage,
      authService: deps.authService,
      syncService: deps.syncService,
      triggerSync: deps.triggerSync,
      canSync: deps.canSync,
    });

    this.syncVersionHandlers = new SyncVersionHandlers({
      storage: deps.storage,
      mainWindow: deps.mainWindow || null,
    });

    logger.debug('IPCHandlerRegistry: All handler modules initialized');
  }

  /**
   * Register all IPC handlers across all modules
   */
  registerAll(): void {
    logger.debug('IPCHandlerRegistry: Registering all IPC handlers');

    try {
      // Register each handler module
      this.storageHandlers.register();
      this.settingsHandlers.register();
      this.summaryHandlers.register();
      this.transcriptionHandlers.register();
      this.windowHandlers.register();
      this.calendarHandlers.register();
      this.licenseHandlers.register();
      this.authHandlers.register();
      this.meetingReminderHandlers?.register();
      this.updateHandlers?.register();
      this.systemAudioHandlers.register();
      this.tagHandlers.register();
      this.securityHandlers?.register();
      this.exportHandlers?.register();
      this.diagnosticsHandlers.register();
      this.syncHandlers.register();
      this.syncVersionHandlers.register();

      logger.debug('IPCHandlerRegistry: All IPC handlers registered successfully');
    } catch (error) {
      logger.error('IPCHandlerRegistry: Failed to register IPC handlers', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Update main window reference across all handlers that need it
   */
  updateMainWindow(mainWindow: BrowserWindow | null): void {
    logger.debug('IPCHandlerRegistry: Updating main window reference across handlers');

    try {
      // Update all handlers that need the main window reference
      this.storageHandlers['deps'].mainWindow = mainWindow;
      this.settingsHandlers['deps'].mainWindow = mainWindow;
      this.windowHandlers.updateMainWindow(mainWindow);
      this.calendarHandlers.updateMainWindow(mainWindow);
      this.licenseHandlers.updateMainWindow(mainWindow);
      this.meetingReminderHandlers?.updateMainWindow(mainWindow);
      this.updateHandlers?.updateMainWindow(mainWindow);
      this.tagHandlers['deps'].mainWindow = mainWindow;
      this.securityHandlers?.updateMainWindow(mainWindow);

      // Update summary services with new main window
      this.summaryNotificationManager['deps'].mainWindow = mainWindow;

      // Also update AuthManager if it exists
      if (this.deps.authManager && mainWindow) {
        this.deps.authManager['options'].mainWindow = mainWindow;
      }

      logger.debug('IPCHandlerRegistry: Main window reference updated successfully');
    } catch (error) {
      logger.error('IPCHandlerRegistry: Failed to update main window reference', {
        error: error instanceof Error ? error.message : error,
      });
      // Don't throw as this isn't critical for startup
    }
  }

  /**
   * Handle renderer ready event - coordinate across modules
   */
  private handleRendererReady(): void {
    try {
      logger.debug('IPCHandlerRegistry: Handling renderer ready event');

      // Send settings hydration
      this.settingsHandlers.sendSettingsHydration();

      // Handle pending deep links via AuthManager
      if (this.deps.authManager) {
        this.deps.authManager.handlePendingDeepLink();
      }

      // Start calendar auto-sync if calendar is connected
      this.calendarHandlers.startAutoSync().catch((error) => {
        logger.debug('IPCHandlerRegistry: Calendar auto-sync start failed (may not be connected)', {
          error: error instanceof Error ? error.message : error,
        });
      });

      logger.debug('IPCHandlerRegistry: Renderer ready event handled');
    } catch (error) {
      logger.error('IPCHandlerRegistry: Failed to handle renderer ready', {
        error: error instanceof Error ? error.message : error,
      });
      // Don't throw as this could prevent app startup
    }
  }

  /**
   * Get handler modules for direct access if needed
   */
  getHandlers() {
    return {
      storage: this.storageHandlers,
      settings: this.settingsHandlers,
      summary: this.summaryHandlers,
      transcription: this.transcriptionHandlers,
      window: this.windowHandlers,
      auth: this.authHandlers,
      meetingReminder: this.meetingReminderHandlers,
      license: this.licenseHandlers,
      update: this.updateHandlers,
      tags: this.tagHandlers,
      export: this.exportHandlers,
    };
  }

  /**
   * Get active transcription session info
   */
  getActiveTranscriptionInfo() {
    return this.transcriptionHandlers.getActiveSessionInfo();
  }

  /**
   * Cleanup all handlers and unregister IPC listeners
   */
  cleanup(): void {
    logger.debug('IPCHandlerRegistry: Starting cleanup of all IPC handlers');

    try {
      // Cleanup summary services first
      this.summaryJobPoller.stopAllPolling();

      // Stop calendar auto-sync
      this.calendarHandlers.stopAutoSync();

      // Cleanup each handler module
      this.storageHandlers.cleanup();
      this.settingsHandlers.cleanup();
      this.summaryHandlers.cleanup();
      this.transcriptionHandlers.cleanup();
      this.windowHandlers.cleanup();
      this.licenseHandlers.cleanup();
      this.meetingReminderHandlers?.cleanup();
      this.updateHandlers?.cleanup();
      this.systemAudioHandlers.cleanup();
      this.tagHandlers.cleanup();
      this.securityHandlers?.cleanup();
      this.exportHandlers?.cleanup();
      this.diagnosticsHandlers.cleanup();
      this.syncHandlers.cleanup();
      this.syncVersionHandlers.cleanup();

      logger.debug('IPCHandlerRegistry: All IPC handlers cleaned up successfully');
    } catch (error) {
      logger.error('IPCHandlerRegistry: Error during IPC handlers cleanup', {
        error: error instanceof Error ? error.message : error,
      });
      // Continue cleanup even if some handlers fail
    }
  }
}

// Export handler types for external use
export type {
  StorageHandlers,
  SettingsHandlers,
  SummaryHandlers,
  TranscriptionHandlers,
  WindowHandlers,
  TagHandlers,
};
