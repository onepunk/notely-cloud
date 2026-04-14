import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from '@fluentui/react-components';
import { CloudOff24Regular, Warning24Regular } from '@fluentui/react-icons';
import * as React from 'react';

import { useLicense } from '@shared/hooks/useLicense';

import styles from './CacheExpiryWarning.module.css';

export interface CacheExpiryWarningProps {
  className?: string;
  onConnectClick?: () => void;
}

type CacheWarningLevel = 'none' | 'approaching' | 'today' | 'expired';

/**
 * Calculate cache warning level based on last validation time
 * Day 6: approaching (1 day remaining)
 * Day 7: today (connect today)
 * Day 8+: expired (blocking modal)
 */
const getCacheWarningLevel = (
  validationMode: string,
  lastValidatedAt: string | null,
  status: string
): CacheWarningLevel => {
  // Only show warnings in offline mode
  if (validationMode !== 'offline') {
    return 'none';
  }

  // If license is already expired or invalid, don't show cache warnings
  if (status === 'expired' || status === 'invalid') {
    return 'none';
  }

  if (!lastValidatedAt) {
    return 'expired';
  }

  try {
    const lastValidated = new Date(lastValidatedAt);
    if (Number.isNaN(lastValidated.getTime())) {
      return 'expired';
    }

    const now = new Date();
    const daysSinceValidation = Math.floor(
      (now.getTime() - lastValidated.getTime()) / (24 * 60 * 60 * 1000)
    );

    if (daysSinceValidation >= 7) {
      return 'expired';
    } else if (daysSinceValidation === 6) {
      return 'approaching';
    } else if (daysSinceValidation === 5) {
      return 'today';
    }

    return 'none';
  } catch {
    return 'expired';
  }
};

const getDaysUntilExpiry = (lastValidatedAt: string | null): number => {
  if (!lastValidatedAt) return 0;
  try {
    const lastValidated = new Date(lastValidatedAt);
    if (Number.isNaN(lastValidated.getTime())) return 0;

    const now = new Date();
    const daysSinceValidation = Math.floor(
      (now.getTime() - lastValidated.getTime()) / (24 * 60 * 60 * 1000)
    );
    return Math.max(0, 7 - daysSinceValidation);
  } catch {
    return 0;
  }
};

export const CacheExpiryWarning: React.FC<CacheExpiryWarningProps> = ({
  className,
  onConnectClick,
}) => {
  const { license, refresh } = useLicense();

  const warningLevel = React.useMemo(
    () => getCacheWarningLevel(license.validationMode, license.lastValidatedAt, license.status),
    [license.validationMode, license.lastValidatedAt, license.status]
  );

  const daysRemaining = React.useMemo(
    () => getDaysUntilExpiry(license.lastValidatedAt),
    [license.lastValidatedAt]
  );

  const handleConnect = React.useCallback(async () => {
    if (onConnectClick) {
      onConnectClick();
    } else {
      await refresh();
    }
  }, [onConnectClick, refresh]);

  // Banner for approaching expiry
  if (warningLevel === 'approaching' || warningLevel === 'today') {
    const isToday = warningLevel === 'today';
    const intent = isToday ? 'warning' : 'info';
    const title = isToday ? 'Connect Today to Continue' : 'License Validation Required Soon';
    const message = isToday
      ? 'Your offline license cache expires today. Connect to the internet to validate your license and continue using Notely.'
      : `Your offline license cache expires in ${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'}. Connect to the internet to validate your license.`;

    const containerClassName = className ? `${styles.banner} ${className}` : styles.banner;

    return (
      <div
        className={containerClassName}
        data-testid="cache-expiry-banner"
        data-warning-level={warningLevel}
      >
        <MessageBar intent={intent}>
          <MessageBarBody>
            <div className={styles.bannerContent}>
              <div className={styles.textContent}>
                <MessageBarTitle>{title}</MessageBarTitle>
                <div className={styles.message}>{message}</div>
              </div>
              <Button appearance="primary" size="small" onClick={handleConnect}>
                Connect & Validate
              </Button>
            </div>
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  // Modal for expired cache
  if (warningLevel === 'expired') {
    return (
      <Dialog open modalType="modal">
        <DialogSurface className={styles.modalSurface}>
          <DialogBody>
            <div className={styles.modalHeader}>
              <CloudOff24Regular className={styles.modalIcon} />
              <DialogTitle>License Validation Expired</DialogTitle>
            </div>
            <DialogContent className={styles.modalContent}>
              <div className={styles.expiredInfo}>
                <Warning24Regular className={styles.warningIcon} />
                <div className={styles.expiredText}>
                  <p className={styles.primaryText}>
                    Your offline license cache has expired after 7 days without validation.
                  </p>
                  <p className={styles.secondaryText}>
                    Please connect to the internet to validate your license and continue using
                    Notely.
                  </p>
                </div>
              </div>

              <div className={styles.instructions}>
                <h4>What you need to do:</h4>
                <ol>
                  <li>Connect your device to the internet</li>
                  <li>Click the button below to validate your license</li>
                  <li>Once validated, you can continue working offline for another 7 days</li>
                </ol>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="primary" onClick={handleConnect}>
                Connect & Validate License
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    );
  }

  return null;
};

CacheExpiryWarning.displayName = 'CacheExpiryWarning';
