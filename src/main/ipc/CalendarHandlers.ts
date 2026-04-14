import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import { findServiceMatch, getServiceUrl } from '../config';
import { logger } from '../logger';
import type { ICalendarEventService } from '../storage/interfaces';

type AuthContext = {
  serverUrl: string;
  accessToken: string;
  userId: string | null;
};

type CalendarStatus = {
  connected: boolean;
  syncStatus?: string | null;
  lastSyncTime?: string | null;
  errorMessage?: string | null;
};

type CalendarHandlersDependencies = {
  authProvider: {
    getAuthContext: () => Promise<AuthContext | null>;
  } | null;
  mainWindow?: BrowserWindow | null;
  calendarService?: ICalendarEventService | null;
};

const ListEventsSchema = z.object({
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  timezone: z.string().optional(),
  maxResults: z.number().int().positive().optional(),
  useCache: z.boolean().optional(),
  forceRefresh: z.boolean().optional(),
});

const CACHE_TTL_MS = 5 * 60_000;
const AUTO_SYNC_INTERVAL_MS = 5 * 60_000; // 5 minutes
const SYNC_LOOKAHEAD_DAYS = 7;

export class CalendarHandlers {
  private mainWindow: BrowserWindow | null;
  private connectWindow: BrowserWindow | null = null;
  private connectResolved = false;
  private cachedUserId: string | null = null;
  private calendarService: ICalendarEventService | null;
  private autoSyncTimer: NodeJS.Timeout | null = null;
  private autoSyncEnabled = false;

  constructor(private deps: CalendarHandlersDependencies) {
    this.mainWindow = deps.mainWindow ?? null;
    this.calendarService = deps.calendarService ?? null;
  }

  register(): void {
    ipcMain.handle('calendar:getStatus', this.handleGetStatus.bind(this));
    ipcMain.handle('calendar:listEvents', this.handleListEvents.bind(this));
    ipcMain.handle('calendar:getConnectUrl', this.handleGetConnectUrl.bind(this));
    ipcMain.handle('calendar:startConnect', this.handleStartConnect.bind(this));
    ipcMain.handle('calendar:disconnect', this.handleDisconnect.bind(this));
  }

  updateMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
    if (
      this.connectWindow &&
      !this.connectWindow.isDestroyed() &&
      window &&
      !this.connectWindow.getParentWindow()
    ) {
      this.connectWindow.setParentWindow(window);
    }
  }

  private async getAuthContext(): Promise<AuthContext> {
    if (!this.deps.authProvider) {
      throw new Error('Calendar auth provider unavailable');
    }

    const context = await this.deps.authProvider.getAuthContext();
    if (!context || !context.accessToken || !context.serverUrl) {
      throw new Error('Calendar authentication not configured');
    }

    if (context.userId) {
      this.cachedUserId = context.userId;
    }

    if (!context.userId) {
      logger.warn('CalendarHandlers: Auth context missing userId');
    }

    return {
      ...context,
      serverUrl: this.normalizeBaseUrl(context.serverUrl),
    };
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private buildApiUrl(base: string, path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalizedPath}`;
  }

  private resolveCalendarBaseUrl(serverUrl: string): string {
    const normalized = this.normalizeBaseUrl(serverUrl);
    const match = findServiceMatch(normalized);

    if (match) {
      if (match.service === 'calendar') {
        return normalized;
      }

      try {
        const calendarUrl = getServiceUrl('calendar', match.env);
        if (calendarUrl) {
          const resolved = this.normalizeBaseUrl(calendarUrl);
          if (resolved !== normalized) {
            logger.debug('CalendarHandlers: Using dedicated calendar service base', {
              serverUrl: normalized,
              calendarUrl: resolved,
              env: match.env,
            });
          }
          return resolved;
        }
      } catch (error) {
        logger.warn('CalendarHandlers: Failed to resolve calendar service URL', {
          error: error instanceof Error ? error.message : error,
          serverUrl: normalized,
          env: match.env,
        });
      }
    }

    try {
      const parsedUrl = new URL(normalized);
      const host = parsedUrl.hostname;
      let candidateHost: string | null = null;

      if (host.includes('notely')) {
        if (host.startsWith('api.')) {
          candidateHost = host.replace(/^api\./, 'calendar.');
        } else if (host.startsWith('api-')) {
          candidateHost = host.replace(/^api-/, 'calendar-');
        }
      }

      if (candidateHost) {
        parsedUrl.hostname = candidateHost;
        const derived = this.normalizeBaseUrl(parsedUrl.toString());
        logger.debug('CalendarHandlers: Derived calendar service host from API base', {
          serverUrl: normalized,
          calendarUrl: derived,
        });
        return derived;
      }
    } catch (error) {
      logger.debug('CalendarHandlers: Unable to derive calendar service host', {
        error: error instanceof Error ? error.message : error,
        serverUrl: normalized,
      });
    }

    return normalized;
  }

  private buildCalendarApiUrl(serverUrl: string, path: string): string {
    const base = this.resolveCalendarBaseUrl(serverUrl);
    return this.buildApiUrl(base, path);
  }

  private async handleGetStatus(): Promise<CalendarStatus> {
    // Check if we have auth context before trying to fetch status
    if (!this.deps.authProvider) {
      return { connected: false };
    }

    const context = await this.deps.authProvider.getAuthContext();
    if (!context || !context.accessToken || !context.serverUrl) {
      // Not authenticated - return disconnected status without logging error
      return { connected: false };
    }

    try {
      const serverUrl = this.normalizeBaseUrl(context.serverUrl);
      const response = await fetch(this.buildApiUrl(serverUrl, '/api/outlook/status'), {
        headers: {
          Authorization: `Bearer ${context.accessToken}`,
          Accept: 'application/json',
        },
      });

      const data = await response.json();
      if (!response.ok || !data?.success) {
        const error = data?.error || 'Failed to load calendar status';
        logger.warn('CalendarHandlers: Status request failed', { error });
        throw new Error(error);
      }

      const status = data.data as CalendarStatus | undefined;
      return (
        status || {
          connected: false,
        }
      );
    } catch (error) {
      logger.error('CalendarHandlers: Failed to fetch status', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private async handleListEvents(
    _event: Electron.IpcMainInvokeEvent,
    payload: unknown
  ): Promise<unknown[]> {
    const input = ListEventsSchema.parse(payload);
    const rangeStartMs = Date.parse(input.startTime);
    const rangeEndMs = Date.parse(input.endTime);

    if (Number.isNaN(rangeStartMs) || Number.isNaN(rangeEndMs)) {
      throw new Error('Invalid calendar time range provided');
    }

    if (rangeEndMs < rangeStartMs) {
      throw new Error('Calendar range end must be after start');
    }

    try {
      const context = await this.getAuthContext();
      const userId = await this.resolveUserId(context);
      const { serverUrl, accessToken } = context;
      if (!userId) {
        throw new Error('Calendar events unavailable without linked user');
      }

      const accountId = userId;
      let cachedEvents: unknown[] = [];
      let cacheSyncedAt: number | null = null;

      if (this.calendarService) {
        try {
          const cached = await this.calendarService.listRange(accountId, rangeStartMs, rangeEndMs);
          cachedEvents = cached.events;
          cacheSyncedAt = cached.syncedAt;
        } catch (cacheError) {
          logger.debug('CalendarHandlers: Unable to read calendar cache', {
            error: cacheError instanceof Error ? cacheError.message : cacheError,
          });
        }
      }

      const now = Date.now();
      const prefersCache = input.useCache !== false && input.forceRefresh !== true;
      const cacheIsFresh = cacheSyncedAt !== null && now - cacheSyncedAt < CACHE_TTL_MS;

      if (prefersCache && cacheIsFresh) {
        return cachedEvents;
      }

      const params = new URLSearchParams({
        startTime: input.startTime,
        endTime: input.endTime,
      });

      if (input.timezone) params.set('timezone', input.timezone);
      if (input.maxResults) params.set('maxResults', String(input.maxResults));
      if (input.useCache === false) params.set('useCache', 'false');
      if (input.forceRefresh) params.set('forceRefresh', 'true');

      const endpoint = this.buildApiUrl(serverUrl, '/api/outlook/events');

      const shouldFetchRemote =
        input.forceRefresh === true ||
        input.useCache === false ||
        !cacheIsFresh ||
        cacheSyncedAt === null;

      if (!shouldFetchRemote) {
        return cachedEvents;
      }

      try {
        const response = await fetch(`${endpoint}?${params.toString()}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });

        const data = await response.json();

        if (!response.ok || !data?.success) {
          const error = data?.error || 'Failed to load calendar events';
          logger.warn('CalendarHandlers: Event request failed', { error });
          throw new Error(error);
        }

        const responseData = data.data as { events?: unknown[] } | undefined;
        const events = Array.isArray(responseData?.events) ? responseData.events : [];
        const syncedAt = Date.now();

        if (this.calendarService) {
          this.calendarService
            .replaceRange(accountId, rangeStartMs, rangeEndMs, events, syncedAt)
            .catch((cacheError) => {
              logger.warn('CalendarHandlers: Failed to update calendar cache', {
                error: cacheError instanceof Error ? cacheError.message : cacheError,
              });
            });
        }

        return events;
      } catch (remoteError) {
        if (cachedEvents.length > 0) {
          logger.warn('CalendarHandlers: Remote fetch failed, falling back to cached events', {
            error: remoteError instanceof Error ? remoteError.message : remoteError,
          });
          return cachedEvents;
        }
        throw remoteError;
      }
    } catch (error) {
      logger.error('CalendarHandlers: Failed to fetch events', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private async handleGetConnectUrl(): Promise<string> {
    try {
      const { serverUrl, accessToken } = await this.getAuthContext();
      const response = await fetch(this.buildApiUrl(serverUrl, '/api/outlook/auth'), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      const data = await response.json();
      if (!response.ok || !data?.success || !data?.data?.authUrl) {
        const error = data?.error || 'Failed to start calendar connection';
        logger.warn('CalendarHandlers: Connect URL request failed', { error });
        throw new Error(error);
      }

      return data.data.authUrl as string;
    } catch (error) {
      logger.error('CalendarHandlers: Failed to request connect URL', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private async handleStartConnect(): Promise<boolean> {
    try {
      const { serverUrl, accessToken } = await this.getAuthContext();
      const response = await fetch(this.buildApiUrl(serverUrl, '/api/outlook/auth'), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      const data = await response.json();
      if (!response.ok || !data?.success || !data?.data?.authUrl) {
        const error = data?.error || 'Failed to start calendar connection';
        logger.warn('CalendarHandlers: startConnect failed to retrieve URL', { error });
        throw new Error(error);
      }

      this.openConnectWindow(data.data.authUrl as string);
      return true;
    } catch (error) {
      logger.error('CalendarHandlers: Failed to start connect flow', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private openConnectWindow(authUrl: string): void {
    if (!authUrl) {
      throw new Error('Unable to open connect window without authorization URL');
    }

    const existing = this.connectWindow;
    this.connectResolved = false;

    if (existing && !existing.isDestroyed()) {
      existing.loadURL(authUrl).catch((error) => {
        logger.error('CalendarHandlers: Failed to load connect URL in existing window', {
          error: error instanceof Error ? error.message : error,
        });
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('calendar:connect-result', {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        this.connectResolved = true;
        if (!existing.isDestroyed()) {
          existing.close();
        }
      });
      existing.focus();
      return;
    }

    const popup = new BrowserWindow({
      width: 640,
      height: 720,
      resizable: true,
      parent: this.mainWindow ?? undefined,
      modal: false,
      title: 'Connect Calendar',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    popup.setMenuBarVisibility(false);
    this.connectWindow = popup;

    const handleNavigation = (_event: Electron.Event, url: string) => {
      this.evaluateConnectResult(url);
    };

    const handleInPageNavigation = (_event: Electron.Event, url: string) => {
      this.evaluateConnectResult(url);
    };

    popup.webContents.on('will-redirect', handleNavigation);
    popup.webContents.on('did-navigate', handleNavigation);
    popup.webContents.on('did-navigate-in-page', handleInPageNavigation);

    popup.on('closed', () => {
      // Note: webContents is already destroyed when 'closed' fires,
      // so we don't need to manually remove listeners - they're cleaned up automatically
      this.connectWindow = null;
      if (!this.connectResolved && this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('calendar:connect-result', {
          success: false,
          canceled: true,
        });
      }
      this.connectResolved = false;
    });

    popup.loadURL(authUrl).catch((error) => {
      logger.error('CalendarHandlers: Failed to load connect URL', {
        error: error instanceof Error ? error.message : error,
      });
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('calendar:connect-result', {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.connectResolved = true;
      if (!popup.isDestroyed()) {
        popup.close();
      }
      throw error;
    });
  }

  private evaluateConnectResult(targetUrl: string): void {
    try {
      const parsed = new URL(targetUrl);
      if (!parsed.pathname.endsWith('/outlook-connected')) {
        return;
      }

      const success = parsed.searchParams.get('success') === 'true';
      const error = parsed.searchParams.get('error');

      this.connectResolved = true;
      if (this.connectWindow && !this.connectWindow.isDestroyed()) {
        this.connectWindow.close();
      }

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('calendar:connect-result', {
          success,
          error: error || null,
        });
      }

      // Start auto-sync if connection was successful
      if (success) {
        this.startAutoSync().catch((syncError) => {
          logger.warn('CalendarHandlers: Failed to start auto-sync after connect', {
            error: syncError instanceof Error ? syncError.message : syncError,
          });
        });
      }
    } catch (error) {
      logger.debug('CalendarHandlers: Unable to parse navigation URL', {
        error: error instanceof Error ? error.message : error,
        targetUrl,
      });
    }
  }

  private async resolveUserId(context: AuthContext): Promise<string> {
    if (context.userId) {
      return context.userId;
    }

    if (this.cachedUserId) {
      return this.cachedUserId;
    }

    const response = await fetch(this.buildApiUrl(context.serverUrl, '/api/users/me'), {
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
        Accept: 'application/json',
      },
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const errorMessage =
        payload?.error ||
        payload?.message ||
        `Failed to determine user profile (status ${response.status})`;
      throw new Error(errorMessage);
    }

    const data = payload?.data ?? payload ?? {};
    const resolvedId =
      data?.id ??
      data?.user_id ??
      data?.userId ??
      (typeof data?.user === 'object' ? data.user?.id : undefined);

    if (!resolvedId) {
      throw new Error('Unable to determine user identifier for calendar requests');
    }

    this.cachedUserId = String(resolvedId);
    return this.cachedUserId;
  }

  private async handleDisconnect(): Promise<boolean> {
    try {
      const context = await this.getAuthContext();
      const { serverUrl, accessToken, userId } = context;
      const response = await fetch(this.buildApiUrl(serverUrl, '/api/outlook/disconnect'), {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      let payload: unknown = null;
      try {
        const text = await response.text();
        payload = text ? JSON.parse(text) : null;
      } catch (parseError) {
        logger.debug('CalendarHandlers: disconnect response is not JSON', {
          error: parseError instanceof Error ? parseError.message : parseError,
        });
      }

      if (!response.ok || (payload as { success?: boolean })?.success === false) {
        const errorMessage =
          (payload as { error?: string })?.error ||
          `Failed to disconnect calendar (status ${response.status})`;
        throw new Error(errorMessage);
      }

      const accountId = userId || this.cachedUserId;
      if (this.calendarService && accountId) {
        try {
          await this.calendarService.clearAccount(accountId);
        } catch (cacheError) {
          logger.warn('CalendarHandlers: Failed to clear calendar cache on disconnect', {
            error: cacheError instanceof Error ? cacheError.message : cacheError,
          });
        }
      }

      // Stop auto-sync when disconnecting
      this.stopAutoSync();

      return true;
    } catch (error) {
      logger.error('CalendarHandlers: Failed to disconnect calendar', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Start automatic calendar syncing.
   * Syncs calendar events from current day forward every few minutes.
   */
  async startAutoSync(): Promise<void> {
    if (this.autoSyncEnabled) {
      logger.debug('CalendarHandlers: Auto-sync already enabled');
      return;
    }

    // Check if calendar is connected before starting
    try {
      const status = await this.handleGetStatus();
      if (!status.connected) {
        logger.debug('CalendarHandlers: Calendar not connected, skipping auto-sync start');
        return;
      }
    } catch (error) {
      logger.debug('CalendarHandlers: Failed to check calendar status for auto-sync', {
        error: error instanceof Error ? error.message : error,
      });
      return;
    }

    this.autoSyncEnabled = true;
    logger.info('CalendarHandlers: Starting auto-sync');

    // Perform initial sync
    await this.performAutoSync();

    // Schedule periodic syncs
    this.autoSyncTimer = setInterval(() => {
      this.performAutoSync().catch((error) => {
        logger.warn('CalendarHandlers: Auto-sync failed', {
          error: error instanceof Error ? error.message : error,
        });
      });
    }, AUTO_SYNC_INTERVAL_MS);
  }

  /**
   * Stop automatic calendar syncing.
   */
  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.autoSyncEnabled = false;
    logger.debug('CalendarHandlers: Auto-sync stopped');
  }

  /**
   * Perform a background calendar sync.
   * Syncs events from start of today to SYNC_LOOKAHEAD_DAYS days ahead.
   */
  private async performAutoSync(): Promise<void> {
    try {
      // Verify we have auth context
      const context = await this.getAuthContext();
      if (!context.accessToken) {
        logger.debug('CalendarHandlers: No auth token for auto-sync');
        return;
      }

      // Check if calendar is still connected
      const status = await this.handleGetStatus();
      if (!status.connected) {
        logger.debug('CalendarHandlers: Calendar disconnected, stopping auto-sync');
        this.stopAutoSync();
        return;
      }

      // Calculate time range: from start of today to lookahead days
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endDate = new Date(startOfToday);
      endDate.setDate(endDate.getDate() + SYNC_LOOKAHEAD_DAYS);

      logger.debug('CalendarHandlers: Performing auto-sync', {
        startTime: startOfToday.toISOString(),
        endTime: endDate.toISOString(),
      });

      // Fetch events with force refresh to bypass cache
      await this.handleListEvents({} as Electron.IpcMainInvokeEvent, {
        startTime: startOfToday.toISOString(),
        endTime: endDate.toISOString(),
        maxResults: 200,
        forceRefresh: true,
      });

      logger.info('CalendarHandlers: Auto-sync completed');
    } catch (error) {
      logger.warn('CalendarHandlers: Auto-sync error', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Check if auto-sync is currently active.
   */
  isAutoSyncActive(): boolean {
    return this.autoSyncEnabled;
  }
}
