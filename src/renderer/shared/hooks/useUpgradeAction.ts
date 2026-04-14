/**
 * Centralized Auth-Gated Upgrade Action Hook
 *
 * This hook ensures users are authenticated before starting the upgrade/purchase flow.
 * It prevents the state mismatch where a user completes a purchase in the browser
 * but returns to the app without being signed in locally.
 *
 * Usage:
 * ```tsx
 * const { handleUpgrade, isPendingAuth } = useUpgradeAction();
 *
 * <Button onClick={handleUpgrade} disabled={isPendingAuth}>
 *   {isPendingAuth ? 'Signing in...' : 'Upgrade'}
 * </Button>
 * ```
 */

import * as React from 'react';

import { PLANS_URL } from '@common/config';
import { reportError } from '@shared/error';
import { useIsAuthenticated } from '@shared/hooks/useAuthStore';
import { useLicense } from '@shared/hooks/useLicense';

export interface UpgradeActionState {
  /** Trigger upgrade flow - checks auth first, opens sign-in if needed */
  handleUpgrade: () => Promise<void>;
  /** Whether an auth flow is currently pending before upgrade can proceed */
  isPendingAuth: boolean;
}

export function useUpgradeAction(): UpgradeActionState {
  const isAuthenticated = useIsAuthenticated();
  const { startUpgradePolling } = useLicense();
  const [isPendingAuth, setIsPendingAuth] = React.useState(false);

  const handleUpgrade = React.useCallback(async () => {
    if (!isAuthenticated) {
      // User not signed in - trigger OAuth first
      try {
        setIsPendingAuth(true);
        const opened = await window.api.auth.startWebLogin();
        if (!opened) {
          reportError(null, 'E1004');
          setIsPendingAuth(false);
        }
        // After auth completes, user will need to click Upgrade again
        // The auth:completed event will reset isPendingAuth via the effect below
      } catch (error) {
        reportError(error, 'E1001');
        setIsPendingAuth(false);
      }
    } else {
      // User is authenticated - proceed with upgrade
      await startUpgradePolling();
      window.api.window.openExternal(PLANS_URL);
    }
  }, [isAuthenticated, startUpgradePolling]);

  // When auth completes, automatically proceed to upgrade if user doesn't have a valid license
  // This handles the case where license is revoked, expired, invalid, or doesn't exist
  React.useEffect(() => {
    if (typeof window.api?.onAuthCompleted !== 'function') {
      return undefined;
    }

    const unsubscribe = window.api.onAuthCompleted(async () => {
      // If we were waiting for auth to complete before upgrade
      if (isPendingAuth) {
        setIsPendingAuth(false);

        // Small delay to let license state update after auth
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Fetch fresh license status to decide if we need to open purchase page
        try {
          const freshLicense = await window.api.license.getCurrent();
          const hasValidLicense =
            freshLicense?.status === 'active' || freshLicense?.status === 'expiring';

          if (!hasValidLicense) {
            // No valid license (unlicensed, invalid, revoked, expired) - open purchase page
            await startUpgradePolling();
            window.api.window.openExternal(PLANS_URL);
          }
          // If user has valid license, don't open browser - they clicked "Manage" not "Upgrade"
        } catch (error) {
          console.error('Failed to check license after auth:', error);
          // On error, still try to open upgrade page as fallback
          try {
            await startUpgradePolling();
            window.api.window.openExternal(PLANS_URL);
          } catch (e) {
            console.error('Failed to open upgrade page:', e);
          }
        }
      }
    });

    return () => {
      try {
        unsubscribe?.();
      } catch {
        // Ignore cleanup errors
      }
    };
  }, [isPendingAuth, startUpgradePolling]);

  return { handleUpgrade, isPendingAuth };
}
