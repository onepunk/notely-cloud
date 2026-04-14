import * as React from 'react';

import {
  LicenseSummary,
  LicenseTier,
  LicenseTierKey,
  LicenseValidationMode,
  LicenseState,
  LicenseGrantType,
} from '@features/license/types';

type LicenseIpcPayload = Partial<LicenseSummary> &
  Record<string, unknown> & {
    validatedAt?: string | null;
    warning?: string | null;
  };

export interface LicenseContextValue {
  license: LicenseSummary;
  loading: boolean;
  activating: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  activate: (key: string) => Promise<{ success: boolean; message?: string }>;
  clear: () => Promise<void>;
  hasFeature: (feature: string) => boolean;
  // Upgrade polling for license sync after purchase
  upgradePollingActive: boolean;
  startUpgradePolling: () => Promise<void>;
  stopUpgradePolling: () => Promise<void>;
}

const buildDefaultLicense = (): LicenseSummary => ({
  status: 'unlicensed',
  type: 'unknown',
  tierKey: 'unknown',
  tierName: 'Unknown',
  validationMode: 'unknown',
  expiresAt: null,
  lastValidatedAt: null,
  nextValidationAt: null,
  daysRemaining: null,
  features: [],
  issuedTo: null,
  statusMessage: null,
});

const LicenseContext = React.createContext<LicenseContextValue | null>(null);

const asLicenseState = (value: unknown): LicenseState => {
  if (value === 'active' || value === 'expired' || value === 'expiring' || value === 'invalid') {
    return value;
  }
  return 'unlicensed';
};

const asTier = (value: unknown): LicenseTier => {
  if (value === 'public' || value === 'custom') {
    return value;
  }
  return 'unknown';
};

const asTierKey = (value: unknown): LicenseTierKey => {
  if (
    value === 'free' ||
    value === 'starter' ||
    value === 'professional' ||
    value === 'enterprise'
  ) {
    return value;
  }
  return 'unknown';
};

const asTierName = (value: unknown): string => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return 'Unknown';
};

const asValidationMode = (value: unknown): LicenseValidationMode => {
  if (value === 'online' || value === 'offline') {
    return value;
  }
  return 'unknown';
};

const asGrantType = (value: unknown): LicenseGrantType | undefined => {
  if (
    value === 'purchase' ||
    value === 'beta' ||
    value === 'trial' ||
    value === 'promotional' ||
    value === 'admin_grant'
  ) {
    return value;
  }
  return undefined;
};

const safeDateString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
};

const calculateDaysRemaining = (expiresAt: string | null): number | null => {
  if (!expiresAt) return null;
  const target = new Date(expiresAt);
  if (Number.isNaN(target.getTime())) return null;
  const diff = target.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
};

const friendlyErrorMessage = (error: unknown, fallback: string): string => {
  const rawMessage = error instanceof Error ? error.message : fallback;
  if (/No handler registered/.test(rawMessage) || /license:get-/.test(rawMessage)) {
    return 'License service is not available in this build yet.';
  }
  if (/remote method/.test(rawMessage)) {
    return fallback;
  }
  return rawMessage || fallback;
};

