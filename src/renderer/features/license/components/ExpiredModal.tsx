import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components';
import { Open16Regular, Warning24Regular } from '@fluentui/react-icons';
import * as React from 'react';

import { useLicense } from '@shared/hooks/useLicense';
import { useUpgradeAction } from '@shared/hooks/useUpgradeAction';

import { LicenseKeyInput } from '../LicenseKeyInput';

import styles from './ExpiredModal.module.css';

export interface ExpiredModalProps {
  open: boolean;
  onDismiss?: () => void;
  supportUrl?: string;
}

const formatExpiryDate = (dateString: string | null): string => {
  if (!dateString) return 'Unknown';
  try {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return 'Unknown';
  }
};

export const ExpiredModal: React.FC<ExpiredModalProps> = ({
  open,
  onDismiss,
  supportUrl = 'https://yourdomain.com/support',
}) => {
  const { license, activate, activating, error } = useLicense();
  const { handleUpgrade, isPendingAuth } = useUpgradeAction();
  const [licenseKey, setLicenseKey] = React.useState('');
  const [showKeyInput, setShowKeyInput] = React.useState(false);
  const [isValid, setIsValid] = React.useState(false);

  const expiryDate = formatExpiryDate(license.expiresAt);
  const reason = license.statusMessage || 'Your license has expired and needs to be renewed.';

  const handleActivate = React.useCallback(async () => {
    if (!isValid || !licenseKey.trim()) return;

    const result = await activate(licenseKey.trim());
    if (result.success) {
      setLicenseKey('');
      // License hook will update status, modal will close automatically
      onDismiss?.();
    }
  }, [activate, isValid, licenseKey, onDismiss]);

  const handleOpenSupport = React.useCallback(() => {
    if (window.api?.shell?.openExternal) {
      window.api.shell.openExternal(supportUrl);
    }
  }, [supportUrl]);

  // Prevent dismissal when license is expired
  const handleDismiss = React.useCallback(() => {
    if (license.status !== 'expired') {
      onDismiss?.();
    }
  }, [license.status, onDismiss]);

  return (
    <Dialog
      open={open}
      modalType="modal"
      onOpenChange={(event, data) => {
        if (!data.open) {
          handleDismiss();
        }
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <div className={styles.header}>
            <Warning24Regular className={styles.icon} />
            <DialogTitle>License Expired</DialogTitle>
          </div>
          <DialogContent className={styles.content}>
            <div className={styles.expiryInfo}>
              <div className={styles.infoRow}>
                <span className={styles.label}>Expired on:</span>
                <span className={styles.value}>{expiryDate}</span>
              </div>
              <div className={styles.infoRow}>
                <span className={styles.label}>Reason:</span>
                <span className={styles.value}>{reason}</span>
              </div>
            </div>

            <div className={styles.instructions}>
              <p>To continue using Notely, please renew your license or enter a new license key.</p>
            </div>

            <div className={styles.renewSection}>
              <Button
                appearance="primary"
                size="large"
                icon={<Open16Regular />}
                iconPosition="after"
                onClick={handleUpgrade}
                disabled={isPendingAuth}
                className={styles.renewButton}
              >
                {isPendingAuth ? 'Signing in...' : 'Renew License'}
              </Button>
              <p className={styles.renewHint}>
                Already renewed?{' '}
                <button
                  type="button"
                  className={styles.toggleLink}
                  onClick={() => setShowKeyInput(!showKeyInput)}
                >
                  {showKeyInput ? 'Hide license key entry' : 'Enter your license key here'}
                </button>
              </p>
            </div>

            {showKeyInput && (
              <>
                <LicenseKeyInput
                  value={licenseKey}
                  onChange={setLicenseKey}
                  onActivate={handleActivate}
                  disabled={activating}
                  activating={activating}
                  onValidityChange={setIsValid}
                  helperText="Enter your new license key to reactivate Notely."
                />

                {error && (
                  <div className={styles.error} role="alert">
                    {error}
                  </div>
                )}
              </>
            )}
          </DialogContent>
          <DialogActions className={styles.actions}>
            <Button appearance="secondary" onClick={handleOpenSupport}>
              Contact Support
            </Button>
            {showKeyInput && (
              <Button
                appearance="primary"
                onClick={handleActivate}
                disabled={!isValid || activating || !licenseKey.trim()}
              >
                {activating ? 'Activating...' : 'Activate License'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};

ExpiredModal.displayName = 'ExpiredModal';
