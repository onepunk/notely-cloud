import { BrowserWindow, ipcMain, app, shell } from 'electron';

import { logger, setLogLevel, type LogLevel } from '../logger';
import type { ISettingsService } from '../storage/interfaces';

export interface WindowHandlersDependencies {
  mainWindow: BrowserWindow | null;
  onRendererReady?: () => void;
  /**
   * Settings service for reading user-configured server URL.
   * Used to dynamically allow the custom server domain in URL validation.
   */
  settings?: ISettingsService;
}

/**
 * WindowHandlers manages all IPC handlers related to window controls and logging.
 * This includes window minimize/maximize/close operations, renderer-to-main logging,
 * and renderer ready notifications.
 */
export class WindowHandlers {
  constructor(private deps: WindowHandlersDependencies) {}

  /**
   * Register all window and logging-related IPC handlers
   */
  register(): void {
    logger.debug('WindowHandlers: Registering IPC handlers');

    // Window control handlers
    ipcMain.on('window-control', this.handleWindowControl.bind(this));

    // Logging handlers
    ipcMain.on('log:setLevel', this.handleSetLogLevel.bind(this));
    ipcMain.on('log:info', this.handleLogInfo.bind(this));
    ipcMain.on('log:warn', this.handleLogWarn.bind(this));
    ipcMain.on('log:error', this.handleLogError.bind(this));
    ipcMain.on('log:debug', this.handleLogDebug.bind(this));

    // Renderer lifecycle handlers
    ipcMain.on('renderer-ready', this.handleRendererReady.bind(this));

    // App info handlers
    ipcMain.handle('app:getVersion', this.handleGetVersion.bind(this));
    ipcMain.handle('app:isDevelopment', this.handleIsDevelopment.bind(this));

    // Window overlay customization (Windows only)
    ipcMain.handle('window:setTitlebarOverlay', this.handleSetTitlebarOverlay.bind(this));

    // External URL handler
    ipcMain.handle('window:openExternal', this.handleOpenExternal.bind(this));

    logger.debug('WindowHandlers: All handlers registered successfully');
  }

  /**
   * Handle window control commands (minimize, maximize, close)
   */
  private handleWindowControl(
    _event: Electron.IpcMainEvent,
    command: 'min' | 'max' | 'close'
  ): void {
    try {
      logger.debug('WindowHandlers: Window control command', { command });

      if (!this.deps.mainWindow) {
        logger.warn('WindowHandlers: No main window available for control', { command });
        return;
      }

      switch (command) {
        case 'min':
          this.deps.mainWindow.minimize();
          logger.debug('WindowHandlers: Window minimized');
          break;
        case 'max':
          if (this.deps.mainWindow.isMaximized()) {
            this.deps.mainWindow.unmaximize();
            logger.debug('WindowHandlers: Window unmaximized');
          } else {
            this.deps.mainWindow.maximize();
            logger.debug('WindowHandlers: Window maximized');
          }
          break;
        case 'close':
          this.deps.mainWindow.close();
          logger.debug('WindowHandlers: Window close requested');
          break;
        default:
          logger.warn('WindowHandlers: Unknown window control command', { command });
      }
    } catch (error) {
      logger.error('WindowHandlers: Failed to execute window control', {
        command,
        error: error instanceof Error ? error.message : error,
      });
      // Don't throw as window control failures shouldn't crash the app
    }
  }

  /**
   * Set logging level from renderer
   */
  private handleSetLogLevel(_event: Electron.IpcMainEvent, level: LogLevel): void {
    try {
      logger.debug('WindowHandlers: Setting log level', { level });

      setLogLevel(level);
      logger.info('WindowHandlers: Log level set successfully', { level });
    } catch (error) {
      logger.warn('WindowHandlers: Failed to set log level', {
        level,
        error: error instanceof Error ? error.message : error,
      });
      // Don't throw as log level changes shouldn't be critical
    }
  }

  /**
   * Forward info log from renderer to main logger
   */
  private handleLogInfo(
    _event: Electron.IpcMainEvent,
    payload: { message: string; meta?: Record<string, unknown> }
  ): void {
    try {
      logger.info(`[RENDERER] ${payload?.message}`, payload?.meta);
    } catch (error) {
      // Fallback logging if main logger fails
      console.info('[RENDERER LOG FAILED]', payload, error);
    }
  }

  /**
   * Forward warn log from renderer to main logger
   */
  private handleLogWarn(
    _event: Electron.IpcMainEvent,
    payload: { message: string; meta?: Record<string, unknown> }
  ): void {
    try {
      logger.warn(`[RENDERER] ${payload?.message}`, payload?.meta);
    } catch (error) {
      // Fallback logging if main logger fails
      console.warn('[RENDERER LOG FAILED]', payload, error);
    }
  }