export const LicenseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [license, setLicense] = React.useState<LicenseSummary>(() => buildDefaultLicense());
  const [loading, setLoading] = React.useState(false);
  const [activating, setActivating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [upgradePollingActive, setUpgradePollingActive] = React.useState(false);

  const mapPayload = React.useCallback((payload: LicenseIpcPayload | null | undefined) => {
    const base = buildDefaultLicense();
    if (!payload || typeof payload !== 'object') {
      return base;
    }

    const expiresAt = safeDateString(payload.expiresAt);
    const lastValidatedAt =
      safeDateString(payload.lastValidatedAt) ?? safeDateString(payload.validatedAt);
    const nextValidationAt = safeDateString(payload.nextValidationAt);

    const grantType = asGrantType(payload.grantType);

    return {
      status: asLicenseState(payload.status),
      type: asTier(payload.type),
      tierKey: asTierKey(payload.tierKey),
      tierName: asTierName(payload.tierName),
      grantType,
      isBeta: payload.isBeta === true || grantType === 'beta',
      validationMode: asValidationMode(payload.validationMode),
      expiresAt,
      lastValidatedAt,
      nextValidationAt,
      daysRemaining: calculateDaysRemaining(expiresAt),
      features: Array.isArray(payload.features)
        ? payload.features.filter((feature): feature is string => typeof feature === 'string')
        : [],
      issuedTo: typeof payload.issuedTo === 'string' ? payload.issuedTo : null,
      statusMessage:
        typeof payload.statusMessage === 'string'
          ? payload.statusMessage
          : typeof payload.warning === 'string'
            ? payload.warning
            : null,
    };
  }, []);

  const refresh = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      if (!window.api?.license?.getCurrent) {
        setLicense(buildDefaultLicense());
        return;
      }
      const payload = await window.api.license.getCurrent();
      setLicense(mapPayload(payload));
    } catch (err) {
      const message = friendlyErrorMessage(
        err,
        'Unable to retrieve the current license. Please try again later.'
      );
      setError(message);
      setLicense((prev) => ({
        ...buildDefaultLicense(),
        statusMessage: prev.status !== 'unlicensed' ? prev.statusMessage : message,
      }));
    } finally {
      setLoading(false);
    }
  }, [mapPayload]);

  const activate = React.useCallback(
    async (key: string) => {
      const normalized = key.trim();
      if (!normalized) {
        const message = 'Enter a license key before activating.';
        setError(message);
        return { success: false, message };
      }
      try {
        setActivating(true);
        setError(null);
        if (!window.api?.license?.validate) {
          throw new Error('License validation is not available in this build.');
        }
        const payload = await window.api.license.validate(normalized);
        setLicense(mapPayload(payload));
        return { success: true };
      } catch (err) {
        const message = friendlyErrorMessage(
          err,
          'License activation failed. Please verify the key and try again.'
        );
        setError(message);
        return { success: false, message };
      } finally {
        setActivating(false);
      }
    },
    [mapPayload]
  );

  const clear = React.useCallback(async () => {
    try {
      setError(null);
      if (window.api?.license?.clearCache) {
        await window.api.license.clearCache();
      }
    } finally {
      setLicense(buildDefaultLicense());
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (typeof window.api?.license?.onChanged !== 'function') {
      return undefined;
    }
    const unsubscribe = window.api.license.onChanged((payload: LicenseIpcPayload) => {
      setLicense(mapPayload(payload));
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* ignore cleanup errors */
      }
    };
  }, [mapPayload]);

  // Check for license updates when user returns to the app
  // This helps detect if user purchased a license in the browser
  React.useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Refresh license when window becomes visible
        void refresh();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh]);

  const hasFeature = React.useCallback(
    (feature: string) => license.features?.includes(feature) ?? false,
    [license.features]
  );

  // Upgrade polling methods
  const startUpgradePolling = React.useCallback(async () => {
    if (window.api?.license?.startUpgradePolling) {
      await window.api.license.startUpgradePolling();
    }
  }, []);

  const stopUpgradePolling = React.useCallback(async () => {
    if (window.api?.license?.stopUpgradePolling) {
      await window.api.license.stopUpgradePolling();
    }
  }, []);

  // Subscribe to upgrade polling status changes
  React.useEffect(() => {
    if (typeof window.api?.license?.onUpgradePollingStatusChanged !== 'function') {
      return undefined;
    }

    // Get initial status
    void window.api.license.getUpgradePollingStatus?.().then((status) => {
      setUpgradePollingActive(status?.isActive ?? false);
    });

    const unsubscribe = window.api.license.onUpgradePollingStatusChanged((status) => {
      setUpgradePollingActive(status?.isActive ?? false);
    });

    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* ignore cleanup errors */
      }
    };
  }, []);

  const contextValue = React.useMemo<LicenseContextValue>(
    () => ({
      license,
      loading,
      activating,
      error,
      refresh,
      activate,
      clear,
      hasFeature,
      upgradePollingActive,
      startUpgradePolling,
      stopUpgradePolling,
    }),
    [
      activate,
      activating,
      clear,
      error,
      hasFeature,
      license,
      loading,
      refresh,
      upgradePollingActive,
      startUpgradePolling,
      stopUpgradePolling,
    ]
  );

  return <LicenseContext.Provider value={contextValue}>{children}</LicenseContext.Provider>;
};

export const useLicense = (): LicenseContextValue => {
  const context = React.useContext(LicenseContext);
  if (!context) {
    throw new Error('useLicense must be used within a LicenseProvider');
  }
  return context;
};
