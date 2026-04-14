import { ipcMain } from 'electron';

import { type IAuthService } from '../auth';
import { logger } from '../logger';
import { AuthManager } from '../managers/AuthManager';

type AuthHandlersDependencies = {
  authService: IAuthService;
  authManager?: AuthManager | null;
};

export class AuthHandlers {
  constructor(private deps: AuthHandlersDependencies) {}

  register(): void {
    logger.debug('AuthHandlers: Registering IPC handlers');

    ipcMain.handle('auth:getStatus', async () => {
      const status = await this.deps.authService.getAuthStatus();
      return {
        ...status,
        tokenExpiresAt: status.tokenExpiresAt ? status.tokenExpiresAt.toISOString() : null,
      };
    });

    ipcMain.handle('auth:linkAccount', async () => {
      try {
        return await this.deps.authService.linkAccount();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('AuthHandlers: linkAccount failed', { error: message });
        return { success: false, error: message };
      }
    });

    ipcMain.handle('auth:logout', async () => {
      return await this.deps.authService.logout();
    });

    ipcMain.handle('auth:startWebLogin', async () => {
      if (!this.deps.authManager) {
        return false;
      }
      return await this.deps.authManager.startWebLogin();
    });

    ipcMain.handle('auth:beginMicrosoftLogin', async () => {
      if (!this.deps.authManager) {
        return { success: false, error: 'Authentication manager unavailable' };
      }
      return await this.deps.authManager.beginMicrosoftLogin();
    });

    ipcMain.handle(
      'auth:passwordLogin',
      async (_event: Electron.IpcMainInvokeEvent, email: string, password: string) => {
        if (!this.deps.authManager) {
          return { success: false, error: 'Authentication manager unavailable' };
        }
        return await this.deps.authManager.loginWithPassword(email, password);
      }
    );
  }
}
