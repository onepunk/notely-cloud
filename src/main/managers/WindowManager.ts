import fs from 'node:fs';
import path from 'node:path';

import { app, BrowserWindow, nativeImage, nativeTheme, screen } from 'electron';

import type {
  MeetingReminderState,
  MeetingReminderTriggerPayload,
} from '../../common/meetingReminder';
import { DEV_SERVER_URL } from '../config';
import { logger } from '../logger';

export interface WindowManagerOptions {
  onWindowCreated?: (window: BrowserWindow) => void;
  onWindowClosed?: () => void;
  /** Called when the main window loses focus (blur) - used to flush pending sync */
  onWindowBlur?: () => void;
  /** Called when password unlock is successful */
  onPasswordUnlocked?: () => void;
}

/**
 * WindowManager handles all window creation, configuration, and lifecycle management.
 * This includes dev server detection, preload script resolution, window event handling,
 * and proper cleanup on window destruction.
 */
export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private meetingReminderWindow: BrowserWindow | null = null;
  private meetingReminderReady = false;
  private pendingReminderMessages: Array<{ channel: string; payload: unknown }> = [];
  private rendererDevServerReady: boolean | null = null;
  private passwordUnlockWindow: BrowserWindow | null = null;
  private passwordUnlockResolve: ((unlocked: boolean) => void) | null = null;

  constructor(private options: WindowManagerOptions = {}) {}

  /**
   * Get the current main window instance
   */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /**
   * Create and configure the main application window
   */
  async createMainWindow(): Promise<BrowserWindow | null> {
    logger.debug('WindowManager: Starting window creation process');

    try {
      // Resolve preload script path
      const preloadPath = this.resolvePreloadScript();
      if (!preloadPath) {
        logger.error('WindowManager: Failed to resolve preload script');
        return null;
      }

      // Create BrowserWindow with optimized configuration
      logger.debug('WindowManager: Creating BrowserWindow instance');
      const isMac = process.platform === 'darwin';
      const isWin = process.platform === 'win32';
      const isLinux = process.platform === 'linux';

      const iconPath = this.getIconPath();
      if (isMac && iconPath && fs.existsSync(iconPath)) {
        try {
          const dockIcon = nativeImage.createFromPath(iconPath);
          if (!dockIcon.isEmpty()) {
            app.dock.setIcon(dockIcon);
          }
        } catch (error) {
          logger.warn('WindowManager: Failed to set dock icon', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      this.mainWindow = new BrowserWindow({
        width: 900,
        height: 600,
        minWidth: 900,
        minHeight: 600,
        useContentSize: true,
        // Use custom (frameless) window, except for Linux which uses native frame
        frame: isLinux, // Use native frame for Linux to get OS native caption buttons
        show: false, // Don't show immediately - wait for ready-to-show
        titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
        // Windows-specific title bar overlay configuration
        titleBarOverlay: isWin ? this.getTitleBarOverlayOptions() : undefined,
        // macOS-specific traffic light positioning
        trafficLightPosition: isMac ? ({ x: 12, y: 12 } as Electron.Point) : undefined,
        // Linux-specific configuration
        ...(isLinux &&
          {
            // Additional Linux-specific window options can go here
          }),
        // App icon for taskbar
        icon: iconPath,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: app.isPackaged, // Disable sandbox in dev mode for Electron 30+ compatibility
          webSecurity: app.isPackaged, // Disable web security in dev mode
        },
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#ffffff',
      });

      logger.debug('WindowManager: BrowserWindow created successfully');
      this.logInitialWindowBounds();

      // Setup window event listeners
      this.setupWindowEventListeners();

      // Setup WebContents configuration and debugging
      this.setupWebContents();

      // Load the appropriate content (dev server or built files)
      const loadSuccess = await this.loadWindowContent();
      if (!loadSuccess) {
        logger.error('WindowManager: Failed to load window content');
        this.closeWindow();
        return null;
      }

      logger.debug('WindowManager: Window creation process completed successfully');

      // Notify callback if provided
      if (this.options.onWindowCreated) {
        this.options.onWindowCreated(this.mainWindow);
      }

      return this.mainWindow;
    } catch (error) {
      logger.error('WindowManager: Critical error during window creation', {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      });

      this.closeWindow();
      return null;
    }
  }

  /**
   * Resolve preload script path with fallback logic
   */
  private resolvePreloadScript(): string | null {
    const preloadJs = path.join(__dirname, 'preload.js');
    const preloadCjs = path.join(__dirname, 'preload.cjs');
    const preloadPath = fs.existsSync(preloadJs)
      ? preloadJs
      : fs.existsSync(preloadCjs)
        ? preloadCjs
        : preloadJs;

    logger.debug('WindowManager: Preload script resolution', {
      __dirname,
      preloadJs,
      preloadCjs,
      chosen: preloadPath,
      exists: fs.existsSync(preloadPath),
    });

    if (!fs.existsSync(preloadPath)) {
      logger.error('WindowManager: CRITICAL - Preload script does not exist', { preloadPath });
      return null;
    }

    return preloadPath;
  }

  /**
   * Get the path to the application icon
   */
  private getIconPath(): string {
    // For development, the icon is in the project root
    // For packaged app, we need to find it relative to the app path
    const iconName = 'logo.png';

    const candidatePaths: string[] = [];
    if (app.isPackaged) {
      candidatePaths.push(path.join(process.resourcesPath, iconName));
      candidatePaths.push(path.join(process.resourcesPath, 'resources', iconName));
      candidatePaths.push(path.join(app.getAppPath(), iconName));
      candidatePaths.push(path.join(app.getAppPath(), 'resources', iconName));
    } else {
      // In dev mode, __dirname is dist-electron/, so go up one level to project root
      candidatePaths.push(path.join(__dirname, '..', 'resources', iconName));
      candidatePaths.push(path.join(__dirname, '..', iconName));
    }

    const iconPath =
      candidatePaths.find((candidate) => fs.existsSync(candidate)) ?? candidatePaths[0];

    logger.debug('WindowManager: Icon path resolution', {
      isPackaged: app.isPackaged,
      iconPath,
      exists: fs.existsSync(iconPath),
      __dirname,
      processResourcesPath: process.resourcesPath,
    });

    return iconPath;
  }

  /**
   * Get platform-specific title bar overlay options
   */
  private getTitleBarOverlayOptions(): Electron.TitleBarOverlayOptions | undefined {
    if (process.platform !== 'win32') {
      return undefined;
    }

    // On Windows, enable title bar overlay so web contents extend to the very top.
    // Match the custom titlebar CSS height (36px) and color to avoid a visible gap.
    return {
      // Provide a sensible default; renderer can update at runtime via IPC
      color: '#e2e2e2',
      symbolColor: '#132e2d',
      height: 36,
    };
  }

  /**
   * Log initial window bounds for debugging
   */
  private logInitialWindowBounds(): void {
    try {
      if (!this.mainWindow) return;

      const bounds = this.mainWindow.getBounds();
      const contentBounds = this.mainWindow.getContentBounds();
      logger.debug('WindowManager: Initial window size', { bounds, contentBounds });
    } catch (error) {
      logger.warn('WindowManager: Failed to read initial window bounds', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Setup comprehensive window event listeners
   */
  private setupWindowEventListeners(): void {
    if (!this.mainWindow) return;

    // Window lifecycle events
    this.mainWindow.on('closed', () => {
      logger.warn('WindowManager: Window closed event fired');
      this.closeMeetingReminderWindow();
      this.mainWindow = null;

      // Notify callback if provided
      if (this.options.onWindowClosed) {
        this.options.onWindowClosed();
      }
    });

    this.mainWindow.on('close', () => {
      logger.warn('WindowManager: Window close event fired');
    });

    // Ready to show optimization
    this.mainWindow.once('ready-to-show', () => {
      logger.debug('WindowManager: Window ready-to-show event fired');
      try {
        this.mainWindow?.show();
        logger.debug('WindowManager: Window show() called successfully');
        this.logWindowBounds('ready-to-show');
      } catch (error) {
        logger.error('WindowManager: Error in show()', {
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    // Visibility events
    this.mainWindow.on('show', () => {
      logger.debug('WindowManager: Window show event fired');
      this.logWindowBounds('show');
    });

    this.mainWindow.on('hide', () => {
      logger.warn('WindowManager: Window hide event fired');
    });

    // Focus events (debug level for less noise)
    this.mainWindow.on('focus', () => {
      logger.debug('WindowManager: Window focus event fired');
    });

    this.mainWindow.on('blur', () => {
      logger.debug('WindowManager: Window blur event fired');
      // Flush any pending sync changes when window loses focus
      this.options.onWindowBlur?.();
    });
  }

  /**
   * Log window bounds with context for debugging
   */
  private logWindowBounds(context: string): void {
    try {
      if (!this.mainWindow) return;

      const bounds = this.mainWindow.getBounds();
      const contentBounds = this.mainWindow.getContentBounds();
      const isMaximized = this.mainWindow.isMaximized();

      logger.debug(`WindowManager: Window size (${context})`, {
        bounds,
        contentBounds,
        isMaximized,
      });
    } catch (error) {
      logger.warn(`WindowManager: Failed to read window bounds (${context})`, {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Setup WebContents configuration and debugging
   */
  private setupWebContents(): void {
    if (!this.mainWindow) return;

    const webContents = this.mainWindow.webContents;

    // Prevent new windows
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // Navigation protection
    webContents.on('will-navigate', (event, url) => {
      logger.debug('WindowManager: WebContents will-navigate', { url });

      if (app.isPackaged) {
        if (!url.startsWith('file:')) {
          logger.warn('WindowManager: Preventing navigation to non-file URL in packaged app', {
            url,
          });
          event.preventDefault();
        }
      } else {
        if (!url.startsWith(DEV_SERVER_URL)) {
          logger.warn('WindowManager: Preventing navigation to non-dev-server URL in dev mode', {
            url,
          });
          event.preventDefault();
        }
      }
    });

    // Attach comprehensive WebContents debugging
    this.attachWebContentsDebug(webContents);

    // Request debugging (useful for troubleshooting)
    webContents.session.webRequest.onBeforeRequest((details, callback) => {
      logger.debug('WindowManager: Request intercepted', {
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
      });
      callback({ cancel: false });
    });
  }

  /**
   * Attach comprehensive WebContents debugging
   */
  private attachWebContentsDebug(webContents: Electron.WebContents): void {
    webContents.on('did-start-loading', () =>
      logger.debug('WindowManager WebContents: did-start-loading')
    );

    webContents.on('did-finish-load', () =>
      logger.debug('WindowManager WebContents: did-finish-load')
    );

    webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) =>
      logger.error('WindowManager WebContents: did-fail-load', {
        code,
        description,
        url,
        isMainFrame,
      })
    );

    webContents.on('dom-ready', () => logger.debug('WindowManager WebContents: dom-ready'));

    webContents.on('render-process-gone', (_event, details: Electron.RenderProcessGoneDetails) =>
      logger.error('WindowManager WebContents: render-process-gone', { details })
    );

    webContents.on('unresponsive', () => logger.warn('WindowManager WebContents: unresponsive'));

    webContents.on('responsive', () => logger.debug('WindowManager WebContents: responsive'));

    webContents.on('console-message', (event) =>
      logger.debug('WindowManager Console', {
        level: event.level,
        message: event.message,
        line: event.line,
        sourceId: event.sourceId,
      })
    );
  }

  /**
   * Load window content (dev server or built files)
   */
  private async loadWindowContent(): Promise<boolean> {
    if (!this.mainWindow) return false;

    const distIndex = path.join(__dirname, '../dist/renderer/index.html');
    logger.debug('WindowManager: Checking content loading strategy', {
      isPackaged: app.isPackaged,
      distIndex,
      distIndexExists: fs.existsSync(distIndex),
    });

    if (app.isPackaged) {
      return await this.loadPackagedContent(distIndex);
    } else {
      // In coverage runs, prefer built files to avoid dev-server dependency
      if (process.env.COVERAGE === 'true' || process.env.COVERAGE === '1') {
        logger.info(
          'WindowManager: Coverage mode detected; loading built files instead of dev server'
        );
        return await this.loadPackagedContent(distIndex);
      }
      return await this.loadDevelopmentContent(distIndex);
    }
  }

  /**
   * Load packaged content (production mode)
   */
  private async loadPackagedContent(distIndex: string): Promise<boolean> {
    logger.debug('WindowManager: Loading packaged index file', {
      distIndex,
      exists: fs.existsSync(distIndex),
    });

    if (!fs.existsSync(distIndex)) {
      logger.error('WindowManager: CRITICAL - Packaged index.html does not exist', { distIndex });
      return false;
    }

    try {
      await this.mainWindow!.loadFile(distIndex);
      logger.debug('WindowManager: Packaged content loaded successfully');
      this.rendererDevServerReady = false;
      return true;
    } catch (error) {
      logger.error('WindowManager: Failed to load packaged content', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Load development content (dev server or fallback)
   */
  private async loadDevelopmentContent(distIndex: string): Promise<boolean> {
    logger.debug('WindowManager: Development mode - checking dev server');

    const devUrl = DEV_SERVER_URL;
    // If built files exist, use shorter timeout (5s) since we have a fallback
    // Otherwise wait longer (30s) in case dev server is still starting
    const hasBuiltFiles = fs.existsSync(distIndex);
    const timeout = hasBuiltFiles ? 5000 : 30000;

    logger.debug('WindowManager: Dev server check timeout', { timeout, hasBuiltFiles });
    const serverReady = await this.waitForDevServer(devUrl, timeout);

    if (serverReady) {
      const outcome = await this.loadDevServer(devUrl, distIndex);
      if (outcome === 'dev') {
        this.rendererDevServerReady = true;
        return true;
      }
      this.rendererDevServerReady = false;
      return outcome === 'fallback';
    } else {
      this.rendererDevServerReady = false;
      return await this.loadFallbackContent(distIndex);
    }
  }

  /**
   * Load content from dev server
   */
  private async loadDevServer(
    devUrl: string,
    fallbackPath: string
  ): Promise<'dev' | 'fallback' | 'failed'> {
    try {
      logger.debug('WindowManager: Loading dev server', { url: devUrl });
      await this.mainWindow!.loadURL(devUrl);
      logger.debug('WindowManager: Dev server loaded successfully');
      return 'dev';
    } catch (error) {
      logger.error('WindowManager: Failed to load dev server after confirmation it was ready', {
        url: devUrl,
        error: error instanceof Error ? error.message : error,
      });

      // Fallback to built files if available
      if (fs.existsSync(fallbackPath)) {
        logger.warn('WindowManager: Falling back to built files after dev server failure');
        try {
          await this.mainWindow!.loadFile(fallbackPath);
          logger.debug('WindowManager: Fallback content loaded successfully');
          return 'fallback';
        } catch (fallbackError) {
          logger.error('WindowManager: Fallback content load also failed', {
            error: fallbackError instanceof Error ? fallbackError.message : fallbackError,
          });
        }
      } else {
        logger.error('WindowManager: CRITICAL - Dev server failed and no built files available');
      }
      return 'failed';
    }
  }

  /**
   * Load fallback content when dev server is not available
   */
  private async loadFallbackContent(distIndex: string): Promise<boolean> {
    logger.warn('WindowManager: Dev server not ready within timeout, checking for built files');

    if (fs.existsSync(distIndex)) {
      try {
        logger.warn('WindowManager: Using built files as fallback');
        await this.mainWindow!.loadFile(distIndex);
        logger.debug('WindowManager: Fallback content loaded successfully');
        return true;
      } catch (error) {
        logger.error('WindowManager: Failed to load fallback content', {
          error: error instanceof Error ? error.message : error,
        });
      }
    } else {
      logger.error('WindowManager: CRITICAL - No dev server and no built files available', {
        distIndex,
      });
    }

    return false;
  }

  /**
   * Wait for dev server to be ready with retry logic
   */
  private async waitForDevServer(url: string, timeoutMs: number = 20000): Promise<boolean> {
    logger.debug('WindowManager: Starting dev server readiness check', { url, timeoutMs });

    const start = Date.now();
    let attempts = 0;

    while (Date.now() - start < timeoutMs) {
      attempts++;

      try {
        logger.debug('WindowManager: Attempting dev server connection', { attempt: attempts, url });

        // Add 2-second timeout to each fetch attempt to prevent hanging
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), 2000);

        const response = await fetch(url, {
          method: 'HEAD',
          signal: controller.signal,
        } as RequestInit);

        clearTimeout(fetchTimeout);

        logger.debug('WindowManager: Dev server response received', {
          status: (response as Response).status,
          ok: (response as Response).ok,
        });

        if ((response as Response).ok || (response as Response).status === 200) {
          logger.debug('WindowManager: Dev server is ready', {
            attempts,
            elapsedMs: Date.now() - start,
          });
          return true;
        }
      } catch (error) {
        logger.debug('WindowManager: Dev server connection failed', {
          attempt: attempts,
          error: error instanceof Error ? error.message : error,
        });
      }

      // Wait before next attempt
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    logger.warn('WindowManager: Dev server readiness timeout reached', {
      attempts,
      elapsedMs: Date.now() - start,
    });
    return false;
  }

  /**
   * Close the main window safely
   */
  closeWindow(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        logger.debug('WindowManager: Closing main window');
        this.mainWindow.close();
      } catch (error) {
        logger.error('WindowManager: Error closing main window', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
    this.mainWindow = null;
  }

  /**
   * Check if main window exists and is not destroyed
   */
  isWindowAvailable(): boolean {
    return this.mainWindow !== null && !this.mainWindow.isDestroyed();
  }

  /**
   * Focus the main window if available
   */
  focusWindow(): void {
    if (this.isWindowAvailable()) {
      try {
        if (this.mainWindow!.isMinimized()) {
          this.mainWindow!.restore();
        }
        this.mainWindow!.focus();
        logger.debug('WindowManager: Window focused successfully');
      } catch (error) {
        logger.warn('WindowManager: Failed to focus window', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  /**
   * Show the meeting reminder popup window and deliver the reminder payload.
   */
  async showMeetingReminderWindow(
    payload: MeetingReminderTriggerPayload,
    state: MeetingReminderState
  ): Promise<void> {
    const window = await this.ensureMeetingReminderWindow();
    if (!window) {
      logger.warn('WindowManager: Unable to show meeting reminder window');
      return;
    }

    this.positionMeetingReminderWindow(window);

    this.sendMeetingReminderMessage('meetingReminder:stateChanged', state, true);
    this.sendMeetingReminderMessage('meetingReminder:reminderDue', payload, true);

    try {
      if (typeof window.showInactive === 'function') {
        window.showInactive();
      } else {
        window.show();
      }
    } catch (error) {
      logger.warn('WindowManager: Failed to show meeting reminder window', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Send reminder-state updates to the popup window (if present).
   */
  sendMeetingReminderState(state: MeetingReminderState): void {
    this.sendMeetingReminderMessage('meetingReminder:stateChanged', state);
    if (!state.enabled) {
      this.hideMeetingReminderWindow();
    }
  }

  /**
   * Hide the meeting reminder popup without destroying it.
   */
  hideMeetingReminderWindow(): void {
    if (this.meetingReminderWindow && !this.meetingReminderWindow.isDestroyed()) {
      try {
        this.meetingReminderWindow.hide();
      } catch (error) {
        logger.debug('WindowManager: Failed to hide reminder window', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  /**
   * Close the reminder popup and reset its state.
   */
  private closeMeetingReminderWindow(): void {
    const window = this.meetingReminderWindow;
    if (!window) {
      this.pendingReminderMessages = [];
      this.meetingReminderReady = false;
      return;
    }

    if (!window.isDestroyed()) {
      try {
        window.close();
      } catch (error) {
        logger.warn('WindowManager: Failed to close reminder window', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    this.meetingReminderWindow = null;
    this.pendingReminderMessages = [];
    this.meetingReminderReady = false;
  }

  /**
   * Ensure the reminder window exists and is loaded.
   */
  private async ensureMeetingReminderWindow(): Promise<BrowserWindow | null> {
    if (this.meetingReminderWindow && !this.meetingReminderWindow.isDestroyed()) {
      return this.meetingReminderWindow;
    }

    const preloadPath = this.resolvePreloadScript();
    if (!preloadPath) {
      logger.error('WindowManager: Preload script unavailable for reminder window');
      return null;
    }

    this.pendingReminderMessages = [];
    this.meetingReminderReady = false;

    const window = new BrowserWindow({
      width: 250,
      height: 120,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: app.isPackaged,
      },
    });

    window.setMenuBarVisibility(false);
    window.on('closed', () => {
      this.meetingReminderWindow = null;
      this.meetingReminderReady = false;
      this.pendingReminderMessages = [];
    });

    window.webContents.once('did-finish-load', () => {
      this.meetingReminderReady = true;
      this.flushMeetingReminderMessages();
    });

    this.attachWebContentsDebug(window.webContents);

    try {
      await this.loadMeetingReminderContent(window);
    } catch (error) {
      logger.error('WindowManager: Failed to load meeting reminder content', {
        error: error instanceof Error ? error.message : error,
      });
      window.destroy();
      return null;
    }

    this.meetingReminderWindow = window;
    return window;
  }

  /**
   * Load reminder popup content (dev server or built files).
   */
  private async loadMeetingReminderContent(window: BrowserWindow): Promise<void> {
    const distPath = path.join(__dirname, '../dist/renderer/meeting-reminder.html');
    const devEntry = `${DEV_SERVER_URL}/meeting-reminder.html`;
    const isCoverage = process.env.COVERAGE === 'true' || process.env.COVERAGE === '1';
    const hasBuiltFiles = fs.existsSync(distPath);

    if (app.isPackaged || isCoverage) {
      if (!hasBuiltFiles) {
        throw new Error(`Meeting reminder bundle missing at ${distPath}`);
      }
      await window.loadFile(distPath);
      return;
    }

    const shouldUseDevServer = this.rendererDevServerReady !== false;

    if (shouldUseDevServer) {
      if (this.rendererDevServerReady !== true) {
        const timeout = hasBuiltFiles ? 5000 : 30000;
        const serverReady = await this.waitForDevServer(DEV_SERVER_URL, timeout);
        this.rendererDevServerReady = serverReady;
      }

      if (this.rendererDevServerReady === true) {
        try {
          await window.loadURL(devEntry);
          return;
        } catch (error) {
          logger.warn(
            'WindowManager: Reminder popup failed to load from dev server, will fallback to built files',
            { error: error instanceof Error ? error.message : error }
          );
          this.rendererDevServerReady = false;
        }
      }
    }

    if (!hasBuiltFiles) {
      throw new Error(
        `Meeting reminder bundle missing (expected at ${distPath}) and dev server unavailable`
      );
    }

    await window.loadFile(distPath);
    this.rendererDevServerReady = false;
  }

  /**
   * Position the reminder window in the top-right corner of the active display.
   */
  private positionMeetingReminderWindow(window: BrowserWindow): void {
    try {
      const referenceBounds =
        this.mainWindow && !this.mainWindow.isDestroyed()
          ? this.mainWindow.getBounds()
          : screen.getPrimaryDisplay().workArea;
      const display =
        this.mainWindow && !this.mainWindow.isDestroyed()
          ? screen.getDisplayMatching(referenceBounds)
          : screen.getPrimaryDisplay();
      const workArea = display.workArea;
      const [width] = window.getSize();
      const margin = 16;
      const targetX = Math.round(workArea.x + workArea.width - width - margin);
      const targetY = Math.round(workArea.y + margin);
      window.setPosition(targetX, targetY, false);
    } catch (error) {
      logger.warn('WindowManager: Failed to position reminder window', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Queue or send meeting reminder IPC messages to the popup window.
   */
  private sendMeetingReminderMessage(
    channel: string,
    payload: unknown,
    queueIfNoWindow: boolean = false
  ): void {
    const window = this.meetingReminderWindow;
    if (!window || window.isDestroyed()) {
      if (queueIfNoWindow) {
        this.pendingReminderMessages.push({ channel, payload });
      }
      return;
    }

    if (!this.meetingReminderReady || window.webContents.isLoading()) {
      this.pendingReminderMessages.push({ channel, payload });
      return;
    }

    try {
      window.webContents.send(channel, payload);
    } catch (error) {
      logger.warn('WindowManager: Failed to send message to reminder window', {
        channel,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Flush queued messages once the reminder window is ready.
   */
  private flushMeetingReminderMessages(): void {
    const window = this.meetingReminderWindow;
    if (!window || window.isDestroyed() || !this.meetingReminderReady) {
      return;
    }

    const pending = [...this.pendingReminderMessages];
    this.pendingReminderMessages = [];

    for (const { channel, payload } of pending) {
      try {
        window.webContents.send(channel, payload);
      } catch (error) {
        logger.warn('WindowManager: Failed to flush reminder message', {
          channel,
          error: error instanceof Error ? error.message : error,
        });
      }
    }
  }

  /**
   * Show the password unlock window and wait for successful unlock.
   * Returns a promise that resolves to true when unlocked, false if cancelled.
   */
  async showPasswordUnlockWindow(): Promise<boolean> {
    logger.debug('WindowManager: Showing password unlock window');

    // Close any existing password unlock window
    this.closePasswordUnlockWindow();

    const preloadPath = this.resolvePreloadScript();
    if (!preloadPath) {
      logger.error('WindowManager: Preload script unavailable for password unlock window');
      return false;
    }

    return new Promise<boolean>((resolve) => {
      this.passwordUnlockResolve = resolve;

      this.passwordUnlockWindow = new BrowserWindow({
        width: 400,
        height: 360,
        useContentSize: true,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        center: true,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: app.isPackaged,
        },
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#ffffff',
      });

      this.passwordUnlockWindow.setMenuBarVisibility(false);

      this.passwordUnlockWindow.on('closed', () => {
        logger.debug('WindowManager: Password unlock window closed');
        // If closed without explicit unlock, resolve as false
        if (this.passwordUnlockResolve) {
          this.passwordUnlockResolve(false);
          this.passwordUnlockResolve = null;
        }
        this.passwordUnlockWindow = null;
      });

      this.passwordUnlockWindow.once('ready-to-show', () => {
        this.passwordUnlockWindow?.show();
        this.passwordUnlockWindow?.focus();
      });

      this.attachWebContentsDebug(this.passwordUnlockWindow.webContents);

      // Load the password unlock content
      this.loadPasswordUnlockContent(this.passwordUnlockWindow)
        .then(() => {
          logger.debug('WindowManager: Password unlock window content loaded');
        })
        .catch((error) => {
          logger.error('WindowManager: Failed to load password unlock content', {
            error: error instanceof Error ? error.message : error,
          });
          this.closePasswordUnlockWindow();
          resolve(false);
        });
    });
  }

  /**
   * Called by IPC when password unlock is successful.
   * Note: We don't close the unlock window here - it will be closed after
   * the main window is created to avoid the window-all-closed race condition.
   */
  notifyPasswordUnlocked(): void {
    logger.debug('WindowManager: Password unlock successful');
    if (this.passwordUnlockResolve) {
      this.passwordUnlockResolve(true);
      this.passwordUnlockResolve = null;
    }
    // Don't close the unlock window here - let the main window open first,
    // then AppManager will call closePasswordUnlockWindow() after main window is ready
    this.options.onPasswordUnlocked?.();
  }

  /**
   * Check if password unlock window is currently open
   */
  hasPasswordUnlockWindow(): boolean {
    return this.passwordUnlockWindow !== null && !this.passwordUnlockWindow.isDestroyed();
  }

  /**
   * Load password unlock window content
   */
  private async loadPasswordUnlockContent(window: BrowserWindow): Promise<void> {
    const distPath = path.join(__dirname, '../dist/renderer/passwordUnlock.html');
    const devEntry = `${DEV_SERVER_URL}/passwordUnlock.html`;
    const isCoverage = process.env.COVERAGE === 'true' || process.env.COVERAGE === '1';
    const hasBuiltFiles = fs.existsSync(distPath);

    if (app.isPackaged || isCoverage) {
      if (!hasBuiltFiles) {
        throw new Error(`Password unlock bundle missing at ${distPath}`);
      }
      await window.loadFile(distPath);
      return;
    }

    const shouldUseDevServer = this.rendererDevServerReady !== false;

    if (shouldUseDevServer) {
      if (this.rendererDevServerReady !== true) {
        const timeout = hasBuiltFiles ? 5000 : 30000;
        const serverReady = await this.waitForDevServer(DEV_SERVER_URL, timeout);
        this.rendererDevServerReady = serverReady;
      }

      if (this.rendererDevServerReady === true) {
        try {
          await window.loadURL(devEntry);
          return;
        } catch (error) {
          logger.warn(
            'WindowManager: Password unlock window failed to load from dev server, will fallback to built files',
            { error: error instanceof Error ? error.message : error }
          );
          this.rendererDevServerReady = false;
        }
      }
    }

    if (!hasBuiltFiles) {
      throw new Error(
        `Password unlock bundle missing (expected at ${distPath}) and dev server unavailable`
      );
    }

    await window.loadFile(distPath);
    this.rendererDevServerReady = false;
  }

  /**
   * Close the password unlock window
   */
  closePasswordUnlockWindow(): void {
    if (this.passwordUnlockWindow && !this.passwordUnlockWindow.isDestroyed()) {
      logger.debug('WindowManager: Closing password unlock window');
      try {
        this.passwordUnlockWindow.close();
      } catch (error) {
        logger.warn('WindowManager: Failed to close password unlock window', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
    this.passwordUnlockWindow = null;
  }

  /**
   * Cleanup and destroy window manager
   */
  destroy(): void {
    logger.debug('WindowManager: Cleaning up window manager');
    this.closeWindow();
    this.closeMeetingReminderWindow();
    this.closePasswordUnlockWindow();
  }
}
