import * as React from 'react';

import { useLicense } from '../hooks/useLicense';
import { useUpgradeAction } from '../hooks/useUpgradeAction';

export interface FeatureGateProps {
  /**
   * Feature key to check (e.g., 'ai-summary', 'advanced-search').
   */
  feature: string;

  /**
   * Content to render when the feature is enabled.
   */
  children: React.ReactNode;

  /**
   * Optional fallback content to render when the feature is disabled.
   * If not provided, nothing is rendered when the feature is disabled.
   */
  fallback?: React.ReactNode;

  /**
   * Optional inverse mode - render children when feature is NOT enabled.
   * Useful for showing upgrade prompts or disabled state UI.
   */
  inverse?: boolean;
}

/**
 * FeatureGate component for conditional rendering based on license features.
 *
 * @example
 * ```tsx
 * // Show content only if AI summary feature is enabled
 * <FeatureGate feature="ai-summary">
 *   <AISummaryButton />
 * </FeatureGate>
 *
 * // Show upgrade prompt if feature is disabled
 * <FeatureGate feature="advanced-search" inverse>
 *   <UpgradePrompt feature="Advanced Search" />
 * </FeatureGate>
 *
 * // Show fallback UI when disabled
 * <FeatureGate
 *   feature="team-sharing"
 *   fallback={<DisabledShareButton />}
 * >
 *   <ShareButton />
 * </FeatureGate>
 * ```
 */
export const FeatureGate: React.FC<FeatureGateProps> = ({
  feature,
  children,
  fallback,
  inverse = false,
}) => {
  const { hasFeature, loading } = useLicense();

  // Wait for license to load before rendering
  if (loading) {
    return null;
  }

  const isEnabled = hasFeature(feature);
  const shouldRender = inverse ? !isEnabled : isEnabled;

  if (shouldRender) {
    return <>{children}</>;
  }

  if (fallback) {
    return <>{fallback}</>;
  }

  return null;
};

/**
 * Hook version of FeatureGate for more complex conditional logic.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const isEnabled = useFeature('ai-summary');
 *
 *   if (!isEnabled) {
 *     return <UpgradePrompt />;
 *   }
 *
 *   return <AISummaryPanel />;
 * };
 * ```
 */
export const useFeature = (feature: string): boolean => {
  const { hasFeature } = useLicense();
  return hasFeature(feature);
};

/**
 * Hook to check multiple features at once.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const { hasFeature, hasAll, hasAny } = useFeatures();
 *
 *   const canExport = hasFeature('export-formats');
 *   const canShare = hasAll(['team-sharing', 'advanced-search']);
 *   const hasPremiumFeature = hasAny(['ai-summary', 'custom-templates']);
 *
 *   // ...
 * };
 * ```
 */
export const useFeatures = () => {
  const { hasFeature, license } = useLicense();

  const hasAll = React.useCallback(
    (features: string[]): boolean => {
      return features.every((f) => hasFeature(f));
    },
    [hasFeature]
  );

  const hasAny = React.useCallback(
    (features: string[]): boolean => {
      return features.some((f) => hasFeature(f));
    },
    [hasFeature]
  );

  return {
    hasFeature,
    hasAll,
    hasAny,
    enabledFeatures: license.features,
  };
};

/**
 * Example UpgradePrompt component for use with FeatureGate.
 * This is a basic template - customize to match your design system.
 */
export interface UpgradePromptProps {
  feature: string;
  description?: string;
  onUpgrade?: () => void;
}

export const UpgradePrompt: React.FC<UpgradePromptProps> = ({
  feature,
  description,
  onUpgrade,
}) => {
  const { handleUpgrade: handleUpgradeAction, isPendingAuth } = useUpgradeAction();

  const handleClick = async () => {
    if (onUpgrade) {
      onUpgrade();
    } else {
      // Default: use auth-gated upgrade action
      await handleUpgradeAction();
    }
  };

  return (
    <div
      style={{
        padding: '16px',
        border: '1px solid #e0e0e0',
        borderRadius: '8px',
        backgroundColor: '#f9f9f9',
        textAlign: 'center',
      }}
    >
      <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 600 }}>Upgrade to Premium</h3>
      {description && (
        <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#666' }}>{description}</p>
      )}
      <p style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#666' }}>
        {feature} requires a premium license
      </p>
      <button
        onClick={handleClick}
        disabled={isPendingAuth}
        style={{
          padding: '8px 16px',
          backgroundColor: isPendingAuth ? '#6c757d' : '#007bff',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: isPendingAuth ? 'not-allowed' : 'pointer',
          fontSize: '14px',
        }}
      >
        {isPendingAuth ? 'Signing in...' : 'Upgrade to Premium'}
      </button>
    </div>
  );
};
