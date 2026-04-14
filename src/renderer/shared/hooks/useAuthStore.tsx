/**
 * Shared Authentication Store
 *
 * This hook provides a centralized authentication state management solution
 * for the renderer process. It eliminates duplicate auth status fetching
 * and profile loading across components by maintaining a single source of truth.
 *
 * Features:
 * - Single subscription to auth status events
 * - Cached user profile to avoid redundant fetches
 * - Automatic refresh on authentication changes
 * - Loading and error states for better UX
 * - TypeScript-safe API
 *
 * Usage:
 * ```tsx
 * const { authStatus, profile, loading, error, refreshAuth } = useAuthStore();
 *
 * // Check if user is authenticated
 * if (authStatus?.isAuthenticated) {
 *   console.log('User email:', profile?.email);
 * }
 * ```
 */

import * as React from 'react';

import { formatErrorForDisplay } from '@shared/error';

/**
 * Auth status from AuthService (Phase 3: independent from sync)
 */
export interface AuthStatus {
  isConfigured: boolean;
  isLinked: boolean;
  hasValidAccessToken: boolean;
  tokenExpiresAt: string | null;
  userId: string | null;
  deviceId: string | null;
}

/**
 * Extended auth status with computed properties
 * Phase 3: Auth is now independent of sync configuration
 */
export interface ExtendedAuthStatus extends AuthStatus {
  isAuthenticated: boolean; // Computed: isLinked && hasValidAccessToken
  // Sync status will be tracked separately via sync APIs
  lastPush?: number | null;
  lastPull?: number | null;
  isEnabled?: boolean; // Deprecated: use sync status instead
}

/**
 * User profile from the platform
 */
export interface UserProfile {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  avatar_path: string | null;
  updated_at: number;
}

/**
 * Auth store state
 */
interface AuthStoreState {
  authStatus: ExtendedAuthStatus | null;
  profile: UserProfile | null;
  loading: boolean;
  error: string | null;
}

/**
 * Auth store context value
 */
interface AuthStoreContextValue extends AuthStoreState {
  refreshAuth: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

// Create context
const AuthStoreContext = React.createContext<AuthStoreContextValue | null>(null);

/**
 * Auth Store Provider
 *
 * Wraps the application and provides authentication state to all components.
 * Should be placed near the root of the component tree.
 */
export const AuthStoreProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = React.useState<AuthStoreState>({
    authStatus: null,
    profile: null,
    loading: true,
    error: null,
  });

  const loadingRef = React.useRef(false);

  /**
   * Fetch auth status from main process
   * Phase 3: Uses AuthService API instead of sync config
   */
  const fetchAuthStatus = React.useCallback(async (): Promise<ExtendedAuthStatus | null> => {
    try {
      // Get auth status from AuthService (independent of sync)
      const authStatus = await window.api.auth.getStatus();

      // Optionally augment with sync status if needed for backwards compatibility
      let syncStatus = null;
      try {
        syncStatus = await window.api.sync.getStatus();
      } catch {
        // Sync status is optional - auth should work without it
      }

      const extendedStatus: ExtendedAuthStatus = {
        isConfigured: authStatus.isConfigured,
        isLinked: authStatus.isLinked,
        hasValidAccessToken: authStatus.hasValidAccessToken,
        tokenExpiresAt: authStatus.tokenExpiresAt,
        userId: authStatus.userId,
        deviceId: authStatus.deviceId,
        isAuthenticated: authStatus.isLinked && authStatus.hasValidAccessToken,
        // Optional sync status for backwards compatibility
        lastPush: syncStatus?.lastPush ?? null,
        lastPull: syncStatus?.lastPull ?? null,
        isEnabled: syncStatus?.isEnabled ?? undefined,
      };
      return extendedStatus;
    } catch (err) {
      console.error('[AuthStore] Failed to fetch auth status:', err);
      throw err;
    }
  }, []);

  /**
   * Fetch user profile from main process
   */
  const fetchProfile = React.useCallback(
    async (authStatus: ExtendedAuthStatus | null): Promise<UserProfile | null> => {
      // Only fetch profile if authenticated
      if (!authStatus?.isAuthenticated) {
        return null;
      }

      try {
        const profile = await window.api.user.getProfile();
        return profile;
      } catch (err) {
        console.error('[AuthStore] Failed to fetch user profile:', err);
        // Don't throw - profile fetch failure is non-fatal
        return null;
      }
    },
    []
  );

