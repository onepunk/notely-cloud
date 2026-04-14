import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'path';

import { app, BrowserWindow, dialog, Menu, net } from 'electron';

import { TRANSCRIPTION_CONFIG } from '../common/config';

import { systemAudioService } from './audio/SystemAudioService';
import { AuthService } from './auth';
import { IPCHandlerRegistry } from './ipc';
import { ComponentHandlers } from './ipc/ComponentHandlers';
import { SecurityHandlers } from './ipc/SecurityHandlers';
import { logger, setupFileLogging, getLogFileDir } from './logger';
import { AuthManager } from './managers/AuthManager';
import { MacMenuManager } from './managers/MacMenuManager';
import { WindowManager } from './managers/WindowManager';
import {
  AuthValidationService,
  MeetingReminderManager,
  LicenseService,
  HeartbeatService,
  UpgradePollingService,
} from './services';
import type {
  MeetingReminderState,
  MeetingReminderTriggerPayload,
  LicensePayload,
} from './services';
import { ComponentManager } from './services/components';
import { ExportService } from './services/export';
import { FeatureFlagsServiceImpl } from './services/featureFlags';
import {
  CertificatePinningService,
  getKeystoreService,
  getPasswordProtectionService,
} from './services/security';
import { getKeytar } from './services/security/keytar';
import { UpdateService } from './services/update';
import { createStorageService, type IStorageService } from './storage/index';
import { SyncLifecycleManager } from './sync/SyncLifecycleManager';
import { SyncService } from './SyncService';
import { TranscriptionServerManager } from './transcriptionServer';

const PROTOCOL = 'notely';

interface AppManagerOptions {
  userDataPath: string;
  argv: string[];
}

export class AppManager {
  private storage!: IStorageService;
  private authService!: AuthService;
  private transcriptionServer!: TranscriptionServerManager;
  private authManager!: AuthManager;
  private windowManager!: WindowManager;
  private ipcRegistry!: IPCHandlerRegistry;
  private isShuttingDown = false;
  private activeTranscriptionSessionId: string | null = null;
  private meetingReminderManager!: MeetingReminderManager;
  private licenseService!: LicenseService;
  private featureFlagsService!: FeatureFlagsServiceImpl;
  private heartbeatService!: HeartbeatService;
  private updateService!: UpdateService;
  private upgradePollingService!: UpgradePollingService;
  private certificatePinningService!: CertificatePinningService;
  private securityHandlers!: SecurityHandlers;
  private exportService!: ExportService;
  private componentManager!: ComponentManager;
  private componentHandlers!: ComponentHandlers;
  private audioEngineSetupFailed = false;
  private syncService?: SyncService;
  private syncLifecycleManager?: SyncLifecycleManager;

  constructor(private options: AppManagerOptions) {}

