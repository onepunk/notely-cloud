/**
 * SecurityHandlers - IPC handlers for password protection operations
 *
 * Provides handlers for:
 * - Getting password protection status
 * - Enabling/disabling password protection
 * - Verifying password (unlock)
 * - Changing password
 * - Recovery key operations
 */

import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import {
  PasswordProtectionService,
  PasswordProtectionError,
  getPasswordProtectionService,
  type PasswordProtectionStatus,
} from '../services/security';

// Validation schemas
const EnablePasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
});

const VerifyPasswordSchema = z.object({
  password: z.string().min(1),
  remember: z.boolean().default(false),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
});

const DisablePasswordSchema = z.object({
  password: z.string().min(1),
});

const ResetPasswordSchema = z.object({
  recoveryKey: z.string().regex(/^[0-9a-fA-F]{64}$/, 'Invalid recovery key format'),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
});

export interface SecurityHandlersDependencies {
  mainWindow: BrowserWindow | null;
  baseDir: string;
  /** Called when password unlock succeeds (used during startup unlock flow) */
  onPasswordUnlocked?: () => void;
}

/**
 * SecurityHandlers manages all IPC handlers related to password protection
 */
export class SecurityHandlers {
  private passwordService: PasswordProtectionService | null = null;

  constructor(private deps: SecurityHandlersDependencies) {}

  /**
   * Get or create the password protection service
   */
  private getService(): PasswordProtectionService {
    if (!this.passwordService) {
      this.passwordService = getPasswordProtectionService(this.deps.baseDir);
    }
    return this.passwordService;
  }

  /**
   * Register all security-related IPC handlers
   */
  register(): void {
    logger.debug('SecurityHandlers: Registering IPC handlers');

    // Status
    ipcMain.handle('security:getPasswordStatus', this.handleGetStatus.bind(this));

    // Password operations
    ipcMain.handle('security:enablePassword', this.handleEnablePassword.bind(this));
    ipcMain.handle('security:disablePassword', this.handleDisablePassword.bind(this));
    ipcMain.handle('security:verifyPassword', this.handleVerifyPassword.bind(this));
    ipcMain.handle('security:changePassword', this.handleChangePassword.bind(this));
    ipcMain.handle('security:lock', this.handleLock.bind(this));
    ipcMain.handle('security:clearRemember', this.handleClearRemember.bind(this));

    // Recovery key operations
    ipcMain.handle('security:exportRecoveryKey', this.handleExportRecoveryKey.bind(this));
    ipcMain.handle('security:importRecoveryKey', this.handleImportRecoveryKey.bind(this));
    ipcMain.handle('security:markRecoveryKeyShown', this.handleMarkRecoveryKeyShown.bind(this));
    ipcMain.handle('security:resetPasswordWithRecoveryKey', this.handleResetPassword.bind(this));

    logger.debug('SecurityHandlers: All handlers registered successfully');
  }

  /**
   * Get password protection status
   */
  private async handleGetStatus(): Promise<PasswordProtectionStatus> {
    try {
      const service = this.getService();
      return await service.getStatus();
    } catch (error) {
      logger.error('SecurityHandlers: Failed to get password status', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Enable password protection
   */
  private async handleEnablePassword(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { password, confirmPassword } = EnablePasswordSchema.parse(input);

      const service = this.getService();
      await service.enablePasswordProtection(password, confirmPassword);

      // Notify renderer of status change
      this.broadcastStatusChange();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to enable password', {
        error: error instanceof Error ? error.message : error,
      });

      if (error instanceof PasswordProtectionError) {
        return { success: false, error: error.message };
      }
      if (error instanceof z.ZodError) {
        return { success: false, error: error.errors[0]?.message ?? 'Validation failed' };
      }
      return { success: false, error: 'Failed to enable password protection' };
    }
  }

