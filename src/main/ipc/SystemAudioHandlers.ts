import { ipcMain } from 'electron';

import { systemAudioService } from '../audio/SystemAudioService';
import { logger } from '../logger';

/**
 * SystemAudioHandlers manages IPC handlers for system audio capture.
 * This enables renderer process to check if system audio capture is supported.
 */
export class SystemAudioHandlers {
  /**
   * Register all system audio IPC handlers
   */
  register(): void {
    logger.debug('SystemAudioHandlers: Registering IPC handlers');

    ipcMain.handle('systemAudio:isSupported', this.handleIsSupported.bind(this));
    ipcMain.handle('systemAudio:getInitError', this.handleGetInitError.bind(this));

    logger.debug('SystemAudioHandlers: All handlers registered successfully');
  }

  /**
   * Check if system audio capture is supported on this platform
   */
  private async handleIsSupported(): Promise<boolean> {
    const supported = systemAudioService.isSupported();
    logger.debug('SystemAudioHandlers: isSupported check', { supported });
    return supported;
  }

  /**
   * Get initialization error message if system audio failed to initialize
   */
  private async handleGetInitError(): Promise<string | null> {
    const error = systemAudioService.getInitError();
    return error ? error.message : null;
  }

  /**
   * Cleanup all registered IPC handlers
   */
  cleanup(): void {
    logger.debug('SystemAudioHandlers: Cleaning up IPC handlers');

    const handlers = ['systemAudio:isSupported', 'systemAudio:getInitError'];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeAllListeners(handler);
      } catch (error) {
        logger.warn('SystemAudioHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });
  }
}
