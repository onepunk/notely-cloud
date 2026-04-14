import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import { getKeystoreService } from '../services/security';
import { type IStorageService } from '../storage/index';
import { type UserProfile } from '../storage/types/entities';

// Validation schemas
const GetSettingSchema = z.object({ key: z.string().min(1) });
const SetSettingSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
const ListSettingsSchema = z.object({
  prefix: z.string().default(''),
});
const SaveUserProfileSchema = z.object({
  first_name: z.string().optional().nullable(),
  last_name: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  avatar_path: z.string().optional().nullable(),
});

type AuthProvider = {
  getAuthContext: () => Promise<{
    serverUrl: string;
    accessToken: string;
    userId: string | null;
  } | null>;
};

type RemoteProfile = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  avatarPath?: string | null;
  userId?: string | null;
};

export interface SettingsHandlersDependencies {
  storage: IStorageService;
  mainWindow: BrowserWindow | null;
  authProvider?: AuthProvider | null;
}

/**
 * SettingsHandlers manages all IPC handlers related to application settings
 * and user profile operations. This includes getting, setting, and listing settings,
 * as well as user profile CRUD operations.
 */
export class SettingsHandlers {
  private hydrationInProgress = false;

  constructor(private deps: SettingsHandlersDependencies) {}

  /**
   * Register all settings-related IPC handlers
   */
  register(): void {
    logger.debug('SettingsHandlers: Registering IPC handlers');

    // Settings IPC handlers
    ipcMain.handle('settings:get', this.handleGetSetting.bind(this));
    ipcMain.handle('settings:set', this.handleSetSetting.bind(this));
    ipcMain.handle('settings:listByPrefix', this.handleListSettingsByPrefix.bind(this));
    ipcMain.on('settings:broadcast', this.handleBroadcastSetting.bind(this));

    // User Profile IPC handlers
    ipcMain.handle('user:getProfile', this.handleGetUserProfile.bind(this));
    ipcMain.handle('user:saveProfile', this.handleSaveUserProfile.bind(this));

    logger.debug('SettingsHandlers: All handlers registered successfully');
  }

