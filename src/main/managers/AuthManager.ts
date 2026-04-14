import * as crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BrowserWindow, app } from 'electron';

import { parseDeepLink } from '../../common/deeplink';
import { type IAuthService } from '../auth';
import { DEFAULT_API_URL, DEV_SERVER_URL } from '../config';
import { logger } from '../logger';
import { type IStorageService } from '../storage';
import {
  storeOAuthState,
  validateAndConsumeOAuthState,
  consumeOAuthStateByDesktopSessionId,
  oauthStateManager,
} from '../utils/oauth-state';
import {
  generatePKCEPair,
  generateState,
  buildAuthorizationUrl,
  parseAuthorizationCallback,
} from '../utils/pkce';

const PROTOCOL = 'notely';

export interface AuthManagerOptions {
  authService: IAuthService;
  storage: IStorageService;
  mainWindow?: BrowserWindow | null;
}

/**
 * AuthManager handles OAuth authentication flow including:
 * - OAuth popup window creation and management
 * - PKCE flow implementation
 * - Deep link callback handling
 * - Token exchange and account linking
 */
export class AuthManager {
  private authWindow: BrowserWindow | null = null;
  private pendingDeepLink: string | null = null;
  private authCompleted = false;
  private rendererDevServerReady: boolean | null = null;
  private processingDesktopSessionId: string | null = null;
  /** Guard flag: true while loadAuthWindowContent is actively loading (prevents did-fail-load from destroying the window during fallback). */
  private isLoadingAuthContent = false;
  private readonly authService: IAuthService;
  private readonly storage: IStorageService;

  constructor(private options: AuthManagerOptions) {
    this.authService = options.authService;
    this.storage = options.storage;
    this.setupEventListeners();
  }

  private generateDesktopSessionId(): string {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    return crypto.randomBytes(16).toString('hex');
  }