  /**
   * Forward error log from renderer to main logger
   */
  private handleLogError(
    _event: Electron.IpcMainEvent,
    payload: { message: string; meta?: Record<string, unknown> }
  ): void {
    try {
      logger.error(`[RENDERER] ${payload?.message}`, payload?.meta);
    } catch (error) {
      // Fallback logging if main logger fails
      console.error('[RENDERER LOG FAILED]', payload, error);
    }
  }

  /**
   * Forward debug log from renderer to main logger
   */
  private handleLogDebug(
    _event: Electron.IpcMainEvent,
    payload: { message: string; meta?: Record<string, unknown> }
  ): void {
    try {
      logger.debug(`[RENDERER] ${payload?.message}`, payload?.meta);
    } catch (error) {
      // Fallback logging if main logger fails
      console.debug('[RENDERER LOG FAILED]', payload, error);
    }
  }

  /**
   * Handle renderer ready notification
   */
  private handleRendererReady(): void {
    try {
      logger.debug('WindowHandlers: Renderer reported ready');

      // Call the provided callback if available
      if (this.deps.onRendererReady) {
        this.deps.onRendererReady();
      }

      logger.debug('WindowHandlers: Renderer ready handled');
    } catch (error) {
      logger.error('WindowHandlers: Failed to handle renderer ready', {
        error: error instanceof Error ? error.message : error,
      });
      // Don't throw as this shouldn't be critical
    }
  }