  /**
   * Initialize the application and all its services.
   *
   * Initialization is organized into phases to optimize startup time:
   * - Phase 1-3: Setup without DB (allows transcription model to pre-load during password entry)
   * - Phase 4: Password protection check (model loading in parallel!)
   * - Phase 5-9: DB-dependent initialization and window creation
   */
  async initialize(): Promise<void> {
    try {
      // ========== Phase 1: Basic Setup (no DB needed) ==========
      setupFileLogging();
      logger.info('App ready. userData=%s', this.options.userDataPath);
      logger.debug('Logs dir: %s', getLogFileDir());

      // Fix permissions on existing user data directories (security hardening)
      this.fixUserDataPermissions();

      // Initialize system audio capture (must be early, before other services)
      await systemAudioService.initialize();

      // Initialize WindowManager early - needed for password unlock window
      this.initializeWindowManager();

      // Initialize ComponentManager for on-demand component downloads (production builds)
      // This must be done early so we can check if setup screen needs to be shown
      await this.initializeComponentManager();

      // ========== Phase 2: Security Setup (no DB needed) ==========
      // Initialize certificate pinning FIRST, before any network calls
      this.initializeCertificatePinning();

      // Ensure OS credential storage is available before touching keystore-backed services
      await this.ensureKeystoreAvailability();

      // ========== Phase 2.5: Ensure Audio Engine Binary (production only) ==========
      // In packaged builds, verify the audio-engine binary is present and valid.
      // Downloads it if missing or corrupted. Must complete before Phase 3 so
      // the transcription server can find the executable.
      await this.ensureAudioEngineReady();

      // ========== Phase 3: Start Transcription Server EARLY (no DB needed) ==========
      // This pre-loads the Whisper model in background while user enters password
      // Significantly reduces perceived startup time when password protection is enabled
      await this.startTranscriptionServerEarly();

      // ========== Phase 4: Password Protection Check ==========
      // Shows unlock window if needed - model is loading in parallel!
      await this.checkPasswordProtection();

      // ========== Phase 5: Open Database ==========
      // Now we have the encryption key (if password protected)
      await this.initializeDatabase();

      // ========== Phase 6: Update Transcription Settings ==========
      // Apply user's custom transcription settings from database (if any)
      await this.updateTranscriptionServerSettings();

      // ========== Phase 7: Initialize DB-Dependent Services ==========
      await this.initializeDbDependentServices();

      // ========== Phase 8: Complete Manager Initialization ==========
      await this.initializeManagers();

      // ========== Phase 9: Validate License and Auth ==========
      await this.validateStartupLicense();
      await this.validateStartupAuthentication();

      // ========== Phase 10: Setup IPC and Create Main Window ==========
      this.authService.startTokenRefreshTimer();
      this.setupIPCHandlers();
      await this.startMeetingReminderManager();
      await this.windowManager.createMainWindow();

      // Close the password unlock window now that the main window is ready
      // This avoids the window-all-closed race condition
      if (this.windowManager.hasPasswordUnlockWindow()) {
        logger.debug('AppManager: Closing password unlock window (main window is ready)');
        this.windowManager.closePasswordUnlockWindow();
      }

      // Setup native application menu
      if (process.platform === 'darwin') {
        const mainWindow = this.windowManager.getMainWindow();
        if (mainWindow) {
          new MacMenuManager(mainWindow.webContents);
          logger.info('MacMenuManager initialized');
        }
      } else {
        Menu.setApplicationMenu(null);
      }

      logger.info('Application initialization complete');
    } catch (error) {
      logger.error('Failed to initialize application', {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Initialize core data services.
   * @deprecated Use the individual methods (initializeCertificatePinning, initializeDatabase, initializeDbDependentServices) instead.
   * This method is kept for backwards compatibility but is no longer used by initialize().
   */
  private async initializeCoreServices(): Promise<void> {
    logger.debug('Initializing core services (legacy path)...');

    // Initialize certificate pinning FIRST, before any network calls
    this.initializeCertificatePinning();

    // Ensure OS credential storage is available before touching keystore-backed services
    await this.ensureKeystoreAvailability();

    // Check if password protection is enabled BEFORE initializing storage
    await this.checkPasswordProtection();

    // Initialize database
    await this.initializeDatabase();

    // Initialize all DB-dependent services
    await this.initializeDbDependentServices();

    logger.debug('Core services initialized');
  }

  /**
   * Fix permissions on existing user data directories for security.
   * This ensures that sensitive data (recordings, logs, config) is only accessible by the owner.
   * Called early in initialization to fix any files created with incorrect permissions.
   */
  private fixUserDataPermissions(): void {
    // Skip on Windows (permissions work differently)
    if (process.platform === 'win32') {
      return;
    }

    const userDataPath = this.options.userDataPath;
    const sensitiveDirectories = ['recordings', 'logs', 'config'];

    for (const dirName of sensitiveDirectories) {
      const dirPath = path.join(userDataPath, dirName);
      try {
        if (fs.existsSync(dirPath)) {
          // Fix directory permissions to 0700 (rwx------)
          fs.chmodSync(dirPath, 0o700);

          // Fix file permissions in the directory to 0600 (rw-------)
          const files = fs.readdirSync(dirPath);
          for (const file of files) {
            const filePath = path.join(dirPath, file);
            try {
              const stat = fs.statSync(filePath);
              if (stat.isFile()) {
                fs.chmodSync(filePath, 0o600);
              }
            } catch {
              // Ignore errors for individual files
            }
          }
          logger.debug('Fixed permissions for directory', { dirPath });
        }
      } catch (error) {
        // Log but don't fail - permissions may already be correct
        logger.debug('Could not fix permissions for directory', {
          dirPath,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  /**
   * Initialize certificate pinning service.
   * Must be called before any network calls to ensure all HTTPS connections are validated.
   */
  private initializeCertificatePinning(): void {
    this.certificatePinningService = new CertificatePinningService();
    this.certificatePinningService.initialize();

    // Set up pinning failure event handler to show security warning to user
    this.certificatePinningService.on('pinning-failed', (event) => {
      logger.error('SECURITY: Certificate pinning validation failed', event);

      // Show error dialog to user
      dialog.showErrorBox(
        'Security Warning',
        'Could not establish a secure connection to the server.\n\n' +
          'This may indicate a network security issue or that your connection is being intercepted.\n\n' +
          'Please check your network connection and try again. If this problem persists, contact support.'
      );

      // Also notify renderer if window is available
      const mainWindow = this.windowManager?.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('security:certificate-pinning-failed', event);
      }
    });

    logger.debug('Certificate pinning initialized', {
      enabled: this.certificatePinningService.isEnabled(),
      status: this.certificatePinningService.getStatus(),
    });
  }

  /**
   * Initialize the database/storage layer.
   * Called after password protection check to ensure we have the encryption key.
   */
  private async initializeDatabase(): Promise<void> {
    logger.debug('Opening database connection...');
    this.storage = createStorageService(this.options.userDataPath);
    await this.storage.initialize();
    await this.ensureServerUrl();
    logger.debug('Database initialized');
  }

  /**
   * Initialize all services that depend on the database being available.
   * This includes license, auth, feature flags, heartbeat, and update services.
   */
  private async initializeDbDependentServices(): Promise<void> {
    logger.debug('Initializing DB-dependent services...');

    // Initialize License Service first (needed by auth callback)
    this.licenseService = new LicenseService({
      settings: this.storage.settings,
    });
    await this.licenseService.initialize();

    // Initialize authentication service
    this.authService = new AuthService({
      storage: this.storage,
      userService: this.storage.users,
      onAuthSuccess: async () => {
        // Fetch license after successful authentication
        try {
          logger.debug('AppManager: Fetching license after successful authentication');
          await this.licenseService.fetchCurrentLicense();
          logger.debug('AppManager: License fetched successfully after authentication');

          // Link account to register desktop device
          try {
            logger.debug('AppManager: Linking account');
            await this.authService.linkAccount();
            logger.debug('AppManager: Account linked successfully');
          } catch (linkError) {
            logger.warn('AppManager: Failed to link account', {
              error: linkError instanceof Error ? linkError.message : linkError,
            });
            // Non-fatal - app can still function
          }
        } catch (error) {
          logger.warn('AppManager: Failed to fetch license after authentication', {
            error: error instanceof Error ? error.message : error,
          });
        }
      },
    });

    // Initialize Feature Flags Service
    this.featureFlagsService = new FeatureFlagsServiceImpl({
      licenseService: this.licenseService,
      settingsService: this.storage.settings,
    });
    await this.featureFlagsService.initialize();

    // Initialize HeartbeatService (will be started after license validation)
    this.heartbeatService = new HeartbeatService({
      settings: this.storage.settings,
      getAccessToken: async () => {
        try {
          const keystoreService = getKeystoreService();
          const accessToken = await keystoreService.getAccessToken();
          return accessToken || null;
        } catch (error) {
          logger.warn('AppManager: Failed to get access token for heartbeat', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
      getOrganizationId: async () => {
        try {
          // Try to get organization ID from settings
          let orgId = await this.storage.settings.get('auth.organizationId');
          if (!orgId) {
            orgId = await this.storage.settings.get('auth.organization_id');
          }
          if (!orgId) {
            // Extract from user ID if it contains org info
            const userId = await this.storage.settings.get('auth.userId');
            if (userId && typeof userId === 'string') {
              const match = userId.match(/^([^:]+):/);
              if (match) {
                orgId = match[1];
              }
            }
          }
          return orgId || null;
        } catch (error) {
          logger.warn('AppManager: Failed to get organization ID for heartbeat', {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
      getApiUrl: () => this.licenseService.resolveApiUrl(),
      clientVersion: app.getVersion(),
    });

    // Set up heartbeat event listeners
    this.setupHeartbeatEventListeners();

    // Initialize UpgradePollingService for detecting license upgrades after purchase
    this.upgradePollingService = new UpgradePollingService({
      licenseService: this.licenseService,
      settings: this.storage.settings,
    });
    await this.upgradePollingService.initialize();

    // Initialize UpdateService
    this.updateService = new UpdateService({
      settings: this.storage.settings,
    });

    // Initialize Sync Service and Lifecycle Manager
    try {
      this.syncService = new SyncService(this.storage, this.authService);
      this.syncLifecycleManager = new SyncLifecycleManager({
        authService: this.authService,
        featureFlagsService: this.featureFlagsService,
        storage: this.storage,
        getSyncService: () => this.syncService!,
        certificatePinningService: this.certificatePinningService,
        onDataChanged: () => {
          const wins = BrowserWindow.getAllWindows();
          for (const win of wins) {
            if (!win.isDestroyed()) {
              win.webContents.send('notes:changed');
              win.webContents.send('tags:changed');
              win.webContents.send('binders:changed');
              win.webContents.send('note-tags:changed');
            }
          }
        },
      });
      await this.syncLifecycleManager.initialize();
      logger.debug('Sync services initialized');
    } catch (error) {
      logger.warn('Failed to initialize sync services (non-fatal)', {
        error: error instanceof Error ? error.message : error,
      });
    }

    logger.debug('DB-dependent services initialized');
  }

  /**
   * Ensure server URL is configured with a default value if not set.
   * Users can change this via Settings > Server UI.
   */
  private async ensureServerUrl(): Promise<void> {
    try {
      const serverUrl = await this.storage.settings.get('auth.serverUrl');

      if (!serverUrl || serverUrl.trim() === '') {
        // Use DEFAULT_API_URL from config (environment-aware)
        const { DEFAULT_API_URL } = await import('./config');
        await this.storage.settings.set('auth.serverUrl', DEFAULT_API_URL);

        logger.debug('Server URL initialized with default', {
          defaultUrl: DEFAULT_API_URL,
        });
      } else {
        logger.debug('Server URL already configured', {
          serverUrl,
        });
      }
    } catch (error) {
      logger.error('Failed to ensure server URL', {
        error: error instanceof Error ? error.message : error,
      });
      // Non-fatal - app can still run
    }
  }

  /**
   * Initialize WindowManager early (needed for password unlock window)
   * This is called before initializeCoreServices to enable password protection flow.
   */
  private initializeWindowManager(): void {
    if (this.windowManager) {
      return; // Already initialized
    }

    logger.debug('Initializing WindowManager...');
    this.windowManager = new WindowManager({
      onWindowCreated: (window) => {
        this.onMainWindowCreated(window);
      },
      onWindowClosed: () => {
        this.onMainWindowClosed();
      },
    });
    logger.debug('WindowManager initialized');
  }

  /**
   * Initialize ComponentManager for on-demand component downloads.
   * In production builds, components (audio-engine binary and model files)
   * are downloaded on first run rather than bundled in the installer.
   */
  private async initializeComponentManager(): Promise<void> {
    logger.debug('Initializing ComponentManager...');

    this.componentManager = new ComponentManager();
    await this.componentManager.initialize();

    // Initialize ComponentHandlers early so setup screen can use IPC
    this.componentHandlers = new ComponentHandlers({
      componentManager: this.componentManager,
      mainWindow: null, // Will be updated when window is created
      onSetupRetryComplete: async () => {
        // After a successful retry download from the SetupScreen,
        // start the transcription server if it isn't already running
        if (!this.transcriptionServer?.getPort()) {
          await this.startTranscriptionServerEarly();
        }
      },
    });
    this.componentHandlers.register();

    logger.debug('ComponentManager initialized');
  }

  /**
   * Verify OS keystore availability and show a friendly error if unavailable.
   * This blocks startup because DB encryption and auth tokens require the keystore.
   */
  private async ensureKeystoreAvailability(): Promise<void> {
    // Skip keystore check when DEBUG_DB is enabled (encryption is disabled anyway)
    const debugDbEnabled = process.env.DEBUG_DB === 'true' || process.env.DEBUG_DB === '1';
    if (debugDbEnabled) {
      logger.warn('AppManager: Skipping keystore availability check (DEBUG_DB mode)');
      return;
    }

    const keystoreService = getKeystoreService();
    const available = await keystoreService.isAvailable();

    if (!available) {
      await this.handleKeystoreUnavailable();
    }

    try {
      await this.verifyKeystoreWriteRead();
    } catch (error) {
      await this.handleKeystoreUnavailable(error);
    }
  }

  private async verifyKeystoreWriteRead(): Promise<void> {
    const keytar = await getKeytar();
    const serviceName = 'com.notely.desktop';
    const testAccount = '__notely_keystore_preflight__';
    const testValue = crypto.randomBytes(32).toString('hex');

    try {
      await keytar.setPassword(serviceName, testAccount, testValue);
      const retrieved = await keytar.getPassword(serviceName, testAccount);

      if (retrieved !== testValue) {
        throw new Error('Keystore read/write validation failed.');
      }
    } finally {
      try {
        await keytar.deletePassword(serviceName, testAccount);
      } catch (error) {
        logger.warn('AppManager: Failed to clean up keystore preflight entry', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  private async handleKeystoreUnavailable(error?: unknown): Promise<void> {
    const baseMessage =
      'Notely could not access the system credential store required to protect your data.';
    let detail = 'Secure credential storage is not available on this platform.';

    switch (process.platform) {
      case 'linux':
        detail =
          'Please ensure a Secret Service backend is installed and running (libsecret + GNOME Keyring or KWallet).';
        break;
      case 'darwin':
        detail =
          'Please make sure Keychain Access is available and your login keychain is unlocked.';
        break;
      case 'win32':
        detail =
          'Please ensure Windows Credential Manager is running and not blocked by system policy.';
        break;
      default:
        break;
    }

    const errorMessage = error instanceof Error ? error.message : error ? String(error) : '';
    const detailWithError = errorMessage ? `${detail}\n\nDetails: ${errorMessage}` : detail;

    logger.error('AppManager: Keystore unavailable; blocking startup', {
      platform: process.platform,
      error: errorMessage,
    });

    await dialog.showMessageBox({
      type: 'error',
      title: 'Secure Storage Unavailable',
      message: baseMessage,
      detail: detailWithError,
      buttons: ['Quit'],
      defaultId: 0,
    });

    throw new Error(`Keystore unavailable. ${detailWithError}`);
  }

  /**
   * Check if password protection is enabled and prompt for password if needed.
   * Must be called BEFORE storage/database initialization.
   */
  private async checkPasswordProtection(): Promise<void> {
    const passwordService = getPasswordProtectionService(this.options.userDataPath);

    // Quick sync check if password protection is enabled
    if (!passwordService.isPasswordProtectionEnabled()) {
      logger.debug('AppManager: Password protection not enabled, skipping unlock');
      return;
    }

    logger.debug('AppManager: Password protection is enabled, checking status...');

    // Get full status (async to check for cached/remembered key)
    const status = await passwordService.getStatus();

    if (!status.locked) {
      // Key is available (remembered or already verified)
      logger.debug('AppManager: Database already unlocked (remembered password or cached key)');
      return;
    }

    // Password is required - register security handlers early so unlock window can use IPC
    logger.debug('AppManager: Password required, registering early security handlers...');
    this.securityHandlers = new SecurityHandlers({
      mainWindow: null,
      baseDir: this.options.userDataPath,
      onPasswordUnlocked: () => {
        // Notify WindowManager to close unlock window and resolve the promise
        this.windowManager.notifyPasswordUnlocked();
      },
    });
    this.securityHandlers.register();

    // Show unlock window
    logger.debug('AppManager: Showing password unlock window...');

    const unlocked = await this.windowManager.showPasswordUnlockWindow();

    if (!unlocked) {
      // User cancelled or failed to unlock - cannot proceed
      logger.error('AppManager: Password unlock failed or cancelled, cannot start application');
      throw new Error('Password unlock required to access your notes.');
    }

    logger.debug('AppManager: Password verified, continuing initialization');
  }

  /**
   * Initialize managers with proper dependency injection
   */
  private async initializeManagers(): Promise<void> {
    logger.debug('Initializing managers...');

    // WindowManager already initialized in initializeWindowManager()

    // Initialize AuthManager with services and command line arguments
    this.authManager = new AuthManager({
      authService: this.authService,
      storage: this.storage,
      mainWindow: null, // Will be set when window is created
    });

    // Process command line arguments for Windows deep links
    this.authManager.initializeWithArgv(this.options.argv);

    // Initialize MeetingReminderManager (started post IPC registration)
    this.meetingReminderManager = new MeetingReminderManager({
      storage: this.storage,
      getActiveTranscriptionSessionId: () => this.activeTranscriptionSessionId,
    });

    const forwardReminderState = (state: MeetingReminderState) => {
      this.windowManager.sendMeetingReminderState(state);
    };

    this.meetingReminderManager.on('reminder-due', (payload: MeetingReminderTriggerPayload) => {
      const state = this.meetingReminderManager.getState();
      void this.windowManager.showMeetingReminderWindow(payload, state);
    });
    this.meetingReminderManager.on('state-changed', forwardReminderState);
    this.meetingReminderManager.on('schedule-updated', forwardReminderState);

    // Initialize ExportService for note export functionality
    this.exportService = new ExportService({
      noteService: this.storage.notes,
      transcriptionService: this.storage.transcriptions,
      summaryService: this.storage.summaries,
    });

    logger.debug('Managers initialized');
  }

  /**
   * Setup IPC handlers with all required dependencies
   */
  private setupIPCHandlers(): void {
    logger.debug('Setting up IPC handlers...');

    this.ipcRegistry = new IPCHandlerRegistry({
      storage: this.storage,
      authService: this.authService,
      authManager: this.authManager,
      mainWindow: null, // Will be updated when window is created
      getActiveTranscriptionSessionId: () => this.activeTranscriptionSessionId,
      setActiveTranscriptionSessionId: (sessionId) => {
        this.activeTranscriptionSessionId = sessionId;
      },
      restartTranscriptionServer: () => this.restartTranscriptionServer(),
      getTranscriptionServerPort: () => this.transcriptionServer.getPort(),
      refineTranscription: (wavPath: string, hints?: string) =>
        this.transcriptionServer.refineTranscription(wavPath, hints),
      meetingReminderManager: this.meetingReminderManager,
      showReminderWindow: (payload, state) =>
        this.windowManager.showMeetingReminderWindow(payload, state),
      hideReminderWindow: () => this.windowManager.hideMeetingReminderWindow(),
      licenseService: this.licenseService,
      featureFlagsService: this.featureFlagsService,
      heartbeatService: this.heartbeatService,
      upgradePollingService: this.upgradePollingService,
      updateService: this.updateService,
      // Base directory for security handlers (password protection, encryption)
      baseDir: this.options.userDataPath,
      // Skip security handlers if already registered early for password unlock flow
      skipSecurityHandlers: !!this.securityHandlers,
      // Export service for note export functionality
      exportService: this.exportService,
      // Sync service for sync handlers
      syncService: this.syncService || null,
      // Trigger debounced sync push when local data changes
      onLocalChange: () => {
        this.syncLifecycleManager?.notifyLocalChange();
      },
    });

    // Register all IPC handlers
    this.ipcRegistry.registerAll();

    logger.debug('IPC handlers registered');
  }

  /**
   * Migrate old PyTorch Whisper model names to faster-whisper format
   * Converts: whisper-base.en.pt -> base.en, tiny.en.pt -> tiny.en
   */
  private async migrateTranscriptionModelName(): Promise<void> {
    try {
      const modelName = (await this.storage.settings.get('transcription.model_name')) as
        | string
        | null;

      if (!modelName) {
        return; // No model name set, nothing to migrate
      }

      let needsMigration = false;
      let newModelName = modelName;

      // Remove 'whisper-' prefix (e.g., whisper-base.en.pt -> base.en.pt)
      if (newModelName.startsWith('whisper-')) {
        newModelName = newModelName.replace(/^whisper-/, '');
        needsMigration = true;
      }

      // Remove '.pt' extension (e.g., base.en.pt -> base.en)
      if (newModelName.endsWith('.pt')) {
        newModelName = newModelName.replace(/\.pt$/, '');
        needsMigration = true;
      }

      if (needsMigration) {
        logger.debug('Migrating transcription model name', {
          oldName: modelName,
          newName: newModelName,
        });
        await this.storage.settings.set('transcription.model_name', newModelName);
      }
    } catch (e) {
      logger.warn('Failed to migrate transcription model name', {
        e: e instanceof Error ? e.message : e,
      });
    }
  }

  /**
   * Start the transcription server
   */
  private async startTranscriptionServer(): Promise<void> {
    logger.debug('Starting transcription server...');

    // Migrate old model names to faster-whisper format
    await this.migrateTranscriptionModelName();

    // Read transcription settings to configure the server
    let modelName: string | null = null;
    let useGpu = false;
    try {
      modelName = (await this.storage.settings.get('transcription.model_name')) as string | null;
      const useGpuStr = (await this.storage.settings.get('transcription.use_gpu')) as string | null;
      useGpu = (useGpuStr || '').toLowerCase() === 'true';
    } catch (e) {
      logger.warn('Failed to read transcription settings; using defaults', {
        e: e instanceof Error ? e.message : e,
      });
    }

    this.transcriptionServer = new TranscriptionServerManager({
      // ComponentManager for on-demand downloaded binaries in production builds
      componentManager: this.componentManager,
      env: {
        // Model configuration (from user settings)
        NOTELY_MODEL_NAME: modelName || undefined,
        NOTELY_USE_GPU: useGpu ? 'true' : 'false',
        NOTELY_ENABLE_VAD: 'true',

        // Sliding Window Configuration (from TRANSCRIPTION_CONFIG)
        NOTELY_USE_SLIDING_WINDOW: TRANSCRIPTION_CONFIG.useSlidingWindow ? 'true' : 'false',
        NOTELY_WINDOW_SIZE_MS: String(TRANSCRIPTION_CONFIG.windowSizeMs),
        NOTELY_WINDOW_OVERLAP_MS: String(TRANSCRIPTION_CONFIG.windowOverlapMs),
        NOTELY_MAX_SEGMENT_LENGTH_MS: String(TRANSCRIPTION_CONFIG.maxSegmentLengthMs),

        // Refinement Configuration
        NOTELY_REFINEMENT_ENABLED: TRANSCRIPTION_CONFIG.refinementEnabled ? 'true' : 'false',
        NOTELY_REFINEMENT_DELAY_MS: String(TRANSCRIPTION_CONFIG.refinementDelayMs),
        NOTELY_REFINEMENT_BEAM_SIZE: String(TRANSCRIPTION_CONFIG.refinementBeamSize),
        NOTELY_REFINEMENT_TEMPERATURE: String(TRANSCRIPTION_CONFIG.refinementTemperature),
        NOTELY_REFINEMENT_WORKERS: String(TRANSCRIPTION_CONFIG.refinementWorkers),
        NOTELY_REFINEMENT_MAX_QUEUE_SIZE: String(TRANSCRIPTION_CONFIG.refinementMaxQueueSize),

        // VAD Configuration (tuned for better accuracy)
        NOTELY_VAD_THRESHOLD: String(TRANSCRIPTION_CONFIG.vadThreshold),
        NOTELY_VAD_MIN_SPEECH_MS: String(TRANSCRIPTION_CONFIG.vadMinSpeechDurationMs),
        NOTELY_VAD_MIN_SILENCE_MS: String(TRANSCRIPTION_CONFIG.vadMinSilenceDurationMs),
        NOTELY_VAD_SPEECH_PAD_MS: String(TRANSCRIPTION_CONFIG.vadSpeechPadMs),
        NOTELY_MIN_WINDOW_RMS: String(TRANSCRIPTION_CONFIG.minWindowRms),

        // Protocol Configuration (text stability)
        NOTELY_UNSTABLE_TOKEN_COUNT: String(TRANSCRIPTION_CONFIG.unstableTokenCount),
        NOTELY_HEARTBEAT_INTERVAL_MS: String(TRANSCRIPTION_CONFIG.heartbeatIntervalMs),

        // Hallucination / repetition filtering
        NOTELY_PARTIAL_REPETITION_MIN_WORDS: String(TRANSCRIPTION_CONFIG.repetitionFilterMinWords),
      },
    });

    try {
      await this.transcriptionServer.start();
      logger.debug('Transcription server started successfully');
    } catch (error) {
      logger.warn('Failed to start transcription server', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Start the meeting reminder manager service
   */
  private async startMeetingReminderManager(): Promise<void> {
    if (!this.meetingReminderManager) {
      logger.warn('MeetingReminderManager not initialized; skipping start');
      return;
    }

    logger.debug('Starting MeetingReminderManager...');
    try {
      await this.meetingReminderManager.start();
      logger.debug('MeetingReminderManager started');
    } catch (error) {
      logger.warn('Failed to start MeetingReminderManager', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Callback when main window is created
   */
  private onMainWindowCreated(window: BrowserWindow): void {
    logger.debug('Main window created, updating services...');

    // Update AuthManager with new window reference
    if (this.authManager) {
      this.authManager['options'].mainWindow = window;
    }

    // Update IPC registry with new window reference
    if (this.ipcRegistry) {
      this.ipcRegistry.updateMainWindow(window);
    }

    // Update early-registered SecurityHandlers with new window reference
    // (registered before IPCRegistry for password unlock flow)
    if (this.securityHandlers) {
      this.securityHandlers.updateMainWindow(window);
    }

    // Update early-registered ComponentHandlers with new window reference
    // (registered before IPCRegistry for setup screen flow)
    if (this.componentHandlers) {
      this.componentHandlers.updateMainWindow(window);
    }

    logger.debug('Services updated with main window reference');
  }

  /**
   * Callback when main window is closed
   */
  private onMainWindowClosed(): void {
    logger.debug('Main window closed via AppManager callback');
  }

  /**
   * Handle app activation (macOS dock icon click)
   */
  async handleActivate(): Promise<void> {
    const hasWindow = this.windowManager.isWindowAvailable();
    logger.debug('App activation requested, window exists: %s', hasWindow);

    // On macOS, re-create window when dock icon is clicked and no windows open
    if (BrowserWindow.getAllWindows().length === 0 && !this.isShuttingDown) {
      await this.windowManager.createMainWindow();
    }
  }

  /**
   * Gracefully shutdown all services
   */
  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      logger.debug('Shutdown already in progress, ignoring duplicate call');
      return;
    }

    this.isShuttingDown = true;
    logger.debug('Starting graceful shutdown...');

    try {
      // Stop token refresh timer
      if (this.authService) {
        try {
          this.authService.stopTokenRefreshTimer();
          logger.debug('Token refresh timer stopped');
        } catch (error) {
          logger.warn('Error stopping token refresh timer', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Stop transcription server first
      if (this.transcriptionServer) {
        try {
          await this.transcriptionServer.stop();
          logger.debug('Transcription server stopped');
        } catch (error) {
          logger.warn('Error stopping transcription server', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Shutdown sync lifecycle manager
      if (this.syncLifecycleManager) {
        try {
          await this.syncLifecycleManager.shutdown();
          logger.debug('SyncLifecycleManager shut down');
        } catch (error) {
          logger.warn('Error shutting down SyncLifecycleManager', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Cleanup IPC handlers
      if (this.ipcRegistry) {
        try {
          this.ipcRegistry.cleanup();
          logger.debug('IPC registry cleaned up');
        } catch (error) {
          logger.warn('Error cleaning up IPC registry', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Cleanup ComponentHandlers (registered early, before IPCRegistry)
      if (this.componentHandlers) {
        try {
          this.componentHandlers.cleanup();
          logger.debug('ComponentHandlers cleaned up');
        } catch (error) {
          logger.warn('Error cleaning up ComponentHandlers', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      if (this.meetingReminderManager) {
        try {
          this.meetingReminderManager.stop();
          logger.debug('MeetingReminderManager stopped');
        } catch (error) {
          logger.warn('Error stopping MeetingReminderManager', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Cleanup FeatureFlagsService
      if (this.featureFlagsService) {
        try {
          this.featureFlagsService.cleanup();
          logger.debug('FeatureFlagsService cleaned up');
        } catch (error) {
          logger.warn('Error cleaning up FeatureFlagsService', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Stop HeartbeatService
      if (this.heartbeatService) {
        try {
          this.heartbeatService.stop();
          logger.debug('HeartbeatService stopped');
        } catch (error) {
          logger.warn('Error stopping HeartbeatService', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Stop UpgradePollingService
      if (this.upgradePollingService) {
        try {
          await this.upgradePollingService.stopUpgradePolling();
          logger.debug('UpgradePollingService stopped');
        } catch (error) {
          logger.warn('Error stopping UpgradePollingService', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Cleanup AuthManager
      if (this.authManager) {
        try {
          this.authManager.destroy();
          logger.debug('AuthManager cleaned up');
        } catch (error) {
          logger.warn('Error cleaning up AuthManager', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Cleanup storage service
      if (this.storage) {
        try {
          await this.storage.close();
          logger.debug('Storage service closed');
        } catch (error) {
          logger.warn('Error closing storage service', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      // Cleanup WindowManager last
      if (this.windowManager) {
        try {
          this.windowManager.destroy();
          logger.debug('WindowManager cleaned up');
        } catch (error) {
          logger.warn('Error cleaning up WindowManager', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      logger.debug('Graceful shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Setup protocol handler for deep links
   */
  static setupProtocolHandler(): void {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  }

  /**
   * Validate authentication state during startup.
   * This ensures UI accurately reflects current auth status by checking
   * stored tokens against the server and clearing invalid state.
   */
  private async validateStartupAuthentication(): Promise<void> {
    logger.debug('AppManager: Validating startup authentication state...');

    try {
      const authValidator = new AuthValidationService(null, this.storage, this.authService);

      // Check if validation should be performed
      const shouldValidate = await authValidator.shouldValidateAuth();
      if (!shouldValidate) {
        logger.debug('AppManager: Skipping authentication validation');
        return;
      }

      // Perform the validation
      const authResult = await authValidator.validateStoredAuthState();

      logger.debug('AppManager: Startup auth validation completed', {
        isValid: authResult.isValid,
        reason: authResult.reason,
        action: authResult.action,
        hasError: !!authResult.error,
      });

      // Log additional details for troubleshooting
      if (authResult.details) {
        logger.debug('AppManager: Auth validation details', {
          details: authResult.details,
        });
      }

      if (authResult.error) {
        logger.warn('AppManager: Auth validation had network issues', {
          error: authResult.error,
        });
      }

      // The validation service has already updated the storage state
      // The renderer will pick up the current state when it loads

      // Perform post-authentication tasks if authentication is valid
      if (authResult.isValid) {
        // Ensure account is linked (handles existing users who logged in before linkAccount fix)
        const authStatus = await this.authService.getAuthStatus();
        if (!authStatus.deviceId) {
          logger.info('AppManager: Device ID missing, linking account...');
          try {
            const linkResult = await this.authService.linkAccount();
            if (linkResult.success) {
              logger.info('AppManager: Account linked successfully during startup');
            } else {
              logger.warn('AppManager: Failed to link account during startup', {
                error: linkResult.error,
              });
            }
          } catch (linkError) {
            logger.warn('AppManager: Error linking account during startup', {
              error: linkError instanceof Error ? linkError.message : linkError,
            });
          }
        }

        // Fetch license from server for authenticated users who may not have a cached license
        // This handles the case where user purchased a license but desktop hasn't fetched it yet
        try {
          logger.info('AppManager: Fetching license after auth validation');
          const license = await this.licenseService.fetchCurrentLicense();
          logger.info('AppManager: License fetched after auth validation', {
            status: license.status,
            type: license.type,
          });

          // Start heartbeat if license is now active
          if (license.status === 'active' || license.status === 'expiring') {
            await this.startHeartbeatIfNeeded(license);
          }
        } catch (licenseError) {
          logger.warn('AppManager: Failed to fetch license after auth validation', {
            error: licenseError instanceof Error ? licenseError.message : String(licenseError),
          });
          // Non-fatal - user can still use the app
        }
      }
    } catch (error) {
      logger.warn('AppManager: Failed to validate startup authentication', {
        error: error instanceof Error ? error.message : error,
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Don't fail app startup for auth validation errors
      // This ensures the app remains usable even if validation has issues
    }
  }

  /**
   * Validate license on application startup.
   * This performs online validation if network is available, otherwise falls back to offline validation.
   * Also starts the heartbeat service if license is active and user is authenticated.
   */
  private async validateStartupLicense(): Promise<void> {
    logger.info('AppManager: Validating startup license...');

    try {
      // Get cached license first
      const cachedLicense = await this.licenseService.getCurrentLicense();

      logger.info('AppManager: Cached license status', {
        status: cachedLicense.status,
        type: cachedLicense.type,
        validationMode: cachedLicense.validationMode,
        lastValidatedAt: cachedLicense.lastValidatedAt,
        expiresAt: cachedLicense.expiresAt,
      });

      // If no license or unlicensed, skip validation
      if (!cachedLicense || cachedLicense.status === 'unlicensed') {
        logger.info('AppManager: No license cached, skipping startup validation');
        return;
      }

      // Check if we should attempt online validation
      const shouldValidateOnline = this.shouldAttemptOnlineValidation(cachedLicense);

      if (shouldValidateOnline) {
        logger.info('AppManager: Attempting online license validation');

        try {
          // Check network connectivity first
          const isOnline = this.checkNetworkConnectivity();

          if (!isOnline) {
            logger.info('AppManager: No network connectivity, skipping online validation');
            await this.handleOfflineLicenseValidation(cachedLicense);
            return;
          }

          // Attempt online validation with timeout
          await this.performOnlineLicenseValidation(cachedLicense);
        } catch (error) {
          logger.warn('AppManager: Online license validation failed, falling back to offline', {
            error: error instanceof Error ? error.message : String(error),
          });

          // Fall back to offline validation
          await this.handleOfflineLicenseValidation(cachedLicense);
        }
      } else {
        logger.info('AppManager: Using cached license (validation not yet due)');
        await this.handleCachedLicenseValidation(cachedLicense);
      }
    } catch (error) {
      logger.error('AppManager: Failed to validate startup license', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Don't fail app startup for license validation errors
      // The app should remain usable with whatever license state we have cached
    }
  }

  /**
   * Check if we should attempt online validation based on cache age and next validation time
   */
  private shouldAttemptOnlineValidation(cachedLicense: LicensePayload): boolean {
    // Always attempt online validation if we've never validated online
    if (!cachedLicense.lastValidatedAt) {
      return true;
    }

    // Check if next validation is due
    if (cachedLicense.nextValidationAt) {
      const nextValidation = new Date(cachedLicense.nextValidationAt);
      const now = new Date();

      if (now >= nextValidation) {
        logger.info('AppManager: Online validation due', {
          nextValidationAt: cachedLicense.nextValidationAt,
          now: now.toISOString(),
        });
        return true;
      }
    }

    // Check cache age (validate if older than 24 hours)
    const lastValidated = new Date(cachedLicense.lastValidatedAt);
    const cacheAgeHours = (Date.now() - lastValidated.getTime()) / (1000 * 60 * 60);

    if (cacheAgeHours > 24) {
      logger.info('AppManager: Cache is old, attempting online validation', {
        cacheAgeHours: cacheAgeHours.toFixed(2),
      });
      return true;
    }

    return false;
  }

  /**
   * Check network connectivity
   */
  private checkNetworkConnectivity(): boolean {
    try {
      // Use Electron's net module to check connectivity
      const isOnline = net.isOnline();
      logger.info('AppManager: Network connectivity check', { isOnline });
      return isOnline;
    } catch (error) {
      logger.warn('AppManager: Failed to check network connectivity', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Perform online license validation with timeout
   */
  private async performOnlineLicenseValidation(cachedLicense: LicensePayload): Promise<void> {
    // Get the stored license key from cache
    const storedKey = await this.licenseService.getStoredLicenseKey();

    if (!storedKey) {
      logger.warn('AppManager: No license key in cache, cannot perform online validation');
      await this.handleOfflineLicenseValidation(cachedLicense);
      return;
    }

    try {
      // Perform online validation with timeout
      const validationPromise = this.licenseService.validateLicense(storedKey);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Online validation timeout')), 10000); // 10 second timeout
      });

      const validatedLicense = await Promise.race([validationPromise, timeoutPromise]);

      logger.info('AppManager: Online license validation successful', {
        status: validatedLicense.status,
        type: validatedLicense.type,
        expiresAt: validatedLicense.expiresAt,
      });

      // Start heartbeat service if license is active
      await this.startHeartbeatIfNeeded(validatedLicense);

      // Log any warnings about expiring license
      this.logLicenseWarnings(validatedLicense);
    } catch (error) {
      logger.error('AppManager: Online license validation failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fall back to offline validation
      await this.handleOfflineLicenseValidation(cachedLicense);
      throw error;
    }
  }

  /**
   * Handle offline license validation using cached data
   */
  private async handleOfflineLicenseValidation(cachedLicense: LicensePayload): Promise<void> {
    logger.info('AppManager: Using cached license for offline validation');

    // Check cache age and log warnings
    const cacheAge = this.getCacheAgeDays(cachedLicense);

    if (cacheAge > 5) {
      logger.warn('AppManager: License cache is old (offline mode)', {
        cacheAgeDays: cacheAge.toFixed(1),
        lastValidatedAt: cachedLicense.lastValidatedAt,
      });
    }

    // Check if license is expired
    if (cachedLicense.expiresAt) {
      const expiryDate = new Date(cachedLicense.expiresAt);
      const now = new Date();

      if (now > expiryDate) {
        logger.warn('AppManager: Cached license has expired', {
          expiresAt: cachedLicense.expiresAt,
          now: now.toISOString(),
        });
      }
    }

    // Start heartbeat service if license is active (will pause immediately if offline)
    await this.startHeartbeatIfNeeded(cachedLicense);

    // Log license warnings
    this.logLicenseWarnings(cachedLicense);
  }

  /**
   * Handle validation using only cached license (no online check needed)
   */
  private async handleCachedLicenseValidation(cachedLicense: LicensePayload): Promise<void> {
    logger.info('AppManager: Using cached license (validation not yet due)');

    // Start heartbeat service if license is active
    await this.startHeartbeatIfNeeded(cachedLicense);

    // Log license warnings
    this.logLicenseWarnings(cachedLicense);
  }

  /**
   * Get cache age in days
   */
  private getCacheAgeDays(license: LicensePayload): number {
    if (!license.lastValidatedAt) {
      return Infinity;
    }

    const lastValidated = new Date(license.lastValidatedAt);
    return (Date.now() - lastValidated.getTime()) / (1000 * 60 * 60 * 24);
  }

  /**
   * Log warnings about license status
   */
  private logLicenseWarnings(license: LicensePayload): void {
    // Check for expiring license
    if (license.expiresAt) {
      const expiryDate = new Date(license.expiresAt);
      const now = new Date();
      const daysUntilExpiry = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

      if (daysUntilExpiry <= 7 && daysUntilExpiry > 0) {
        logger.warn('AppManager: License expiring soon', {
          expiresAt: license.expiresAt,
          daysUntilExpiry: daysUntilExpiry.toFixed(1),
        });
      }
    }

    // Check for old cache
    const cacheAge = this.getCacheAgeDays(license);
    if (cacheAge > 5) {
      logger.warn('AppManager: License cache is old', {
        cacheAgeDays: cacheAge.toFixed(1),
        lastValidatedAt: license.lastValidatedAt,
      });
    }

    // Log expired status
    if (license.status === 'expired') {
      logger.warn('AppManager: License is expired', {
        expiresAt: license.expiresAt,
        status: license.status,
      });
    }

    // Log invalid status
    if (license.status === 'invalid') {
      logger.error('AppManager: License is invalid', {
        status: license.status,
        statusMessage: license.statusMessage,
      });
    }
  }

  /**
   * Start heartbeat service if license is active and user is authenticated
   */
  private async startHeartbeatIfNeeded(license: LicensePayload): Promise<void> {
    // Only start heartbeat for active licenses
    if (license.status !== 'active' && license.status !== 'expiring') {
      logger.info('AppManager: Skipping heartbeat service (license not active)', {
        status: license.status,
      });
      return;
    }

    try {
      // Check if user is authenticated before starting heartbeat
      const keystoreService = getKeystoreService();
      let accessToken: string | null = null;
      try {
        accessToken = await keystoreService.getAccessToken();
      } catch {
        // Ignore keystore errors - treat as no token
      }
      if (!accessToken) {
        logger.info('AppManager: User not authenticated, skipping heartbeat start');
        return;
      }

      // Start the heartbeat service (already initialized in initializeCoreServices)
      logger.info('AppManager: Starting HeartbeatService');
      await this.heartbeatService.start();
    } catch (error) {
      logger.error('AppManager: Failed to start heartbeat service', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Don't fail app startup if heartbeat fails
    }
  }

  /**
   * Setup event listeners for heartbeat service
   */
  private setupHeartbeatEventListeners(): void {
    if (!this.heartbeatService) {
      return;
    }

    this.heartbeatService.on('heartbeat:limit-exceeded', (data) => {
      logger.warn('AppManager: Concurrent session limit exceeded', data);

      // Send event to renderer to show warning to user
      if (this.windowManager && this.windowManager.isWindowAvailable()) {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow) {
          mainWindow.webContents.send('license:concurrent-limit-exceeded', data);
        }
      }
    });

    this.heartbeatService.on('heartbeat:error', (data) => {
      logger.error('AppManager: Heartbeat service error', data);
    });

    this.heartbeatService.on('heartbeat:offline', () => {
      logger.info('AppManager: Heartbeat service entered offline mode');
    });

    this.heartbeatService.on('heartbeat:online', () => {
      logger.info('AppManager: Heartbeat service resumed from offline mode');
    });

    this.heartbeatService.on('heartbeat:success', (data) => {
      logger.debug('AppManager: Heartbeat successful', data);
    });
  }

  /**
   * Check if the application is currently shutting down
   */
  isShuttingDownStatus(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Handle network online event
   */
  async handleNetworkOnline(): Promise<void> {
    logger.info('AppManager: Network connection restored');

    // Resume heartbeat service if it was paused
    if (this.heartbeatService) {
      try {
        this.heartbeatService.resume();
        logger.info('AppManager: HeartbeatService resumed after network reconnect');
      } catch (error) {
        logger.warn('AppManager: Failed to resume heartbeat service', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handle network offline event
   */
  handleNetworkOffline(): void {
    logger.info('AppManager: Network connection lost');

    // Pause heartbeat service when offline
    if (this.heartbeatService) {
      try {
        this.heartbeatService.pause();
        logger.info('AppManager: HeartbeatService paused due to network disconnect');
      } catch (error) {
        logger.warn('AppManager: Failed to pause heartbeat service', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Ensure the audio-engine binary is present and valid (production builds only).
   * In dev mode, the transcription server uses Python directly from the venv.
   */
  private async ensureAudioEngineReady(): Promise<void> {
    if (!app.isPackaged) {
      logger.info('AppManager: Skipping audio engine check (dev mode)');
      return;
    }

    logger.info('AppManager: Phase 2.5 — Ensuring audio engine binary...');
    this.componentHandlers?.setCurrentSetupStatus({
      phase: 'verifying',
      message: 'Verifying speech engine...',
    });

    try {
      const result = await this.componentManager.ensureAudioEngine();

      if (result.alreadyValid) {
        logger.info('AppManager: Audio engine binary verified (already valid)');
      } else {
        logger.info('AppManager: Audio engine binary downloaded and verified');
      }

      this.componentHandlers?.setCurrentSetupStatus({
        phase: 'starting-server',
        message: 'Starting speech engine...',
      });
    } catch (error) {
      logger.error('AppManager: Failed to ensure audio engine binary', {
        error: error instanceof Error ? error.message : error,
      });
      this.audioEngineSetupFailed = true;
      this.componentHandlers?.setCurrentSetupStatus({
        phase: 'error',
        message: error instanceof Error ? error.message : 'Failed to download speech engine',
      });
      // Do NOT throw — let startup continue so SetupScreen can show error with retry
    }
  }

  /**
   * Start transcription server early with default settings (no DB required).
   * Called before password prompt to pre-load the Whisper model in background.
   * This significantly reduces perceived startup time when password protection is enabled.
   */
  private async startTranscriptionServerEarly(): Promise<void> {
    logger.debug('Starting transcription server early (with defaults)...');

    this.transcriptionServer = new TranscriptionServerManager({
      componentManager: this.componentManager,
      env: {
        // Use defaults - will be updated after DB is available if user has custom settings
        NOTELY_MODEL_NAME: undefined, // Uses default model
        NOTELY_USE_GPU: 'false',
        NOTELY_ENABLE_VAD: 'true',

        // Sliding Window Configuration (from TRANSCRIPTION_CONFIG)
        NOTELY_USE_SLIDING_WINDOW: TRANSCRIPTION_CONFIG.useSlidingWindow ? 'true' : 'false',
        NOTELY_WINDOW_SIZE_MS: String(TRANSCRIPTION_CONFIG.windowSizeMs),
        NOTELY_WINDOW_OVERLAP_MS: String(TRANSCRIPTION_CONFIG.windowOverlapMs),
        NOTELY_MAX_SEGMENT_LENGTH_MS: String(TRANSCRIPTION_CONFIG.maxSegmentLengthMs),

        // Refinement Configuration
        NOTELY_REFINEMENT_ENABLED: TRANSCRIPTION_CONFIG.refinementEnabled ? 'true' : 'false',
        NOTELY_REFINEMENT_DELAY_MS: String(TRANSCRIPTION_CONFIG.refinementDelayMs),
        NOTELY_REFINEMENT_BEAM_SIZE: String(TRANSCRIPTION_CONFIG.refinementBeamSize),
        NOTELY_REFINEMENT_TEMPERATURE: String(TRANSCRIPTION_CONFIG.refinementTemperature),
        NOTELY_REFINEMENT_WORKERS: String(TRANSCRIPTION_CONFIG.refinementWorkers),
        NOTELY_REFINEMENT_MAX_QUEUE_SIZE: String(TRANSCRIPTION_CONFIG.refinementMaxQueueSize),

        // VAD Configuration (tuned for better accuracy)
        NOTELY_VAD_THRESHOLD: String(TRANSCRIPTION_CONFIG.vadThreshold),
        NOTELY_VAD_MIN_SPEECH_MS: String(TRANSCRIPTION_CONFIG.vadMinSpeechDurationMs),
        NOTELY_VAD_MIN_SILENCE_MS: String(TRANSCRIPTION_CONFIG.vadMinSilenceDurationMs),
        NOTELY_VAD_SPEECH_PAD_MS: String(TRANSCRIPTION_CONFIG.vadSpeechPadMs),
        NOTELY_MIN_WINDOW_RMS: String(TRANSCRIPTION_CONFIG.minWindowRms),

        // Protocol Configuration (text stability)
        NOTELY_UNSTABLE_TOKEN_COUNT: String(TRANSCRIPTION_CONFIG.unstableTokenCount),
        NOTELY_HEARTBEAT_INTERVAL_MS: String(TRANSCRIPTION_CONFIG.heartbeatIntervalMs),

        // Hallucination / repetition filtering
        NOTELY_PARTIAL_REPETITION_MIN_WORDS: String(TRANSCRIPTION_CONFIG.repetitionFilterMinWords),
      },
    });

    try {
      await this.transcriptionServer.start();
      logger.debug('Transcription server started early (model pre-loaded)');
    } catch (error) {
      logger.warn('Failed to start transcription server early', {
        error: error instanceof Error ? error.message : error,
      });
      // Non-fatal: will try again in updateTranscriptionServerSettings if needed
    }
  }

  /**
   * Update transcription server with user's settings from database.
   * Called after database is opened to apply any custom user settings.
   */
  private async updateTranscriptionServerSettings(): Promise<void> {
    if (!this.transcriptionServer) {
      // Server didn't start early, fall back to full initialization
      await this.startTranscriptionServer();
      return;
    }

    try {
      // Migrate old model names first
      await this.migrateTranscriptionModelName();

      const modelName = (await this.storage.settings.get('transcription.model_name')) as
        | string
        | null;
      const useGpuStr = (await this.storage.settings.get('transcription.use_gpu')) as string | null;
      const useGpu = (useGpuStr || '').toLowerCase() === 'true';

      // Only restart if settings differ from defaults (model specified or GPU enabled)
      const needsRestart = modelName || useGpu;

      if (needsRestart) {
        logger.info('Updating transcription server with user settings', { modelName, useGpu });
        this.transcriptionServer.updateEnvironment({
          NOTELY_MODEL_NAME: modelName || undefined,
          NOTELY_USE_GPU: useGpu ? 'true' : 'false',
        });
        await this.transcriptionServer.restart();
        logger.info('Transcription server updated with user settings');
      } else {
        logger.info('Transcription server using defaults (no custom user settings)');
      }
    } catch (error) {
      logger.warn('Failed to update transcription server settings', {
        error: error instanceof Error ? error.message : error,
      });
      // Non-fatal: server continues with default settings
    }
  }

  /**
   * Restart the transcription server with updated settings
   */
  async restartTranscriptionServer(): Promise<void> {
    if (!this.transcriptionServer) {
      logger.warn('AppManager: No transcription server to restart');
      return;
    }

    logger.info('AppManager: Restarting transcription server with updated settings');

    try {
      // Read updated settings
      let modelName: string | null = null;
      let useGpu = false;
      try {
        modelName = (await this.storage.settings.get('transcription.model_name')) as string | null;
        const useGpuStr = (await this.storage.settings.get('transcription.use_gpu')) as
          | string
          | null;
        useGpu = (useGpuStr || '').toLowerCase() === 'true';
      } catch (e) {
        logger.warn('AppManager: Failed to read transcription settings during restart', {
          e: e instanceof Error ? e.message : e,
        });
      }

      // Update environment variables
      this.transcriptionServer.updateEnvironment({
        NOTELY_MODEL_NAME: modelName || undefined,
        NOTELY_USE_GPU: useGpu ? 'true' : 'false',
      });

      // Restart the server
      await this.transcriptionServer.restart();
      logger.info('AppManager: Transcription server restarted successfully');
    } catch (error) {
      logger.error('AppManager: Failed to restart transcription server', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }
}
