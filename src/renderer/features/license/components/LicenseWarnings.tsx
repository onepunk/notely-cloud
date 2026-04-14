import * as React from 'react';

import { useLicense } from '@shared/hooks/useLicense';

import { CacheExpiryWarning } from './CacheExpiryWarning';
import { ExpiredModal } from './ExpiredModal';
import { ExpiryBanner } from './ExpiryBanner';

export interface LicenseWarningsProps {
  onRenewLicense?: () => void;
  onConnectForValidation?: () => void;
  supportUrl?: string;
  className?: string;
}

/**
 * Unified component that manages all license warning UI based on license state.
 *
 * Displays:
 * - Cache expiry warnings when offline and approaching 7-day limit
 * - License expiry banners when license is approaching expiration or expired
 * - Blocking modal when license is expired
 *
 * Usage:
 * ```tsx
 * <LicenseWarnings
 *   onRenewLicense={() => navigateToRenewal()}
 *   onConnectForValidation={() => attemptOnlineValidation()}
 *   supportUrl="https://yourdomain.com/support"
 * />
 * ```
 */
export const LicenseWarnings: React.FC<LicenseWarningsProps> = ({
  onRenewLicense,
  onConnectForValidation,
  supportUrl,
  className,
}) => {
  const { license } = useLicense();
  const [showExpiredModal, setShowExpiredModal] = React.useState(false);

  // Show expired modal on startup if license is expired
  React.useEffect(() => {
    if (license.status === 'expired') {
      setShowExpiredModal(true);
    } else {
      setShowExpiredModal(false);
    }
  }, [license.status]);

  return (
    <>
      {/* Cache expiry warnings (only in offline mode) */}
      <CacheExpiryWarning className={className} onConnectClick={onConnectForValidation} />

      {/* License expiry banner (for non-expired states) */}
      {license.status !== 'expired' && (
        <ExpiryBanner className={className} onRenew={onRenewLicense} />
      )}

      {/* Blocking modal when license is expired */}
      <ExpiredModal
        open={showExpiredModal}
        onDismiss={() => {
          // Only allow dismissal if license is no longer expired
          if (license.status !== 'expired') {
            setShowExpiredModal(false);
          }
        }}
        supportUrl={supportUrl}
      />
    </>
  );
};

LicenseWarnings.displayName = 'LicenseWarnings';