  /**
   * Allow renderer to update Windows titlebar overlay colors
   */
  private handleSetTitlebarOverlay(
    _event: Electron.IpcMainInvokeEvent,
    options: Partial<Electron.TitleBarOverlayOptions>
  ): boolean {
    try {
      if (process.platform !== 'win32') return false;
      if (!this.deps.mainWindow) return false;
      this.deps.mainWindow.setTitleBarOverlay({
        color: options.color,
        symbolColor: options.symbolColor,
        height: options.height ?? 36,
      });
      logger.debug('WindowHandlers: Updated titlebar overlay', options as Record<string, unknown>);
      return true;
    } catch (error) {
      logger.warn('WindowHandlers: Failed to set titlebar overlay', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Get app version from Electron
   */
  private handleGetVersion(): string {
    try {
      const version = app.getVersion();
      logger.info('WindowHandlers: App version requested', { version });
      return version;
    } catch (error) {
      logger.error('WindowHandlers: Failed to get app version', {
        error: error instanceof Error ? error.message : error,
      });
      // Return fallback version if something goes wrong
      return '0.0.0';
    }
  }

  /**
   * Check if running in development mode
   */
  private handleIsDevelopment(): boolean {
    try {
      const isDev = !app.isPackaged;
      logger.debug('WindowHandlers: Development mode check', { isDevelopment: isDev });
      return isDev;
    } catch (error) {
      logger.error('WindowHandlers: Failed to check development mode', {
        error: error instanceof Error ? error.message : error,
      });
      // Default to false (production) if error
      return false;
    }
  }

  /**
   * Static trusted domains for external URL opening (Notely Cloud only).
   * User-configured custom server domains are checked dynamically.
   * Patterns support wildcards: *.example.com matches sub.example.com
   */
  private static readonly TRUSTED_DOMAINS = [
    '*.yourdomain.com', // All Notely Cloud services (api, portal, admin, calendar, etc.)
    'yourdomain.com', // Main Notely website
  ];

  /**
   * Check if a hostname matches a domain pattern.
   * Supports wildcards: *.example.com matches sub.example.com
   *
   * @param hostname - The hostname to check (e.g., 'api.yourdomain.com')
   * @param pattern - The pattern to match against (e.g., '*.yourdomain.com')
   */
  private static matchesPattern(hostname: string, pattern: string): boolean {
    const normalizedHost = hostname.toLowerCase();
    const normalizedPattern = pattern.toLowerCase();

    if (normalizedPattern.startsWith('*.')) {
      const baseDomain = normalizedPattern.slice(2);
      // Match exact base domain or any subdomain
      return normalizedHost === baseDomain || normalizedHost.endsWith('.' + baseDomain);
    }

    return normalizedHost === normalizedPattern;
  }

  /**
   * Check if a hostname matches any of the static trusted domains.
   */
  private static isStaticTrustedDomain(hostname: string): boolean {
    return WindowHandlers.TRUSTED_DOMAINS.some((pattern) =>
      WindowHandlers.matchesPattern(hostname, pattern)
    );
  }

  /**
   * Extract hostname from a URL string safely.
   * Returns null if the URL is invalid.
   */
  private static extractHostname(url: string): string | null {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  /**
   * Get the user-configured custom server hostname, if any.
   * Returns null if using Notely Cloud or no custom server is configured.
   */
  private async getCustomServerHostname(): Promise<string | null> {
    if (!this.deps.settings) {
      return null;
    }

    try {
      const serverUrl = await this.deps.settings.get('auth.serverUrl');
      if (!serverUrl) {
        return null;
      }

      const hostname = WindowHandlers.extractHostname(serverUrl);

      // Don't return Notely domains as "custom" - they're already in static list
      if (hostname && !WindowHandlers.isStaticTrustedDomain(hostname)) {
        logger.debug('WindowHandlers: Custom server hostname detected', { hostname });
        return hostname;
      }

      return null;
    } catch (error) {
      logger.warn('WindowHandlers: Failed to get custom server URL', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Check if a hostname is trusted (static domains + user's custom server).
   *
   * @param hostname - The hostname to validate
   * @param customServerHostname - The user's custom server hostname (if any)
   */
  private static isHostnameTrusted(hostname: string, customServerHostname: string | null): boolean {
    // Check static trusted domains first (Notely Cloud)
    if (WindowHandlers.isStaticTrustedDomain(hostname)) {
      return true;
    }

    // Check if it matches the user's custom server domain
    if (customServerHostname) {
      const normalizedHost = hostname.toLowerCase();
      const normalizedCustom = customServerHostname.toLowerCase();

      // Exact match or subdomain of custom server
      // e.g., if custom server is "mycompany.com", allow "api.mycompany.com"
      if (normalizedHost === normalizedCustom || normalizedHost.endsWith('.' + normalizedCustom)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Open external URL in default browser.
   * Validates URL protocol and domain before opening.
   *
   * Security: Only allows https:// URLs to trusted domains.
   * Trusted domains include:
   *   - Static: *.yourdomain.com (Notely Cloud services)
   *   - Dynamic: User's configured custom server domain (if self-hosting)
   *
   * This prevents malicious renderer code from opening arbitrary URLs,
   * file:// paths, or dangerous protocol handlers.
   */
  private async handleOpenExternal(
    _event: Electron.IpcMainInvokeEvent,
    url: string
  ): Promise<void> {
    try {
      // Parse and validate URL
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        logger.warn('WindowHandlers: Invalid URL format rejected', { url });
        throw new Error('Invalid URL format');
      }

      // Protocol validation - only allow https (and http for local dev convenience)
      const allowedProtocols = ['https:'];
      // Allow http only in development for local testing
      if (!app.isPackaged) {
        allowedProtocols.push('http:');
      }

      if (!allowedProtocols.includes(parsed.protocol)) {
        logger.warn('WindowHandlers: Blocked URL with disallowed protocol', {
          url,
          protocol: parsed.protocol,
        });
        throw new Error(`URL protocol '${parsed.protocol}' is not allowed`);
      }

      // Get user's custom server hostname for dynamic allowlist
      const customServerHostname = await this.getCustomServerHostname();

      // Domain allowlist validation (static + dynamic)
      if (!WindowHandlers.isHostnameTrusted(parsed.hostname, customServerHostname)) {
        logger.warn('WindowHandlers: Blocked URL to untrusted domain', {
          url,
          hostname: parsed.hostname,
          customServerHostname,
          trustedDomains: WindowHandlers.TRUSTED_DOMAINS,
        });
        throw new Error(`Domain '${parsed.hostname}' is not in the trusted list`);
      }

      logger.info('WindowHandlers: Opening validated external URL', {
        url,
        hostname: parsed.hostname,
        isCustomServer: customServerHostname === parsed.hostname,
      });
      await shell.openExternal(url);
      logger.debug('WindowHandlers: External URL opened successfully');
    } catch (error) {
      logger.error('WindowHandlers: Failed to open external URL', {
        url,
        error: error instanceof Error ? error.message : error,
      });
      throw error instanceof Error ? error : new Error('Failed to open external URL');
    }
  }

  /**
   * Update main window reference
   */
  updateMainWindow(mainWindow: BrowserWindow | null): void {
    logger.debug('WindowHandlers: Updating main window reference', {
      hasWindow: !!mainWindow,
    });
    this.deps.mainWindow = mainWindow;
  }

  /**
   * Cleanup and unregister handlers
   */
  cleanup(): void {
    logger.debug('WindowHandlers: Cleaning up IPC handlers');

    const handlers = [
      'window-control',
      'log:setLevel',
      'log:info',
      'log:warn',
      'log:error',
      'log:debug',
      'renderer-ready',
      'app:getVersion',
      'app:isDevelopment',
      'window:setTitlebarOverlay',
      'window:openExternal',
    ];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeAllListeners(handler);
      } catch (error) {
        logger.warn('WindowHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    logger.debug('WindowHandlers: Cleanup completed');
  }
}