  /**
   * Get setting value by key
   */
  private async handleGetSetting(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { key } = GetSettingSchema.parse(input);
      logger.debug('SettingsHandlers: Getting setting', { key });

      const value = await this.deps.storage.settings.get(key);

      logger.debug('SettingsHandlers: Setting retrieved', {
        key,
        hasValue: value !== null && value !== undefined,
      });
      return value;
    } catch (error) {
      logger.error('SettingsHandlers: Failed to get setting', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Set setting value
   */
  private async handleSetSetting(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { key, value } = SetSettingSchema.parse(input);
      logger.debug('SettingsHandlers: Setting value', { key, valueType: typeof value });

      await this.deps.storage.settings.set(key, value);

      // Broadcast setting change to renderer
      if (this.deps.mainWindow) {
        this.deps.mainWindow.webContents.send('settings:changed', { key, value });
      }

      logger.debug('SettingsHandlers: Setting saved and broadcast', { key });
    } catch (error) {
      logger.error('SettingsHandlers: Failed to set setting', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List settings by prefix
   */
  private async handleListSettingsByPrefix(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { prefix } = ListSettingsSchema.parse(input);
      logger.debug('SettingsHandlers: Listing settings by prefix', { prefix });

      const settings = await this.deps.storage.settings.listByPrefix(prefix);

      logger.debug('SettingsHandlers: Settings retrieved', {
        prefix,
        count: settings.length,
      });
      return settings;
    } catch (error) {
      logger.error('SettingsHandlers: Failed to list settings by prefix', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Broadcast setting change to renderer (triggered from renderer)
   */
  private handleBroadcastSetting(
    _event: Electron.IpcMainEvent,
    payload: { key: string; value: string }
  ): void {
    try {
      logger.debug('SettingsHandlers: Broadcasting setting change', {
        key: payload.key,
        valueType: typeof payload.value,
      });

      if (this.deps.mainWindow) {
        this.deps.mainWindow.webContents.send('settings:changed', payload);
      }

      logger.debug('SettingsHandlers: Setting change broadcast', { key: payload.key });
    } catch (error) {
      logger.error('SettingsHandlers: Failed to broadcast setting', {
        error: error instanceof Error ? error.message : error,
        payload,
      });
      // Don't throw for broadcast failures as they're not critical
    }
  }

  /**
   * Get user profile
   */
  private async handleGetUserProfile() {
    try {
      logger.debug('SettingsHandlers: Getting user profile');

      let profile = await this.deps.storage.users.getUserProfile();

      // Hydrate profile from remote if needed, but only if not already in progress
      // This prevents infinite loops when multiple components fetch profile simultaneously
      if (this.shouldHydrateProfile(profile) && !this.hydrationInProgress) {
        this.hydrationInProgress = true;
        try {
          const remoteProfile = await this.fetchRemoteUserProfile();
          if (remoteProfile) {
            const updates: {
              firstName?: string | null;
              lastName?: string | null;
              email?: string | null;
              avatarPath?: string | null;
            } = {};

            if (remoteProfile.firstName !== undefined) updates.firstName = remoteProfile.firstName;
            if (remoteProfile.lastName !== undefined) updates.lastName = remoteProfile.lastName;
            if (remoteProfile.email !== undefined) updates.email = remoteProfile.email;
            if (remoteProfile.avatarPath !== undefined)
              updates.avatarPath = remoteProfile.avatarPath;

            if (Object.keys(updates).length > 0) {
              await this.deps.storage.users.saveUserProfile(updates);
              profile = await this.deps.storage.users.getUserProfile();
              // DO NOT notify profile changed here - automatic hydration should be silent
              // Only explicit user saves (via handleSaveUserProfile) should broadcast changes
              logger.debug('SettingsHandlers: Profile hydrated from remote', {
                updatedFields: Object.keys(updates),
              });
            }

            if (remoteProfile.userId) {
              try {
                const existingUserId = await this.deps.storage.settings.get('auth.userId');
                if (!existingUserId) {
                  await this.deps.storage.settings.set('auth.userId', remoteProfile.userId);
                }
              } catch (error) {
                logger.warn('SettingsHandlers: Failed to persist remote user id', {
                  error: error instanceof Error ? error.message : error,
                });
              }
            }
          }
        } finally {
          this.hydrationInProgress = false;
        }
      }

      logger.debug('SettingsHandlers: User profile retrieved', {
        hasProfile: !!profile,
        hasEmail: !!profile?.email,
      });

      // Convert camelCase to snake_case for frontend
      if (profile) {
        return {
          first_name: profile.firstName,
          last_name: profile.lastName,
          email: profile.email,
          avatar_path: profile.avatarPath,
          updated_at: profile.updatedAt.getTime(),
        };
      }

      return profile;
    } catch (error) {
      logger.error('SettingsHandlers: Failed to get user profile', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Save user profile
   */
  private async handleSaveUserProfile(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const profileData = SaveUserProfileSchema.parse(input);
      logger.debug('SettingsHandlers: Saving user profile', {
        hasFirstName: !!profileData.first_name,
        hasLastName: !!profileData.last_name,
        hasEmail: !!profileData.email,
        hasAvatar: !!profileData.avatar_path,
      });

      // Convert snake_case to camelCase for the service
      await this.deps.storage.users.saveUserProfile({
        firstName: profileData.first_name,
        lastName: profileData.last_name,
        email: profileData.email,
        avatarPath: profileData.avatar_path,
      });

      // Broadcast profile change to renderer
      if (this.deps.mainWindow) {
        this.deps.mainWindow.webContents.send('user:profileChanged');
      }

      logger.debug('SettingsHandlers: User profile saved successfully');
    } catch (error) {
      logger.error('SettingsHandlers: Failed to save user profile', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Send initial settings hydration to renderer when ready
   */
  async sendSettingsHydration(): Promise<void> {
    try {
      if (this.deps.mainWindow) {
        logger.debug('SettingsHandlers: Sending settings hydration');

        const settings = await this.deps.storage.settings.listByPrefix('');
        this.deps.mainWindow.webContents.send('settings:hydrate', settings);

        logger.debug('SettingsHandlers: Settings hydration sent', {
          settingsCount: settings.length,
        });
      }
    } catch (error) {
      logger.error('SettingsHandlers: Failed to send settings hydration', {
        error: error instanceof Error ? error.message : error,
      });
      // Don't throw as this is not critical for app functionality
    }
  }

  /**
   * Cleanup and unregister handlers
   */
  cleanup(): void {
    logger.debug('SettingsHandlers: Cleaning up IPC handlers');

    const handlers = [
      'settings:get',
      'settings:set',
      'settings:listByPrefix',
      'settings:broadcast',
      'user:getProfile',
      'user:saveProfile',
    ];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeAllListeners(handler);
      } catch (error) {
        logger.warn('SettingsHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    logger.debug('SettingsHandlers: Cleanup completed');
  }

  private shouldHydrateProfile(profile: UserProfile | null): boolean {
    if (!profile) return true;
    const missingName = !profile.firstName && !profile.lastName;
    const missingEmail = !profile.email;
    const missingAvatar = !profile.avatarPath;
    return missingName || missingEmail || missingAvatar;
  }

  private normalizeBaseUrl(url: string): string {
    return url.replace(/\/+$/, '');
  }

  private async fetchRemoteUserProfile(): Promise<RemoteProfile | null> {
    try {
      const authContext =
        (await this.deps.authProvider?.getAuthContext?.()) ||
        (await this.getAuthContextFromConfig());

      if (!authContext?.serverUrl || !authContext?.accessToken) {
        logger.debug('SettingsHandlers: Remote profile fetch skipped - missing auth context');
        return null;
      }

      const endpoint = `${this.normalizeBaseUrl(authContext.serverUrl)}/api/users/me`;
      const response = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${authContext.accessToken}`,
          Accept: 'application/json',
        },
      });

      const textPayload = await response.text();
      let payload: unknown = null;
      if (textPayload) {
        try {
          payload = JSON.parse(textPayload);
        } catch (error) {
          logger.warn('SettingsHandlers: Unable to parse remote profile payload', {
            error: error instanceof Error ? error.message : error,
            status: response.status,
            responsePreview: textPayload.substring(0, 200),
            contentType: response.headers.get('content-type'),
          });
          return null;
        }
      }

      if (!response.ok) {
        const errorMessage =
          (payload as { error?: string; message?: string } | null)?.error ||
          (payload as { error?: string; message?: string } | null)?.message ||
          `HTTP ${response.status}`;
        logger.warn('SettingsHandlers: Remote profile fetch failed', {
          status: response.status,
          error: errorMessage,
        });
        return null;
      }

      const dataPayload =
        (payload && typeof payload === 'object' && payload !== null && 'data' in payload
          ? (payload as { data: unknown }).data
          : payload) ?? {};

      const parsed = this.parseRemoteProfile(dataPayload);
      if (!parsed) {
        logger.debug('SettingsHandlers: Remote profile payload missing expected fields');
        return null;
      }

      if (!parsed.userId && authContext.userId) {
        parsed.userId = authContext.userId;
      }

      return parsed;
    } catch (error) {
      logger.error('SettingsHandlers: Failed to fetch remote profile', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  private async getAuthContextFromConfig(): Promise<{
    serverUrl: string;
    accessToken: string;
    userId: string | null;
  } | null> {
    try {
      const serverUrl = await this.deps.storage.settings.get('auth.serverUrl');
      const keystoreService = getKeystoreService();
      let accessToken: string | null = null;
      try {
        accessToken = await keystoreService.getAccessToken();
      } catch {
        // Ignore keystore errors - will be treated as no token
      }
      const userId = await this.deps.storage.settings.get('auth.userId');

      if (!serverUrl || !accessToken) {
        return null;
      }
      return {
        serverUrl,
        accessToken,
        userId: userId || null,
      };
    } catch (error) {
      logger.warn('SettingsHandlers: Failed to read auth configuration for profile fetch', {
        error: error instanceof Error ? error.message : error,
      });
      return null;
    }
  }

  private parseRemoteProfile(payload: unknown): RemoteProfile | null {
    const sources = this.collectProfileSources(payload);
    if (!sources.length) {
      return null;
    }

    const firstName = this.extractString(sources, [
      'first_name',
      'firstName',
      'given_name',
      'givenName',
      'name_first',
    ]);
    const lastName = this.extractString(sources, [
      'last_name',
      'lastName',
      'family_name',
      'familyName',
      'name_last',
    ]);
    const email = this.extractString(sources, ['email', 'primary_email', 'email_address', 'mail']);
    const avatarPath = this.extractString(sources, [
      'avatar_path',
      'avatarUrl',
      'avatar_url',
      'profile_image',
      'profileImageUrl',
    ]);
    const userId = this.extractIdentifier(sources, ['id', 'user_id', 'userId']);

    if (
      firstName === undefined &&
      lastName === undefined &&
      email === undefined &&
      avatarPath === undefined &&
      userId === undefined
    ) {
      return null;
    }

    return { firstName, lastName, email, avatarPath, userId };
  }

  private collectProfileSources(payload: unknown): Array<Record<string, unknown>> {
    const queue: unknown[] = [payload];
    const sources: Array<Record<string, unknown>> = [];
    const seen = new Set<unknown>();

    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      if (seen.has(current)) continue;
      seen.add(current);
      const record = current as Record<string, unknown>;
      sources.push(record);

      for (const key of ['data', 'user', 'profile', 'attributes']) {
        if (record[key]) {
          queue.push(record[key]);
        }
      }
    }

    return sources;
  }

  private extractString(
    sources: Array<Record<string, unknown>>,
    keys: string[]
  ): string | null | undefined {
    for (const key of keys) {
      for (const source of sources) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const value = source[key];
        if (value === null) return null;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }
      }
    }
    return undefined;
  }

  private extractIdentifier(
    sources: Array<Record<string, unknown>>,
    keys: string[]
  ): string | null | undefined {
    for (const key of keys) {
      for (const source of sources) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const value = source[key];
        if (value === null) return null;
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
        if (typeof value === 'number' && !Number.isNaN(value)) return String(value);
      }
    }
    return undefined;
  }

  private notifyProfileChanged(): void {
    try {
      this.deps.mainWindow?.webContents.send('user:profileChanged');
    } catch (error) {
      logger.warn('SettingsHandlers: Failed to broadcast profile change', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
