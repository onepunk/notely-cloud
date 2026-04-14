import { Button, MessageBar, MessageBarBody, MessageBarTitle } from '@fluentui/react-components';
import { Dismiss24Regular, Open16Regular } from '@fluentui/react-icons';
import * as React from 'react';

import { useLicense } from '@shared/hooks/useLicense';
import { useUpgradeAction } from '@shared/hooks/useUpgradeAction';

import styles from './ExpiryBanner.module.css';

export interface ExpiryBannerProps {
  className?: string;
  onRenew?: () => void;
}

type WarningLevel = 'info' | 'warning' | 'critical' | 'none';

const getWarningLevel = (status: string, daysRemaining: number | null): WarningLevel => {
  if (status === 'expired') {
    return 'critical';
  }
  if (status === 'expiring' && daysRemaining !== null) {
    if (daysRemaining <= 7) {
      return 'warning';
    }
    if (daysRemaining <= 30) {
      return 'info';
    }
  }
  return 'none';
};

const getWarningIntent = (level: WarningLevel): 'info' | 'warning' | 'error' => {
  switch (level) {
    case 'info':
      return 'info';
    case 'warning':
      return 'warning';
    case 'critical':
      return 'error';
    default:
      return 'info';
  }
};

const getWarningMessage = (
  level: WarningLevel,
  daysRemaining: number | null
): { title: string; message: string } => {
  switch (level) {
    case 'info':
      return {
        title: 'License Expiring',
        message:
          daysRemaining !== null
            ? `Your license expires in ${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'}.`
            : 'Your license will expire soon.',
      };
    case 'warning':
      return {
        title: 'License Expires Soon',
        message:
          daysRemaining !== null
            ? `Your license expires in ${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'}. Please renew to avoid interruption.`
            : 'Your license expires soon. Please renew to avoid interruption.',
      };
    case 'critical':
      return {
        title: 'License Expired',
        message: 'Your license has expired. Please renew to continue using Notely.',
      };
    default:
      return { title: '', message: '' };
  }
};

export const ExpiryBanner: React.FC<ExpiryBannerProps> = ({ className, onRenew }) => {
  const { license } = useLicense();
  const { handleUpgrade, isPendingAuth } = useUpgradeAction();
  const [dismissed, setDismissed] = React.useState(false);

  const warningLevel = React.useMemo(
    () => getWarningLevel(license.status, license.daysRemaining),
    [license.status, license.daysRemaining]
  );

  const intent = getWarningIntent(warningLevel);
  const { title, message } = getWarningMessage(warningLevel, license.daysRemaining);

  // Reset dismissed state when warning level changes
  React.useEffect(() => {
    setDismissed(false);
  }, [warningLevel]);

  // Don't show banner if no warning or if dismissed (and not critical)
  if (warningLevel === 'none' || (dismissed && warningLevel !== 'critical')) {
    return null;
  }

  const canDismiss = warningLevel !== 'critical';
  const containerClassName = className ? `${styles.container} ${className}` : styles.container;

  const handleRenew = async () => {
    if (onRenew) {
      onRenew();
    } else {
      await handleUpgrade();
    }
  };

  const buttonText = isPendingAuth
    ? 'Signing in...'
    : license.status === 'expired'
      ? 'Renew License'
      : 'Upgrade Now';

  return (
    <div
      className={containerClassName}
      data-testid="expiry-banner"
      data-warning-level={warningLevel}
    >
      <MessageBar intent={intent} className={styles.messageBar}>
        <MessageBarBody>
          <div className={styles.content}>
            <div className={styles.textContent}>
              <MessageBarTitle>{title}</MessageBarTitle>
              <div className={styles.message}>{message}</div>
            </div>
            <div className={styles.actions}>
              <Button
                appearance="primary"
                size="small"
                icon={<Open16Regular />}
                iconPosition="after"
                onClick={handleRenew}
                disabled={isPendingAuth}
              >
                {buttonText}
              </Button>
              {canDismiss && (
                <Button
                  appearance="transparent"
                  size="small"
                  icon={<Dismiss24Regular />}
                  onClick={() => setDismissed(true)}
                  aria-label="Dismiss warning"
                />
              )}
            </div>
          </div>
        </MessageBarBody>
      </MessageBar>
    </div>
  );
};

ExpiryBanner.displayName = 'ExpiryBanner';
