import { logger } from '../logger';

/**
 * OAuth state management for CSRF protection
 * Manages secure state generation and validation for OAuth flows
 */

interface PendingOAuthState {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  desktopSessionId?: string;
  timestamp: number;
  expiresAt: number;
}

class OAuthStateManager {
  private pendingStates = new Map<string, PendingOAuthState>();
  private readonly STATE_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes
  private desktopSessionIndex = new Map<string, string>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.startCleanupTimer();
  }

  /**
   * Store OAuth state for validation
   */
  storeState(params: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
    desktopSessionId?: string;
  }): void {
    const { state, codeVerifier, redirectUri, desktopSessionId } = params;
    const timestamp = Date.now();
    const expiresAt = timestamp + this.STATE_EXPIRATION_MS;

    this.pendingStates.set(state, {
      state,
      codeVerifier,
      redirectUri,
      desktopSessionId,
      timestamp,
      expiresAt,
    });

    if (desktopSessionId) {
      this.desktopSessionIndex.set(desktopSessionId, state);
    }

    logger.debug('OAuth state stored', {
      state: state.substring(0, 8) + '...',
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  /**
   * Validate and consume OAuth state (single-use)
   */
  validateAndConsumeState(state: string): {
    valid: boolean;
    codeVerifier?: string;
    redirectUri?: string;
    desktopSessionId?: string;
    state?: string;
    error?: string;
  } {
    if (!state) {
      return { valid: false, error: 'State parameter is required' };
    }

    const pendingState = this.pendingStates.get(state);
    if (!pendingState) {
      logger.warn('OAuth state not found', { state: state.substring(0, 8) + '...' });
      return { valid: false, error: 'Invalid or expired state parameter' };
    }

    // Check expiration
    const now = Date.now();
    if (now >= pendingState.expiresAt) {
      this.pendingStates.delete(state);
      logger.warn('OAuth state expired', {
        state: state.substring(0, 8) + '...',
        expiredAt: new Date(pendingState.expiresAt).toISOString(),
      });
      return { valid: false, error: 'State parameter has expired' };
    }

    // Single-use: Remove state after validation
    this.pendingStates.delete(state);
    if (pendingState.desktopSessionId) {
      this.desktopSessionIndex.delete(pendingState.desktopSessionId);
    }

    logger.info('OAuth state validated and consumed', {
      state: state.substring(0, 8) + '...',
      age: now - pendingState.timestamp,
    });

    return {
      valid: true,
      state,
      codeVerifier: pendingState.codeVerifier,
      redirectUri: pendingState.redirectUri,
      desktopSessionId: pendingState.desktopSessionId,
    };
  }

  /**
   * Fallback state consumption using the desktop session identifier when state
   * is unavailable (e.g., upstream services generated a new state value).
   */
  consumeByDesktopSessionId(desktopSessionId: string): {
    valid: boolean;
    state?: string;
    codeVerifier?: string;
    redirectUri?: string;
    desktopSessionId?: string;
    error?: string;
  } {
    if (!desktopSessionId) {
      return { valid: false, error: 'Desktop session identifier is required' };
    }

    const stateKey = this.desktopSessionIndex.get(desktopSessionId);
    if (!stateKey) {
      logger.warn('OAuth state not found for desktop session', {
        desktopSessionId: desktopSessionId.substring(0, 8) + '...',
      });
      return { valid: false, error: 'Authentication session expired or invalid' };
    }

    const pendingState = this.pendingStates.get(stateKey);
    if (!pendingState) {
      this.desktopSessionIndex.delete(desktopSessionId);
      logger.warn('OAuth state not found for desktop session', {
        desktopSessionId: desktopSessionId.substring(0, 8) + '...',
      });
      return { valid: false, error: 'Authentication session expired or invalid' };
    }

    // Check expiration
    const now = Date.now();
    if (now >= pendingState.expiresAt) {
      this.pendingStates.delete(stateKey);
      this.desktopSessionIndex.delete(desktopSessionId);
      logger.warn('OAuth state expired (session lookup)', {
        desktopSessionId: desktopSessionId.substring(0, 8) + '...',
        expiredAt: new Date(pendingState.expiresAt).toISOString(),
      });
      return { valid: false, error: 'State parameter has expired' };
    }

    this.pendingStates.delete(stateKey);
    this.desktopSessionIndex.delete(desktopSessionId);

    logger.info('OAuth state consumed via session lookup', {
      state: stateKey.substring(0, 8) + '...',
      desktopSessionId: desktopSessionId.substring(0, 8) + '...',
      age: now - pendingState.timestamp,
    });

    return {
      valid: true,
      state: stateKey,
      codeVerifier: pendingState.codeVerifier,
      redirectUri: pendingState.redirectUri,
      desktopSessionId: pendingState.desktopSessionId,
    };
  }

  /**
   * Check if state exists without consuming it
   */
  hasState(state: string): boolean {
    const pendingState = this.pendingStates.get(state);
    if (!pendingState) return false;

    // Check expiration
    const now = Date.now();
    if (now >= pendingState.expiresAt) {
      this.pendingStates.delete(state);
      if (pendingState.desktopSessionId) {
        this.desktopSessionIndex.delete(pendingState.desktopSessionId);
      }
      return false;
    }

    return true;
  }

  /**
   * Clear all pending states (for cleanup/shutdown)
   */
  clearAllStates(): void {
    const count = this.pendingStates.size;
    this.pendingStates.clear();
    this.desktopSessionIndex.clear();

    if (count > 0) {
      logger.info('Cleared all OAuth states', { count });
    }
  }

  /**
   * Get statistics about pending states
   */
  getStats(): { total: number; expired: number } {
    const now = Date.now();
    let expired = 0;

    for (const [state, pendingState] of this.pendingStates.entries()) {
      if (now >= pendingState.expiresAt) {
        expired++;
        this.pendingStates.delete(state);
        if (pendingState.desktopSessionId) {
          this.desktopSessionIndex.delete(pendingState.desktopSessionId);
        }
      }
    }

    return {
      total: this.pendingStates.size,
      expired,
    };
  }

  /**
   * Cleanup expired states periodically
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Run cleanup every 5 minutes
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupExpiredStates();
      },
      5 * 60 * 1000
    );
  }

  /**
   * Remove expired states from memory
   */
  private cleanupExpiredStates(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [state, pendingState] of this.pendingStates.entries()) {
      if (now >= pendingState.expiresAt) {
        this.pendingStates.delete(state);
        if (pendingState.desktopSessionId) {
          this.desktopSessionIndex.delete(pendingState.desktopSessionId);
        }
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Cleaned up expired OAuth states', { cleaned });
    }
  }

  /**
   * Stop cleanup timer (for shutdown)
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clearAllStates();
  }
}

// Singleton instance
export const oauthStateManager = new OAuthStateManager();

// Export functions for backward compatibility
export function storeOAuthState(params: {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  desktopSessionId?: string;
}): void {
  return oauthStateManager.storeState(params);
}

export function validateAndConsumeOAuthState(state: string): {
  valid: boolean;
  codeVerifier?: string;
  redirectUri?: string;
  desktopSessionId?: string;
  state?: string;
  error?: string;
} {
  return oauthStateManager.validateAndConsumeState(state);
}

export function consumeOAuthStateByDesktopSessionId(desktopSessionId: string): {
  valid: boolean;
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
  desktopSessionId?: string;
  error?: string;
} {
  return oauthStateManager.consumeByDesktopSessionId(desktopSessionId);
}

export function hasOAuthState(state: string): boolean {
  return oauthStateManager.hasState(state);
}

export function clearAllOAuthStates(): void {
  return oauthStateManager.clearAllStates();
}

export function getOAuthStateStats(): { total: number; expired: number } {
  return oauthStateManager.getStats();
}
