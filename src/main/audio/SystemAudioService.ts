import { initMain } from 'electron-audio-loopback';

import { logger } from '../logger';

/**
 * Service to manage system audio loopback capture using electron-audio-loopback.
 * This service must be initialized in the main process before the app is ready.
 *
 * Platform support:
 * - Windows 10+: WASAPI loopback (no permission required)
 * - macOS 12.3+: ScreenCaptureKit (requires Screen Recording permission)
 * - Linux: PulseAudio monitor (no permission required)
 */
export class SystemAudioService {
  private initialized = false;
  private initError: Error | null = null;

  /**
   * Initialize the electron-audio-loopback plugin.
   * Must be called before app is ready.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.debug('SystemAudioService: Already initialized');
      return;
    }

    try {
      logger.debug('SystemAudioService: Initializing electron-audio-loopback');
      await initMain();
      this.initialized = true;
      logger.debug('SystemAudioService: Initialized successfully');
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      logger.error('SystemAudioService: Failed to initialize', {
        error: this.initError.message,
        stack: this.initError.stack,
      });
      // Don't rethrow - allow app to start without system audio support
    }
  }

  /**
   * Check if system audio capture is available on this platform.
   */
  isSupported(): boolean {
    return this.initialized && this.initError === null;
  }

  /**
   * Get the initialization error if one occurred.
   */
  getInitError(): Error | null {
    return this.initError;
  }
}

export const systemAudioService = new SystemAudioService();
