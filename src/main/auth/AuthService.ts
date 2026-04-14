import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';

import { DEFAULT_API_URL } from '../config';
import { logger } from '../logger';
import {
  pinnedFetch,
  type IKeystoreService,
  type KeystoreScope,
  getKeystoreService,
  KeystoreError,
} from '../services/security';
import { type IStorageService } from '../storage';
import { type IUserService } from '../storage/interfaces/IUserService';

type AuthSuccessResponse = {
  token: string;
  expiresAt: string;
  scopes?: string[];
  user?: {
    id: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    role?: string;
  };
};

type DesktopExchangeResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  access_expires_at?: string;
  refresh_expires_at?: string;
};

type RefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  access_expires_at?: string;
  refresh_expires_at?: string;
  expires_in?: number;
};

type UserProfileResponse = {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  role?: string;
  scopes?: string[];
};

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
};

export type AuthContext = {
  serverUrl: string;
  accessToken: string;
  userId: string | null;
};

export type AuthStatus = {
  isConfigured: boolean;
  isLinked: boolean;
  hasValidAccessToken: boolean;
  tokenExpiresAt: Date | null;
  userId: string | null;
  deviceId: string | null;
};

export type AuthResult = {
  success: boolean;
  error?: string;
  refreshed?: boolean; // true = tokens were refreshed, false = no refresh needed, undefined = operation failed or N/A
};

export interface IAuthService {
  authenticateWithPassword(email: string, password: string): Promise<AuthResult>;
  exchangeAuthCode(
    code: string,
    codeVerifier: string,
    desktopSessionId: string
  ): Promise<AuthResult>;
  linkAccount(): Promise<AuthResult>;
  refreshTokens(force?: boolean): Promise<AuthResult>;
  getAuthContext(): Promise<AuthContext | null>;
  getAuthStatus(): Promise<AuthStatus>;
  logout(options?: { remote?: boolean }): Promise<AuthResult>;
}

type AuthServiceOptions = {
  storage: IStorageService;
  userService?: IUserService;
  deviceNameProvider?: () => string;
  defaultServerUrl?: string;
  onAuthSuccess?: () => Promise<void>;
  keystoreService?: IKeystoreService;
};

function isApiEnvelope<T>(payload: unknown): payload is ApiEnvelope<T> {
  return typeof payload === 'object' && payload !== null && 'success' in (payload as object);
}

export class AuthService extends EventEmitter implements IAuthService {
  private readonly getDeviceName: () => string;
  private readonly defaultServerUrl: string;
  private readonly keystoreService: IKeystoreService;
  private isRefreshing: boolean = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly REFRESH_CHECK_INTERVAL = 60 * 1000; // Check every minute
  private readonly REFRESH_THRESHOLD_PERCENT = 0.8; // Refresh at 80% of lifetime

  constructor(private readonly options: AuthServiceOptions) {
    super(); // Call EventEmitter constructor
    this.keystoreService = options.keystoreService ?? getKeystoreService();
    this.getDeviceName =
      options.deviceNameProvider ??
      (() => {
        try {
          return os.hostname();
        } catch (error) {
          logger.warn('AuthService: Failed to resolve hostname, using fallback', {
            error: error instanceof Error ? error.message : error,
          });
          return `device-${process.platform}-${Date.now()}`;
        }
      });
    this.defaultServerUrl = options.defaultServerUrl ?? DEFAULT_API_URL;
  }