  /**
   * Refresh authentication status and profile
   */
  const refreshAuth = React.useCallback(async () => {
    // Prevent concurrent refreshes
    if (loadingRef.current) {
      return;
    }

    loadingRef.current = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      // Fetch auth status
      const authStatus = await fetchAuthStatus();

      // Fetch profile if authenticated
      const profile = await fetchProfile(authStatus);

      setState({
        authStatus,
        profile,
        loading: false,
        error: null,
      });
    } catch (err) {
      const errorMessage = formatErrorForDisplay(err, 'E1001');

      setState((prev) => ({
        ...prev,
        loading: false,
        error: errorMessage,
      }));
    } finally {
      loadingRef.current = false;
    }
  }, [fetchAuthStatus, fetchProfile]);

  /**
   * Refresh only the user profile (cheaper than full refresh)
   */
  const refreshProfile = React.useCallback(async () => {
    if (!state.authStatus?.isAuthenticated) {
      setState((prev) => ({ ...prev, profile: null }));
      return;
    }

    try {
      const profile = await fetchProfile(state.authStatus);
      setState((prev) => ({ ...prev, profile }));
    } catch (err) {
      console.error('[AuthStore] Failed to refresh profile:', err);
      // Don't update error state for profile-only refresh
    }
  }, [state.authStatus, fetchProfile]);

  /**
   * Initial load on mount
   */
  React.useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  /**
   * Listen for auth status updates
   */
  React.useEffect(() => {
    // Listen for auth completion events
    let unsubscribeAuth: (() => void) | undefined;

    if (typeof window.api?.onAuthCompleted === 'function') {
      unsubscribeAuth = window.api.onAuthCompleted(async (result) => {
        if (result.success) {
          // Auth succeeded - refresh everything
          await refreshAuth();
        } else {
          // Auth failed - clear auth state
          setState((prev) => ({
            ...prev,
            authStatus: prev.authStatus
              ? { ...prev.authStatus, isAuthenticated: false, hasValidAccessToken: false }
              : null,
            profile: null,
            error: result.error || 'Authentication failed',
          }));
        }
      });
    }

    return () => {
      try {
        unsubscribeAuth?.();
      } catch (err) {
        console.warn('[AuthStore] Error unsubscribing from auth events:', err);
      }
    };
  }, [refreshAuth]);

  /**
   * Listen for profile changes
   */
  React.useEffect(() => {
    let unsubscribeProfile: (() => void) | undefined;

    if (typeof window.api?.onProfileChanged === 'function') {
      unsubscribeProfile = window.api.onProfileChanged(async () => {
        await refreshProfile();
      });
    }

    return () => {
      try {
        unsubscribeProfile?.();
      } catch (err) {
        console.warn('[AuthStore] Error unsubscribing from profile events:', err);
      }
    };
  }, [refreshProfile]);

  /**
   * Periodic refresh to keep state fresh
   * Runs every 60 seconds to catch token expiration
   */
  React.useEffect(() => {
    const interval = setInterval(() => {
      void refreshAuth();
    }, 60 * 1000);

    return () => {
      clearInterval(interval);
    };
  }, [refreshAuth]);

  const contextValue: AuthStoreContextValue = {
    ...state,
    refreshAuth,
    refreshProfile,
  };

  return <AuthStoreContext.Provider value={contextValue}>{children}</AuthStoreContext.Provider>;
};

/**
 * Hook to access auth store
 *
 * @throws Error if used outside AuthStoreProvider
 *
 * @example
 * ```tsx
 * const { authStatus, profile, loading, error } = useAuthStore();
 *
 * if (loading) return <Spinner />;
 * if (error) return <Error message={error} />;
 * if (!authStatus?.isAuthenticated) return <SignInPrompt />;
 *
 * return <div>Welcome, {profile?.email}</div>;
 * ```
 */
export const useAuthStore = (): AuthStoreContextValue => {
  const context = React.useContext(AuthStoreContext);

  if (!context) {
    throw new Error('useAuthStore must be used within AuthStoreProvider');
  }

  return context;
};

/**
 * Hook to get just the auth status (lighter than full store)
 *
 * @example
 * ```tsx
 * const authStatus = useAuthStatus();
 * const isSignedIn = authStatus?.isAuthenticated ?? false;
 * ```
 */
export const useAuthStatus = (): ExtendedAuthStatus | null => {
  const { authStatus } = useAuthStore();
  return authStatus;
};

/**
 * Hook to get just the user profile
 *
 * @example
 * ```tsx
 * const profile = useUserProfile();
 * return <Avatar email={profile?.email} />;
 * ```
 */
export const useUserProfile = (): UserProfile | null => {
  const { profile } = useAuthStore();
  return profile;
};

/**
 * Hook to check if user is authenticated (computed property)
 *
 * @example
 * ```tsx
 * const isAuthenticated = useIsAuthenticated();
 * if (!isAuthenticated) return <SignInPrompt />;
 * ```
 */
export const useIsAuthenticated = (): boolean => {
  const { authStatus } = useAuthStore();
  return authStatus?.isAuthenticated ?? false;
};