  private async getServerUrl(): Promise<string | null> {
    try {
      return await this.storage.settings.get('auth.serverUrl');
    } catch (error) {
      logger.warn('AuthManager: Failed to read server URL from settings', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Setup deep link and OAuth callback event listeners
   */
  private setupEventListeners(): void {
    // Handle OAuth callback deep links
    app.on('open-url', (event, url) => {
      event.preventDefault();
      this.handleDeepLink(url);
    });

    // Handle second instance with deep links (Windows)
    app.on('second-instance', (_event, argv) => {
      if (process.platform === 'win32') {
        this.captureArgvDeepLink(argv);
      }

      // Focus main window and handle pending deep link
      if (this.options.mainWindow) {
        if (this.options.mainWindow.isMinimized()) {
          this.options.mainWindow.restore();
        }
        this.options.mainWindow.focus();

        if (this.pendingDeepLink) {
          this.handleDeepLink(this.pendingDeepLink);
          this.pendingDeepLink = null;
        }
      }
    });
  }

  /**
   * Capture deep link from command line arguments (Windows)
   */
  private captureArgvDeepLink(argv: string[]): void {
    const url = argv.find((arg) => arg.startsWith(PROTOCOL + ':'));
    if (url) {
      this.pendingDeepLink = url;
    }
  }

  /**
   * Handle deep link URLs for OAuth callbacks and navigation
   */
  private handleDeepLink(url: string): void {
    logger.debug('AuthManager: Processing deep link', { url });

    // Parse general deep link for navigation
    const parsed = parseDeepLink(url);
    if (parsed && this.options.mainWindow) {
      this.options.mainWindow.webContents.send('deep-link', parsed.route);
    } else {
      this.pendingDeepLink = url;
    }

    // Handle OAuth authorization callback
    try {
      const authCallback = parseAuthorizationCallback(url);
      if (authCallback) {
        this.handleAuthCallback(authCallback);
      }
    } catch (error) {
      logger.warn('AuthManager: Failed to parse auth callback', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Handle OAuth authorization callback with error handling and token exchange
   */
  private handleAuthCallback(callback: {
    code?: string;
    state?: string;
    desktopSessionId?: string;
    error?: string;
    errorDescription?: string;
  }): void {
    const { code, state, desktopSessionId, error, errorDescription } = callback;

    logger.info('AuthManager: Processing OAuth callback', {
      hasCode: !!code,
      hasState: !!state,
      hasDesktopSessionId: !!desktopSessionId,
      hasError: !!error,
    });

    if (this.authCompleted) {
      logger.info('AuthManager: Ignoring OAuth callback because auth already completed');
      return;
    }

    // Handle OAuth errors from server
    if (error) {
      logger.warn('AuthManager: OAuth authorization error', { error, errorDescription });
      this.notifyAuthComplete({
        success: false,
        error: errorDescription || error,
      });
      this.closeAuthWindow();
      return;
    }

    if (desktopSessionId && this.processingDesktopSessionId === desktopSessionId) {
      logger.info('AuthManager: Duplicate OAuth callback detected, ignoring', {
        desktopSessionId: desktopSessionId.substring(0, 8),
      });
      return;
    }

    // Validate required parameters
    if (!code) {
      logger.warn('AuthManager: Auth callback missing required parameters', {
        hasCode: !!code,
        hasState: !!state,
      });
      this.notifyAuthComplete({
        success: false,
        error: 'Invalid authorization response',
      });
      this.closeAuthWindow();
      return;
    }

    // Validate and consume state using OAuth state manager
    let stateValidation =
      state && state.length
        ? validateAndConsumeOAuthState(state)
        : { valid: false, error: 'State parameter not provided' };

    if ((!stateValidation.valid || !stateValidation.desktopSessionId) && desktopSessionId) {
      logger.warn('AuthManager: OAuth state mismatch, falling back to session lookup', {
        stateProvided: !!state,
        validationError: stateValidation.error,
      });
      stateValidation = consumeOAuthStateByDesktopSessionId(desktopSessionId);
    }

    if (!stateValidation.valid) {
      logger.warn('AuthManager: OAuth session validation failed', {
        error: stateValidation.error,
        desktopSessionId: desktopSessionId?.substring(0, 8),
      });
      this.notifyAuthComplete({
        success: false,
        error: stateValidation.error || 'Authentication session mismatch. Please try again.',
      });
      this.closeAuthWindow();
      return;
    }

    const { codeVerifier, desktopSessionId: expectedDesktopSessionId } = stateValidation;

    if (!desktopSessionId || !expectedDesktopSessionId) {
      logger.warn('AuthManager: Missing desktop session identifier in callback/state', {
        desktopSessionId,
        expectedDesktopSessionId,
      });
      this.notifyAuthComplete({
        success: false,
        error: 'Authentication session expired. Please try again.',
      });
      this.closeAuthWindow();
      return;
    }

    if (desktopSessionId !== expectedDesktopSessionId) {
      logger.warn('AuthManager: Desktop session mismatch', {
        desktopSessionId,
        expectedDesktopSessionId,
      });
      this.notifyAuthComplete({
        success: false,
        error: 'Authentication session mismatch. Please try again.',
      });
      this.closeAuthWindow();
      return;
    }

    this.processingDesktopSessionId = desktopSessionId;

    logger.info('AuthManager: Exchanging authorization code for tokens', {
      codeLength: code.length,
      verifierLength: codeVerifier ? codeVerifier.length : 0,
      desktopSessionId: desktopSessionId.substring(0, 8) + '...',
    });

    this.authService
      .exchangeAuthCode(code, codeVerifier || '', desktopSessionId)
      .then(async (result) => {
        if (!result.success) {
          logger.warn('AuthManager: Token exchange failed', { error: result.error });
          this.notifyAuthComplete({ success: false, error: result.error });
        } else {
          logger.info('AuthManager: Token exchange successful, authentication complete');
          this.notifyAuthComplete({ success: true });
        }
        this.closeAuthWindow();
      })
      .catch((error) => {
        logger.error('AuthManager: Token exchange error', {
          error: error instanceof Error ? error.message : error,
        });
        this.notifyAuthComplete({
          success: false,
          error: 'Token exchange failed',
        });
        this.closeAuthWindow();
      })
      .finally(() => {
        this.processingDesktopSessionId = null;
      });
  }

  /**
   * Notify main window of authentication completion
   */
  private notifyAuthComplete(result: { success: boolean; error?: string }): void {
    if (this.authCompleted) return;
    if (this.options.mainWindow) {
      this.options.mainWindow.webContents.send('auth:completed', result);
      this.authCompleted = true;
    }
  }

  /**
   * Close OAuth authentication window safely
   */
  private closeAuthWindow(): void {
    if (this.authWindow && !this.authWindow.isDestroyed()) {
      try {
        this.authWindow.close();
      } catch (error) {
        logger.warn('AuthManager: Error closing auth window', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }
    this.authWindow = null;
  }

  /**
   * Create OAuth authentication popup window
   */
  private createAuthWindow(preloadPath: string): BrowserWindow {
    logger.info('AuthManager: Creating OAuth authentication window');

    this.authWindow = new BrowserWindow({
      width: 400,
      height: 680,
      resizable: true,
      title: 'Sign in to Notely',
      modal: false,
      parent: this.options.mainWindow ?? undefined,
      autoHideMenuBar: true, // Hide the menu bar (File, Edit, View, etc.)
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: app.isPackaged ? true : false,
        webSecurity: app.isPackaged ? true : false,
        allowRunningInsecureContent: !app.isPackaged,
      },
    });

    // Add debug logging for auth window
    this.attachWebContentsDebug(this.authWindow.webContents);

    // Intercept deep-link redirects inside the popup to avoid rendering placeholders (e.g., "{}")
    const wc = this.authWindow.webContents;
    const handlePossibleDeepLink = (event: Electron.Event, url: string) => {
      if (!url) return;
      if (url.startsWith(`${PROTOCOL}://`)) {
        event.preventDefault();
        logger.info('AuthManager: Intercepted deep link in popup, handling via main process');
        try {
          this.handleDeepLink(url);
        } finally {
          // Close the popup promptly for better UX
          this.closeAuthWindow();
        }
      }
    };

    // Note: will-redirect and will-navigate don't fire for custom protocols (Electron bug)
    // So we also use webRequest to intercept redirects to notely:// protocol
    wc.session.webRequest.onBeforeRedirect((details) => {
      if (details.redirectURL && details.redirectURL.startsWith(`${PROTOCOL}://`)) {
        logger.info('AuthManager: Intercepted deep link redirect via webRequest');
        // Handle the deep link in the next tick to avoid blocking the redirect
        setImmediate(() => {
          try {
            this.handleDeepLink(details.redirectURL);
          } finally {
            this.closeAuthWindow();
          }
        });
      }
    });

    // Note: Electron's webRequest URL filter does not accept custom schemes like notely://
    // Registering onBeforeRequest with a custom-scheme pattern throws
    // "Invalid url pattern notely://*: Wrong scheme type." on some platforms.
    // We rely on onBeforeRedirect + will-redirect/will-navigate handlers above instead.

    wc.on('will-redirect', (event, url) => handlePossibleDeepLink(event, url));
    wc.on('will-navigate', (event, url) => handlePossibleDeepLink(event, url));

    // Handle did-redirect-navigation for deep links (some Electron versions emit this)
    wc.on('did-redirect-navigation', (_event, url) => {
      if (url && url.startsWith(`${PROTOCOL}://`)) {
        logger.info('AuthManager: did-redirect-navigation deep link observed');
        try {
          this.handleDeepLink(url);
        } finally {
          this.closeAuthWindow();
        }
      }
    });

    this.authWindow.on('closed', () => {
      logger.debug('AuthManager: Auth window closed');
      this.authWindow = null;
    });

    return this.authWindow;
  }

  /**
   * Resolve preload script for the auth popup.
   */
  private resolvePreloadScript(): string | null {
    const preloadJs = path.join(__dirname, 'preload.js');
    const preloadCjs = path.join(__dirname, 'preload.cjs');
    const preloadPath = fs.existsSync(preloadJs)
      ? preloadJs
      : fs.existsSync(preloadCjs)
        ? preloadCjs
        : preloadJs;

    if (!fs.existsSync(preloadPath)) {
      logger.error('AuthManager: Preload script missing for auth window', {
        preloadJs,
        preloadCjs,
      });
      return null;
    }

    return preloadPath;
  }

  /**
   * Load the local auth UI into the popup, preferring the dev server during local development.
   */
  private async loadAuthWindowContent(window: BrowserWindow): Promise<void> {
    const distPath = path.join(__dirname, '../dist/renderer/auth.html');
    const devEntry = `${DEV_SERVER_URL}/auth.html`;
    const isCoverage = process.env.COVERAGE === 'true' || process.env.COVERAGE === '1';
    const hasBuiltFiles = fs.existsSync(distPath);

    // Guard: prevent did-fail-load from destroying the window during fallback
    this.isLoadingAuthContent = true;
    try {
      if (app.isPackaged || isCoverage) {
        if (!hasBuiltFiles) {
          throw new Error(`Auth UI bundle missing at ${distPath}`);
        }
        await window.loadFile(distPath);
        return;
      }

      if (this.rendererDevServerReady !== false) {
        try {
          await window.loadURL(devEntry);
          this.rendererDevServerReady = true;
          return;
        } catch (error) {
          this.rendererDevServerReady = false;
          logger.warn(
            'AuthManager: Failed to load auth window from dev server, falling back to built files',
            {
              error: error instanceof Error ? error.message : error,
            }
          );
        }
      }

      if (!hasBuiltFiles) {
        throw new Error(
          `Auth UI bundle missing at ${distPath} and dev server unavailable - cannot launch auth window`
        );
      }

      await window.loadFile(distPath);
    } finally {
      this.isLoadingAuthContent = false;
    }
  }

  /**
   * Attach debug event listeners to WebContents
   */
  private attachWebContentsDebug(webContents: Electron.WebContents): void {
    webContents.on('did-start-loading', () =>
      logger.debug('AuthManager WebContents: did-start-loading')
    );
    webContents.on('did-finish-load', () =>
      logger.info('AuthManager WebContents: did-finish-load')
    );
    webContents.on('did-fail-load', (_event, code, desc, url, isMainFrame) => {
      logger.error('AuthManager WebContents: did-fail-load', {
        code,
        desc,
        url,
        isMainFrame,
      });
      // Skip destruction while loadAuthWindowContent is trying fallback URLs
      if (this.isLoadingAuthContent) {
        logger.debug(
          'AuthManager: Suppressing did-fail-load during content loading (fallback pending)'
        );
        return;
      }
      if (isMainFrame && !this.authCompleted) {
        this.notifyAuthComplete({
          success: false,
          error: `Sign-in page failed to load (${code}): ${desc}`,
        });
        this.closeAuthWindow();
      }
    });
    webContents.on('dom-ready', () => logger.debug('AuthManager WebContents: dom-ready'));
  }

  /**
   * Ensure the auth popup exists and is loaded with the local UI.
   */
  private async ensureAuthWindow(): Promise<BrowserWindow | null> {
    if (this.authWindow && !this.authWindow.isDestroyed()) {
      try {
        // Reload local UI if we previously navigated away (e.g., after OAuth attempt)
        const currentUrl = this.authWindow.webContents.getURL();
        if (!currentUrl || !currentUrl.includes('auth.html')) {
          await this.loadAuthWindowContent(this.authWindow);
        }
        return this.authWindow;
      } catch (error) {
        logger.warn('AuthManager: Existing auth window reload failed, recreating', {
          error: error instanceof Error ? error.message : error,
        });
        try {
          this.closeAuthWindow();
        } catch {
          /* ignore */
        }
      }
    }

    const preloadPath = this.resolvePreloadScript();
    if (!preloadPath) {
      return null;
    }

    const window = this.createAuthWindow(preloadPath);

    try {
      await this.loadAuthWindowContent(window);
    } catch (error) {
      logger.error('AuthManager: Failed to load auth UI', {
        error: error instanceof Error ? error.message : error,
      });
      try {
        window.destroy();
      } catch {
        /* ignore */
      }
      return null;
    }

    this.authWindow = window;
    return window;
  }

  /**
   * Start OAuth web-based login flow
   * Returns true if auth window was successfully opened
   */
  async startWebLogin(): Promise<boolean> {
    try {
      this.authCompleted = false;
      this.pendingDeepLink = null;
      this.processingDesktopSessionId = null;

      const window = await this.ensureAuthWindow();
      if (!window) {
        this.notifyAuthComplete({
          success: false,
          error: 'Unable to open authentication window. Please try again.',
        });
        return false;
      }

      try {
        window.center();
      } catch {
        /* ignore positioning errors */
      }
      window.show();
      window.focus();

      logger.info('AuthManager: Auth popup displayed');
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('AuthManager: Failed to start web login', { error: message });
      // Surface a user-visible error to the renderer
      this.notifyAuthComplete({ success: false, error: `Could not open sign-in page: ${message}` });
      this.closeAuthWindow();
      return false;
    }
  }

  /**
   * Trigger the Microsoft OAuth flow by redirecting the auth popup to the platform endpoint.
   */
  async beginMicrosoftLogin(): Promise<{ success: boolean; error?: string }> {
    try {
      this.authCompleted = false;
      this.pendingDeepLink = null;
      this.processingDesktopSessionId = null;

      const window = await this.ensureAuthWindow();
      if (!window) {
        return { success: false, error: 'Authentication window is unavailable' };
      }

      const serverUrl = (await this.getServerUrl()) || DEFAULT_API_URL;

      const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePKCEPair();
      const state = generateState();
      const redirectUri = `${PROTOCOL}://auth/callback`;
      const desktopSessionId = this.generateDesktopSessionId();

      storeOAuthState({
        state,
        codeVerifier,
        redirectUri,
        desktopSessionId,
      });

      const loginUrl = buildAuthorizationUrl({
        baseUrl: serverUrl,
        state,
        codeChallenge,
        codeChallengeMethod,
        desktopSessionId,
        returnTo: redirectUri,
      });

      logger.info('AuthManager: Redirecting to Microsoft login', {
        serverUrl,
        state: state.substring(0, 8) + '...',
        desktopSessionId: desktopSessionId.substring(0, 8) + '...',
      });

      await window.loadURL(loginUrl);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('AuthManager: Failed to initiate Microsoft login', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Execute credential-based login from the auth popup.
   */
  async loginWithPassword(
    email: string,
    password: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!(await this.ensureAuthWindow())) {
      return { success: false, error: 'Authentication window is unavailable' };
    }

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      return { success: false, error: 'Email and password are required' };
    }

    try {
      const authResult = await this.authService.authenticateWithPassword(trimmedEmail, password);
      if (!authResult?.success) {
        return {
          success: false,
          error: authResult?.error || 'Authentication failed. Please check your credentials.',
        };
      }

      logger.info('AuthManager: Credential login completed successfully');
      this.notifyAuthComplete({ success: true });
      this.closeAuthWindow();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('AuthManager: Credential login failed', { error: message });
      return { success: false, error: message };
    }
  }

  /**
   * Handle pending deep link if available (called when main window is ready)
   */
  handlePendingDeepLink(): void {
    if (this.pendingDeepLink && this.options.mainWindow) {
      const parsed = parseDeepLink(this.pendingDeepLink);
      if (parsed) {
        this.options.mainWindow.webContents.send('deep-link', parsed.route);
      }
      this.pendingDeepLink = null;
    }
  }

  /**
   * Initialize auth manager with command line arguments (for Windows deep links)
   */
  initializeWithArgv(argv: string[]): void {
    if (process.platform === 'win32') {
      this.captureArgvDeepLink(argv);
    }
  }

  /**
   * Cleanup resources and event listeners
   */
  destroy(): void {
    this.closeAuthWindow();

    // Cleanup OAuth state manager
    try {
      oauthStateManager.destroy();
      logger.info('AuthManager: OAuth state manager cleaned up');
    } catch (error) {
      logger.warn('AuthManager: Error cleaning up OAuth state manager', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