  /**
   * Disable password protection
   */
  private async handleDisablePassword(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { password } = DisablePasswordSchema.parse(input);

      const service = this.getService();
      await service.disablePasswordProtection(password);

      // Notify renderer of status change
      this.broadcastStatusChange();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to disable password', {
        error: error instanceof Error ? error.message : error,
      });

      if (error instanceof PasswordProtectionError) {
        return { success: false, error: error.message };
      }
      if (error instanceof z.ZodError) {
        return { success: false, error: error.errors[0]?.message ?? 'Validation failed' };
      }
      return { success: false, error: 'Failed to disable password protection' };
    }
  }

  /**
   * Verify password (unlock)
   */
  private async handleVerifyPassword(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { password, remember } = VerifyPasswordSchema.parse(input);

      const service = this.getService();
      const valid = await service.verifyPassword(password, remember);

      if (!valid) {
        return { success: false, error: 'Incorrect password' };
      }

      // Notify renderer of status change (now unlocked)
      this.broadcastStatusChange();

      // Notify startup flow that unlock succeeded (closes unlock window)
      this.deps.onPasswordUnlocked?.();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to verify password', {
        error: error instanceof Error ? error.message : error,
      });

      if (error instanceof PasswordProtectionError) {
        return { success: false, error: error.message };
      }
      return { success: false, error: 'Failed to verify password' };
    }
  }

  /**
   * Change password
   */
  private async handleChangePassword(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { currentPassword, newPassword, confirmPassword } = ChangePasswordSchema.parse(input);

      const service = this.getService();
      await service.changePassword(currentPassword, newPassword, confirmPassword);

      // Notify renderer of status change
      this.broadcastStatusChange();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to change password', {
        error: error instanceof Error ? error.message : error,
      });

      if (error instanceof PasswordProtectionError) {
        return { success: false, error: error.message };
      }
      if (error instanceof z.ZodError) {
        return { success: false, error: error.errors[0]?.message ?? 'Validation failed' };
      }
      return { success: false, error: 'Failed to change password' };
    }
  }

  /**
   * Lock the database (clear cached key)
   */
  private async handleLock(): Promise<{ success: boolean }> {
    try {
      const service = this.getService();
      service.lock();

      // Notify renderer of status change (now locked)
      this.broadcastStatusChange();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to lock', {
        error: error instanceof Error ? error.message : error,
      });
      return { success: true }; // Still consider successful - state is cleared
    }
  }

  /**
   * Clear "remember password" cache
   */
  private async handleClearRemember(): Promise<{ success: boolean }> {
    try {
      const service = this.getService();
      await service.clearRememberPassword();

      // Notify renderer of status change
      this.broadcastStatusChange();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to clear remember', {
        error: error instanceof Error ? error.message : error,
      });
      return { success: true }; // Still consider successful
    }
  }

  /**
   * Export recovery key
   *
   * The recovery key is the database encryption key itself.
   * In password mode, we get it from memory. In auto-unlock mode, from keystore.
   */
  private async handleExportRecoveryKey(): Promise<string> {
    try {
      const service = this.getService();
      const status = await service.getStatus();

      if (status.enabled) {
        // Password mode - get key from PasswordProtectionService
        const decryptedKey = await service.getDecryptedKey();
        if (!decryptedKey) {
          throw new Error('Database is locked. Enter password to access recovery key.');
        }
        logger.info('SecurityHandlers: Exported recovery key (password mode)');
        return decryptedKey;
      }

      // Auto-unlock mode - get key from EncryptionKeyManager
      const { getEncryptionKeyManager } = await import('../storage/core/EncryptionKeyManager');
      const keyManager = getEncryptionKeyManager(this.deps.baseDir);
      const recoveryKey = await keyManager.exportRecoveryKey();
      logger.info('SecurityHandlers: Exported recovery key (auto-unlock mode)');
      return recoveryKey;
    } catch (error) {
      logger.error('SecurityHandlers: Failed to export recovery key', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Import recovery key
   *
   * Only allowed in auto-unlock mode. In password mode, use resetPasswordWithRecoveryKey instead.
   */
  private async handleImportRecoveryKey(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; error?: string }> {
    const schema = z.object({ recoveryKey: z.string().regex(/^[0-9a-fA-F]{64}$/) });

    try {
      const service = this.getService();
      const status = await service.getStatus();

      if (status.enabled) {
        // Password mode - cannot import directly
        return {
          success: false,
          error:
            'Cannot import recovery key while password protection is enabled. Use "Reset Password with Recovery Key" instead.',
        };
      }

      const { recoveryKey } = schema.parse(input);

      const { getEncryptionKeyManager } = await import('../storage/core/EncryptionKeyManager');
      const keyManager = getEncryptionKeyManager(this.deps.baseDir);
      await keyManager.importRecoveryKey(recoveryKey);

      logger.info('SecurityHandlers: Imported recovery key');
      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to import recovery key', {
        error: error instanceof Error ? error.message : error,
      });

      if (error instanceof z.ZodError) {
        return { success: false, error: 'Invalid recovery key format' };
      }
      return { success: false, error: 'Failed to import recovery key' };
    }
  }

  /**
   * Mark recovery key as shown to user
   */
  private async handleMarkRecoveryKeyShown(): Promise<{ success: boolean }> {
    try {
      const service = this.getService();
      await service.markRecoveryKeyShown();

      // Notify renderer of status change
      this.broadcastStatusChange();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to mark recovery key shown', {
        error: error instanceof Error ? error.message : error,
      });
      return { success: true }; // Non-critical
    }
  }

  /**
   * Reset password using recovery key
   */
  private async handleResetPassword(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { recoveryKey, newPassword, confirmPassword } = ResetPasswordSchema.parse(input);

      const service = this.getService();
      await service.resetPasswordWithRecoveryKey(recoveryKey, newPassword, confirmPassword);

      // Notify renderer of status change
      this.broadcastStatusChange();

      // Notify startup flow that unlock succeeded (closes unlock window)
      // This is needed when recovery key is used from the unlock window at startup
      this.deps.onPasswordUnlocked?.();

      return { success: true };
    } catch (error) {
      logger.error('SecurityHandlers: Failed to reset password', {
        error: error instanceof Error ? error.message : error,
      });

      if (error instanceof PasswordProtectionError) {
        return { success: false, error: error.message };
      }
      if (error instanceof z.ZodError) {
        return { success: false, error: error.errors[0]?.message ?? 'Validation failed' };
      }
      return { success: false, error: 'Failed to reset password' };
    }
  }

  /**
   * Broadcast status change to renderer
   */
  private broadcastStatusChange(): void {
    if (this.deps.mainWindow && !this.deps.mainWindow.isDestroyed()) {
      this.getService()
        .getStatus()
        .then((status) => {
          this.deps.mainWindow?.webContents.send('security:statusChanged', status);
        })
        .catch((error) => {
          logger.warn('SecurityHandlers: Failed to broadcast status change', {
            error: error instanceof Error ? error.message : error,
          });
        });
    }
  }

  /**
   * Update main window reference
   */
  updateMainWindow(mainWindow: BrowserWindow | null): void {
    this.deps.mainWindow = mainWindow;
  }

  /**
   * Cleanup and unregister handlers
   */
  cleanup(): void {
    logger.debug('SecurityHandlers: Cleaning up IPC handlers');

    const handlers = [
      'security:getPasswordStatus',
      'security:enablePassword',
      'security:disablePassword',
      'security:verifyPassword',
      'security:changePassword',
      'security:lock',
      'security:clearRemember',
      'security:exportRecoveryKey',
      'security:importRecoveryKey',
      'security:markRecoveryKeyShown',
      'security:resetPasswordWithRecoveryKey',
    ];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeHandler(handler);
      } catch (error) {
        logger.warn('SecurityHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    logger.debug('SecurityHandlers: Cleanup completed');
  }
}