  async authenticateWithPassword(email: string, password: string): Promise<AuthResult> {
    const serverUrl = await this.getServerUrl();

    if (!serverUrl) {
      return { success: false, error: 'Server URL not configured' };
    }

    try {
      const response = await pinnedFetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        const errorMessage =
          (errorBody as { message?: string; error?: string }).message ||
          (errorBody as { message?: string; error?: string }).error ||
          `Authentication failed (${response.status})`;

        logger.warn('AuthService: Credential authentication rejected', {
          status: response.status,
          error: errorMessage,
        });
        return { success: false, error: errorMessage };
      }

      const payload = (await response.json()) as unknown;
      const { data, error } = this.extractAuthPayload(payload);
      if (error) {
        logger.warn('AuthService: Authentication response indicated failure', { error });
        return { success: false, error };
      }

      // Token may be in the JSON body or in Set-Cookie header (server returns it as access_token cookie)
      let token = data?.token;
      if (!token) {
        token = this.extractTokenFromSetCookie(response);
      }

      if (!token || !data?.expiresAt) {
        logger.error('AuthService: Login response missing token fields', {
          hasToken: !!token,
          hasExpiresAt: !!data?.expiresAt,
        });
        return { success: false, error: 'Authentication response malformed' };
      }

      const expiresAt = new Date(data.expiresAt);
      const profile = await this.fetchUserProfile(serverUrl, token);

      const serverUserId = profile?.id || data.user?.id || '';

      // Set keystore scope for multi-profile isolation (must be done before storing tokens)
      this.setKeystoreScope({ serverUrl, userId: serverUserId });

      // Store access token in OS keystore (secure storage)
      await this.keystoreService.setAccessToken(token);

      // Store non-sensitive metadata in settings
      await this.options.storage.settings.setBatch({
        'auth.tokenExpiresAt': expiresAt.toISOString(),
        'auth.userId': serverUserId,
      });

      // Create or activate user profile (single source of truth for user identity)
      if (this.options.userService && serverUserId) {
        try {
          const localUserId = await this.options.userService.loginUser({
            serverUserId,
            email: profile?.email || data.user?.email,
            firstName: profile?.firstName || data.user?.firstName,
            lastName: profile?.lastName || data.user?.lastName,
          });
          logger.info('AuthService: User profile activated', {
            serverUserId: serverUserId.substring(0, 8) + '...',
            localUserId: localUserId.substring(0, 8) + '...',
          });
        } catch (error) {
          logger.error('AuthService: Failed to activate user profile', {
            error: error instanceof Error ? error.message : error,
          });
          // Continue with authentication even if profile activation fails
        }
      }

      logger.info('AuthService: Credential authentication succeeded', {
        userId: serverUserId,
        expiresAt,
      });

      // Emit authenticated event for state machine and other listeners
      this.emit('authenticated', { userId: serverUserId });

      // Trigger post-auth success hook (e.g., fetch license)
      if (this.options.onAuthSuccess) {
        try {
          await this.options.onAuthSuccess();
        } catch (error) {
          logger.warn('AuthService: Post-auth success hook failed', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('AuthService: Credential authentication error', {
        error: errMsg,
        serverUrl,
      });

      // Provide specific messages for common network errors
      if (errMsg.includes('ERR_CONNECTION_REFUSED') || errMsg.includes('ECONNREFUSED')) {
        return {
          success: false,
          error: `Cannot reach the server at ${serverUrl}. Check that the server is running.`,
        };
      }
      if (
        errMsg.includes('ERR_CERT') ||
        errMsg.includes('ERR_UNKNOWN_URL_SCHEME') ||
        errMsg.includes('ERR_SSL')
      ) {
        return {
          success: false,
          error: `Connection to ${serverUrl} failed (${errMsg}). Check the server URL in settings.`,
        };
      }
      if (errMsg.includes('ERR_NAME_NOT_RESOLVED') || errMsg.includes('ENOTFOUND')) {
        return {
          success: false,
          error: `Server not found: ${serverUrl}. Check your network connection and server URL.`,
        };
      }
      if (errMsg.includes('ETIMEDOUT') || errMsg.includes('ERR_TIMED_OUT')) {
        return { success: false, error: 'Connection timed out. The server may be unreachable.' };
      }

      return { success: false, error: `Authentication failed: ${errMsg}` };
    }
  }

  async exchangeAuthCode(
    code: string,
    _codeVerifier: string,
    desktopSessionId: string
  ): Promise<AuthResult> {
    const serverUrl = await this.getServerUrl();
    const endpoint = `${serverUrl}/api/auth/desktop/exchange`;

    logger.info('AuthService: Initiating desktop token exchange', {
      serverUrl,
      endpoint,
      codeLength: code?.length || 0,
      hasDesktopSessionId: !!desktopSessionId,
      desktopSessionId: desktopSessionId ? desktopSessionId.substring(0, 8) + '...' : 'none',
    });

    try {
      const requestBody = { code, desktop_session_id: desktopSessionId };
      logger.debug('AuthService: Token exchange request', {
        endpoint,
        requestBody: {
          code: code.substring(0, 8) + '...',
          desktop_session_id: desktopSessionId.substring(0, 8) + '...',
        },
      });

      const response = await pinnedFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      logger.info('AuthService: Token exchange response received', {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
      });

      if (!response.ok) {
        let errorBody: unknown = {};
        let errorText = '';
        try {
          errorText = await response.text();
          errorBody = JSON.parse(errorText);
        } catch (parseError) {
          logger.warn('AuthService: Failed to parse error response body', {
            parseError: parseError instanceof Error ? parseError.message : parseError,
            rawBody: errorText.substring(0, 500),
          });
          errorBody = { rawBody: errorText };
        }

        const errorMessage =
          (errorBody as { message?: string; error?: string }).message ||
          (errorBody as { message?: string; error?: string }).error ||
          `Token exchange failed (${response.status})`;

        logger.error('AuthService: Desktop token exchange rejected', {
          status: response.status,
          statusText: response.statusText,
          error: errorMessage,
          errorBody: JSON.stringify(errorBody),
          endpoint,
        });

        return { success: false, error: errorMessage };
      }

      const responseText = await response.text();
      logger.debug('AuthService: Token exchange response body', {
        bodyLength: responseText.length,
        bodyPreview: responseText.substring(0, 200),
      });

      let payload: DesktopExchangeResponse;
      try {
        payload = JSON.parse(responseText) as DesktopExchangeResponse;
      } catch (parseError) {
        logger.error('AuthService: Failed to parse successful response body', {
          parseError: parseError instanceof Error ? parseError.message : parseError,
          responseText: responseText.substring(0, 500),
        });
        return { success: false, error: 'Invalid response format from server' };
      }

      if (!payload.access_token || !payload.refresh_token) {
        logger.error('AuthService: Desktop token exchange response incomplete', {
          hasAccessToken: !!payload.access_token,
          hasRefreshToken: !!payload.refresh_token,
          payload: JSON.stringify(payload),
        });
        return { success: false, error: 'Token exchange response was incomplete' };
      }

      const accessExpiresAt = this.resolveExpiry(payload.access_expires_at, payload.expires_in);

      logger.info('AuthService: Storing tokens in keystore', {
        accessTokenLength: payload.access_token.length,
        refreshTokenLength: payload.refresh_token.length,
        accessExpiresAt: accessExpiresAt?.toISOString(),
      });

      // Fetch user profile to get userId
      const profile = await this.fetchUserProfile(serverUrl, payload.access_token);
      const serverUserId = profile?.id || '';

      // Set keystore scope for multi-profile isolation (must be done before storing tokens)
      this.setKeystoreScope({ serverUrl, userId: serverUserId });

      // Store tokens in OS keystore (secure storage)
      await this.keystoreService.setTokens({
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token,
      });

      // Store non-sensitive metadata in settings
      await this.options.storage.settings.setBatch({
        'auth.tokenExpiresAt': accessExpiresAt ? accessExpiresAt.toISOString() : '',
        'auth.userId': serverUserId,
      });

      // Create or activate user profile (single source of truth for user identity)
      if (this.options.userService && serverUserId) {
        try {
          const localUserId = await this.options.userService.loginUser({
            serverUserId,
            email: profile?.email,
            firstName: profile?.firstName,
            lastName: profile?.lastName,
          });
          logger.info('AuthService: User profile activated', {
            serverUserId: serverUserId.substring(0, 8) + '...',
            localUserId: localUserId.substring(0, 8) + '...',
          });
        } catch (error) {
          logger.error('AuthService: Failed to activate user profile', {
            error: error instanceof Error ? error.message : error,
          });
          // Continue with authentication even if profile activation fails
        }
      }

      logger.info('AuthService: Desktop token exchange succeeded', {
        accessTokenLength: payload.access_token.length,
        refreshTokenLength: payload.refresh_token.length,
        accessExpiresAt,
        userId: serverUserId || 'unknown',
      });

      // Emit authenticated event for state machine and other listeners
      this.emit('authenticated', { userId: serverUserId });

      // Trigger post-auth success hook (e.g., fetch license)
      if (this.options.onAuthSuccess) {
        try {
          await this.options.onAuthSuccess();
        } catch (error) {
          logger.warn('AuthService: Post-auth success hook failed', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }

      return { success: true };
    } catch (error) {
      const errorDetails = {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : typeof error,
        endpoint,
        serverUrl,
      };

      if (error instanceof TypeError && error.message.includes('fetch')) {
        logger.error('AuthService: Network error during token exchange (fetch failed)', {
          ...errorDetails,
          hint: 'Check if server is reachable and CORS is configured correctly',
        });
        return {
          success: false,
          error: `Network error: Cannot reach server at ${serverUrl}. Check your connection and server URL.`,
        };
      }

      logger.error('AuthService: Desktop token exchange error', errorDetails);
      return {
        success: false,
        error: `Token exchange failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  async linkAccount(): Promise<AuthResult> {
    const maxRetries = 4;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (attempt > 1) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 2), 4000);
        logger.info('AuthService: Retrying account link', { attempt, maxRetries, delayMs });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const serverUrl = await this.getServerUrl();
      const accessToken = await this.getAccessToken();

      if (!serverUrl || !accessToken) {
        return { success: false, error: 'Authentication required' };
      }

      try {
        // Single source of truth: device_id from HLC engine (creates one if needed)
        const deviceId = await this.getDeviceId();
        if (!deviceId) {
          logger.error('AuthService: Failed to get or create device_id');
          return { success: false, error: 'Failed to generate device identifier' };
        }

        const response = await pinnedFetch(`${serverUrl}/api/sync/link`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            device_id: deviceId,
            client_info: {
              platform: process.platform,
              version: process.env.npm_package_version || '2.0.0',
              device_name: this.getDeviceName(),
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          logger.warn('AuthService: Account link HTTP error', {
            attempt,
            status: response.status,
            errorBody: errorText,
          });

          if (attempt === maxRetries) {
            return {
              success: false,
              error: `Account linking failed (HTTP ${response.status}): ${errorText}`,
            };
          }
          continue;
        }

        const result = (await response.json()) as ApiEnvelope<{
          device_id: string;
          server_user_id: string;
          linked_at: string;
        }>;

        // Detailed logging to debug link response issues
        logger.info('AuthService: Link response received', {
          success: result.success,
          hasData: !!result.data,
          dataKeys: result.data ? Object.keys(result.data) : [],
          error: result.error,
          rawResponse: JSON.stringify(result).substring(0, 500),
        });

        if (result.success && result.data) {
          const { device_id: responseDeviceId } = result.data;

          if (!responseDeviceId) {
            logger.error('AuthService: Link response missing device_id', { result });
            if (attempt === maxRetries) {
              return { success: false, error: 'Link response missing device_id' };
            }
            continue;
          }

          // Store auth configuration in settings
          try {
            await this.options.storage.settings.setBatch({
              'auth.deviceId': responseDeviceId,
              'auth.userId': result.data.server_user_id,
            });
            logger.info('AuthService: Link data stored successfully', {
              deviceId: responseDeviceId,
              serverUserId: result.data.server_user_id,
            });
          } catch (storageError) {
            logger.error('AuthService: Failed to store link data', {
              error: storageError instanceof Error ? storageError.message : storageError,
            });
            throw storageError;
          }

          logger.info('AuthService: Account linked successfully', {
            deviceId,
            serverUserId: result.data.server_user_id,
            linkedAt: result.data.linked_at,
            attempt,
          });

          return { success: true };
        }

        // Log why we didn't enter the success branch
        logger.warn('AuthService: Link response not successful', {
          success: result.success,
          hasData: !!result.data,
          error: result.error,
          attempt,
        });

        if (attempt === maxRetries) {
          return { success: false, error: result.error || 'Account linking failed' };
        }
      } catch (error) {
        logger.error('AuthService: Account linking error', {
          attempt,
          error: error instanceof Error ? error.message : error,
        });

        if (attempt === maxRetries) {
          return { success: false, error: 'Network error during account linking' };
        }
      }
    }

    return { success: false, error: 'Account linking failed after retries' };
  }

  async refreshTokens(force = false): Promise<AuthResult> {
    // Mutex: prevent concurrent refresh attempts
    if (this.isRefreshing) {
      logger.info('AuthService: Token refresh already in progress, waiting...');
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Retry once after waiting
      if (this.isRefreshing) {
        logger.warn('AuthService: Token refresh still in progress after wait, returning');
        return { success: false, error: 'Token refresh in progress', refreshed: false };
      }
    }

    this.isRefreshing = true;

    try {
      const serverUrl = await this.getServerUrl();
      const refreshToken = await this.getRefreshToken();

      if (!serverUrl || !refreshToken) {
        return { success: false, error: 'Refresh token unavailable', refreshed: undefined };
      }

      if (!force) {
        const tokenExpiresAt = await this.getTokenExpiresAt();
        if (tokenExpiresAt) {
          const timeUntilExpiry = tokenExpiresAt.getTime() - Date.now();
          if (timeUntilExpiry > 5 * 60 * 1000) {
            return { success: true, refreshed: false };
          }
        }
      }

      try {
        const response = await pinnedFetch(`${serverUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            refresh_token: refreshToken,
            client_type: 'desktop',
          }),
        });

        if (!response.ok) {
          logger.warn('AuthService: Token refresh rejected by server', {
            status: response.status,
          });

          if (response.status === 401) {
            // Ensure keystore scope is set before deleting tokens
            await this.ensureKeystoreScope();
            // Clear tokens from keystore and metadata from settings
            await this.keystoreService.deleteAllTokens();
            await this.options.storage.settings.setBatch({
              'auth.tokenExpiresAt': '',
            });
          }

          const body = await response.json().catch(() => ({}));
          const errorMessage =
            (body as { message?: string; error?: string }).message ||
            (body as { message?: string; error?: string }).error ||
            'Token refresh failed';

          return { success: false, error: errorMessage, refreshed: undefined };
        }

        const payload = (await response.json()) as RefreshResponse;
        if (!payload.access_token || !payload.refresh_token) {
          return { success: false, error: 'Refresh response missing tokens', refreshed: undefined };
        }

        const accessExpiresAt = this.resolveExpiry(payload.access_expires_at, payload.expires_in);

        // Ensure keystore scope is set before storing tokens
        await this.ensureKeystoreScope();

        // Store new tokens in OS keystore (secure storage)
        await this.keystoreService.setTokens({
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token,
        });

        // Update non-sensitive metadata in settings
        await this.options.storage.settings.setBatch({
          'auth.tokenExpiresAt': accessExpiresAt ? accessExpiresAt.toISOString() : '',
        });

        logger.info('AuthService: Token refresh succeeded');

        // Emit event for consumers (e.g., WebSocketManager) to react to token refresh
        this.emit('token-refreshed', {
          accessToken: payload.access_token,
          expiresAt: accessExpiresAt,
        });

        return { success: true, refreshed: true };
      } catch (error) {
        logger.error('AuthService: Token refresh failed', {
          error: error instanceof Error ? error.message : error,
        });
        return {
          success: false,
          error: 'Network error during token refresh',
          refreshed: undefined,
        };
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  async getAuthContext(): Promise<AuthContext | null> {
    let serverUrl = await this.getServerUrl();
    let accessToken = await this.getAccessToken();

    if (!serverUrl || !accessToken) {
      return null;
    }

    const tokenExpiresAt = await this.getTokenExpiresAt();
    if (tokenExpiresAt) {
      const timeUntilExpiry = tokenExpiresAt.getTime() - Date.now();
      if (timeUntilExpiry < 5 * 60 * 1000) {
        const refreshResult = await this.refreshTokens(true);
        if (refreshResult.success) {
          // Reload tokens after refresh
          accessToken = await this.getAccessToken();
        } else if (tokenExpiresAt.getTime() <= Date.now()) {
          logger.warn('AuthService: Access token expired and refresh failed');
          return null;
        }
      }
    }

    // Reload in case tokens were refreshed
    serverUrl = await this.getServerUrl();
    accessToken = await this.getAccessToken();
    const userId = await this.getUserId();

    if (!accessToken || !serverUrl) {
      return null;
    }

    return {
      serverUrl,
      accessToken,
      userId,
    };
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const serverUrl = await this.getServerUrl();
    const deviceId = await this.getDeviceId();
    const userId = await this.getUserId();

    // Optimization: If no userId, user is logged out - skip keystore access entirely
    // A logged-out user cannot have valid tokens, so we can short-circuit here
    // This avoids the "Cannot set keystore scope" warning spam during startup
    if (!userId || userId.trim() === '') {
      return {
        isConfigured: !!(serverUrl && deviceId),
        isLinked: false,
        hasValidAccessToken: false,
        tokenExpiresAt: null,
        userId: '',
        deviceId,
      };
    }

    const accessToken = await this.getAccessToken();
    const tokenExpiresAt = await this.getTokenExpiresAt();

    const now = Date.now();
    const expiresAt = tokenExpiresAt?.getTime() ?? null;
    const hasValidToken = !!(accessToken && expiresAt !== null && expiresAt > now);

    // isLinked requires both valid token AND non-empty userId
    const isLinked = !!hasValidToken;

    return {
      isConfigured: !!(serverUrl && deviceId),
      isLinked,
      hasValidAccessToken: hasValidToken,
      tokenExpiresAt,
      userId,
      deviceId,
    };
  }

  async logout(options?: { remote?: boolean }): Promise<AuthResult> {
    const serverUrl = await this.getServerUrl();
    if (!serverUrl) {
      return { success: false, error: 'Server URL not configured' };
    }

    const shouldRemoteLogout = options?.remote ?? true;
    const accessToken = await this.getAccessToken();
    const refreshToken = await this.getRefreshToken();

    if (shouldRemoteLogout && (accessToken || refreshToken)) {
      try {
        const response = await pinnedFetch(`${serverUrl}/api/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            access_token: accessToken || undefined,
            refresh_token: refreshToken || undefined,
            client_type: 'desktop',
          }),
        });

        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          logger.warn('AuthService: Logout request rejected', {
            status: response.status,
            error: (body as { message?: string; error?: string }).message,
          });
        } else {
          logger.info('AuthService: Remote logout succeeded');
        }
      } catch (error) {
        logger.warn('AuthService: Failed to call logout endpoint', {
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    // Emit logout event before clearing tokens so consumers can clean up
    this.emit('logout');
    logger.info('AuthService: Emitted logout event');

    // Deactivate user profile (single source of truth for user identity)
    if (this.options.userService) {
      try {
        await this.options.userService.logoutUser();
        logger.info('AuthService: User profile deactivated');
      } catch (error) {
        logger.warn('AuthService: Failed to deactivate user profile', {
          error: error instanceof Error ? error.message : error,
        });
        // Continue with logout even if profile deactivation fails
      }
    }

    try {
      // Ensure keystore scope is set before deleting tokens
      await this.ensureKeystoreScope();

      // Clear tokens from OS keystore
      await this.keystoreService.deleteAllTokens();

      // Clear non-sensitive auth metadata including userId to ensure isLinked becomes false
      // Note: We preserve sync.device_id and auth.serverUrl so that:
      // - isConfigured remains true (server is still configured)
      // - Device identity persists for future re-authentication
      await this.options.storage.settings.setBatch({
        'auth.tokenExpiresAt': '',
        'auth.userId': '',
      });
      return { success: true };
    } catch (error) {
      logger.error('AuthService: Failed to clear auth state', {
        error: error instanceof Error ? error.message : error,
      });
      return { success: false, error: 'Failed to clear authentication state' };
    }
  }

  private extractAuthPayload(payload: unknown): {
    data: AuthSuccessResponse | null;
    error?: string;
  } {
    if (isApiEnvelope<AuthSuccessResponse>(payload)) {
      if (!payload.success) {
        const message = payload.message || payload.error || 'Authentication failed';
        return { data: null, error: message };
      }
      return { data: payload.data ?? null };
    }

    return { data: payload as AuthSuccessResponse };
  }

  /**
   * Extract the access_token from Set-Cookie response headers.
   * The server may return the JWT as an HttpOnly cookie rather than in the body.
   */
  private extractTokenFromSetCookie(response: Response): string | undefined {
    const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
    for (const cookie of setCookieHeaders) {
      // Match "access_token=<value>" at the start of the cookie string
      const match = cookie.match(/^access_token=([^;]+)/);
      if (match && match[1] && match[1].length > 10) {
        return match[1];
      }
    }
    // Fallback: try raw 'set-cookie' header (single string)
    const raw = response.headers.get('set-cookie');
    if (raw) {
      const match = raw.match(/access_token=([^;]+)/);
      if (match && match[1] && match[1].length > 10) {
        return match[1];
      }
    }
    return undefined;
  }

  private resolveExpiry(accessExpiresAt?: string, expiresInSeconds?: number): Date | null {
    if (accessExpiresAt) {
      return new Date(accessExpiresAt);
    }
    if (expiresInSeconds) {
      return new Date(Date.now() + expiresInSeconds * 1000);
    }
    return null;
  }

  private async fetchUserProfile(
    serverUrl: string,
    accessToken: string
  ): Promise<UserProfileResponse | null> {
    try {
      const response = await pinnedFetch(`${serverUrl}/api/users/me`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        logger.warn('AuthService: Failed to fetch user profile after login', {
          status: response.status,
        });
        return null;
      }

      return (await response.json()) as UserProfileResponse;
    } catch (error) {
      logger.warn('AuthService: Error fetching user profile', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Get server URL from settings storage
   */
  private async getServerUrl(): Promise<string> {
    const serverUrl = await this.options.storage.settings.get('auth.serverUrl');
    return serverUrl || this.defaultServerUrl;
  }

  /**
   * Set keystore scope from settings (serverUrl + userId)
   * Must be called before any keystore operations to ensure proper multi-profile isolation.
   */
  private async ensureKeystoreScope(): Promise<void> {
    const serverUrl = await this.options.storage.settings.get('auth.serverUrl');
    const userId = await this.options.storage.settings.get('auth.userId');

    if (serverUrl && userId) {
      this.keystoreService.setScope({ serverUrl, userId });
    } else {
      // This is expected during logout or before first login - use debug level
      // The keystore scope will be set when the user authenticates
      logger.debug('AuthService: Keystore scope not set - missing serverUrl or userId', {
        hasServerUrl: !!serverUrl,
        hasUserId: !!userId,
      });
    }
  }

  /**
   * Set keystore scope with specific values (used during authentication)
   */
  private setKeystoreScope(scope: KeystoreScope): void {
    this.keystoreService.setScope(scope);
  }

  /**
   * Get access token from OS keystore
   */
  private async getAccessToken(): Promise<string | null> {
    try {
      await this.ensureKeystoreScope();
      return await this.keystoreService.getAccessToken();
    } catch (error) {
      if (error instanceof KeystoreError) {
        logger.error('AuthService: Failed to retrieve access token from keystore', {
          error: error.message,
          operation: error.operation,
        });
      }
      return null;
    }
  }

  /**
   * Get refresh token from OS keystore
   */
  private async getRefreshToken(): Promise<string | null> {
    try {
      await this.ensureKeystoreScope();
      return await this.keystoreService.getRefreshToken();
    } catch (error) {
      if (error instanceof KeystoreError) {
        logger.error('AuthService: Failed to retrieve refresh token from keystore', {
          error: error.message,
          operation: error.operation,
        });
      }
      return null;
    }
  }

  /**
   * Get token expiry from settings storage
   */
  private async getTokenExpiresAt(): Promise<Date | null> {
    const expiresAt = await this.options.storage.settings.get('auth.tokenExpiresAt');
    return expiresAt ? new Date(expiresAt) : null;
  }

  /**
   * Get user ID from settings storage
   */
  private async getUserId(): Promise<string | null> {
    return await this.options.storage.settings.get('auth.userId');
  }

  /**
   * Get device ID - unique identifier for this device
   * Uses device.id setting as the single source of truth
   */
  private async getDeviceId(): Promise<string | null> {
    const DEVICE_ID_KEY = 'device.id';
    const settings = this.options.storage.settings;

    try {
      let deviceId = (await settings.get(DEVICE_ID_KEY)) as string | null;

      if (!deviceId) {
        // Generate a new unique device ID
        deviceId = crypto.randomUUID();
        await settings.set(DEVICE_ID_KEY, deviceId);

        logger.info('AuthService: Created new device ID', {
          deviceId: deviceId.substring(0, 8) + '...',
        });
      }

      return deviceId;
    } catch (error) {
      logger.warn('AuthService: Failed to get/create device ID', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  /**
   * Start the proactive token refresh timer
   * Checks periodically if token needs refreshing and refreshes before expiry
   */
  startTokenRefreshTimer(): void {
    if (this.refreshTimer) {
      logger.info('AuthService: Token refresh timer already running');
      return; // Already started
    }

    logger.info('AuthService: Starting token refresh timer', {
      checkInterval: this.REFRESH_CHECK_INTERVAL,
      refreshThreshold: this.REFRESH_THRESHOLD_PERCENT,
    });

    this.refreshTimer = setInterval(async () => {
      await this.checkAndRefreshToken();
    }, this.REFRESH_CHECK_INTERVAL);
  }

  /**
   * Check if token needs refreshing and refresh if necessary
   * Called periodically by the refresh timer
   */
  private async checkAndRefreshToken(): Promise<void> {
    try {
      const tokenExpiresAt = await this.getTokenExpiresAt();
      if (!tokenExpiresAt) {
        return; // No token to refresh
      }

      const now = Date.now();
      const expiryTime = tokenExpiresAt.getTime();
      const tokenLifetime = expiryTime - now;

      if (tokenLifetime <= 0) {
        logger.warn('AuthService: Token already expired, triggering refresh');
        await this.refreshTokens(true);
        return;
      }

      // Calculate when the token was issued (approximately)
      // Assuming a typical token lifetime of 15 minutes (900000ms)
      const estimatedIssuedTime = expiryTime - 15 * 60 * 1000;
      const estimatedFullLifetime = 15 * 60 * 1000;
      const timeElapsed = now - estimatedIssuedTime;
      const percentLifetimeUsed = timeElapsed / estimatedFullLifetime;

      // Refresh when token has used 80% of its lifetime
      if (percentLifetimeUsed >= this.REFRESH_THRESHOLD_PERCENT) {
        logger.info('AuthService: Proactively refreshing token before expiry', {
          tokenLifetime,
          percentLifetimeUsed: Math.round(percentLifetimeUsed * 100),
        });
        await this.refreshTokens(true);
      }
    } catch (error) {
      logger.warn('AuthService: Token refresh timer encountered error', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Stop the token refresh timer
   * Should be called during app shutdown
   */
  stopTokenRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      logger.info('AuthService: Stopped token refresh timer');
    }
  }
}
