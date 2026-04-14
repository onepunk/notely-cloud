import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  MessageBar,
  Text,
} from '@fluentui/react-components';
import { Dismiss24Regular, Open16Regular } from '@fluentui/react-icons';
import * as React from 'react';

import { formatErrorForDisplay } from '@shared/error';
import { useUpgradeAction } from '@shared/hooks/useUpgradeAction';

import styles from './LicenseActivationDialog.module.css';
import { LicenseKeyInput } from './LicenseKeyInput';
import type { LicenseSummary } from './types';

export interface LicenseActivationDialogProps {
  license: LicenseSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onActivate: (key: string) => Promise<{ success: boolean; message?: string }>;
  onClear: () => Promise<void>;
  onRefresh: () => Promise<void>;
  activating?: boolean;
  loading?: boolean;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  expiring: 'Expiring Soon',
  expired: 'Expired',
  invalid: 'Invalid',
  unlicensed: 'No License',
};

const TYPE_LABELS: Record<string, string> = {
  public: 'Notely Cloud License',
  custom: 'Portal License',
  unknown: 'Not Configured',
};

export const LicenseActivationDialog: React.FC<LicenseActivationDialogProps> = ({
  license,
  open,
  onOpenChange,
  onActivate,
  onClear,
  onRefresh,
  activating = false,
  loading = false,
}) => {
  const { handleUpgrade, isPendingAuth } = useUpgradeAction();
  const [keyInput, setKeyInput] = React.useState('');
  const [showKeyInput, setShowKeyInput] = React.useState(false);
  const [message, setMessage] = React.useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  const handleActivate = async () => {
    if (!keyInput.trim()) return;
    setMessage(null);
    const result = await onActivate(keyInput);
    if (result.success) {
      setKeyInput('');
      setMessage({ type: 'success', text: 'License activated successfully.' });
    } else {
      setMessage({ type: 'error', text: formatErrorForDisplay(result.message, 'E1006') });
    }
  };

  const handleClear = async () => {
    await onClear();
    setKeyInput('');
    setMessage({ type: 'info', text: 'License cleared from this device.' });
  };

  const handleRefresh = async () => {
    setMessage(null);
    await onRefresh();
    setMessage({ type: 'info', text: 'License status refreshed.' });
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleDateString(undefined, { dateStyle: 'long' });
  };

  const formatFeature = (feature: string) => {
    const registry: Record<string, string> = {
      'ai-summary': 'AI Summarization',
      'advanced-search': 'Advanced Search',
      offline: 'Offline Mode',
      'cloud-sync': 'Cloud Sync',
    };
    const normalized = feature.toLowerCase();
    return (
      registry[normalized] ||
      normalized
        .split(/[-_]/g)
        .filter(Boolean)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' ')
    );
  };

  const statusLabel = STATUS_LABELS[license.status] || 'Unknown';
  const typeLabel = TYPE_LABELS[license.type] || 'Unknown';

  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle
            action={
              <DialogTrigger action="close">
                <Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" />
              </DialogTrigger>
            }
          >
            Manage License
          </DialogTitle>

          <DialogContent className={styles.content}>
            {message && (
              <MessageBar intent={message.type} className={styles.messageBar}>
                {message.text}
              </MessageBar>
            )}

            {/* Current License Info */}
            <div className={styles.infoSection}>
              <Text weight="semibold" className={styles.sectionTitle}>
                Current License
              </Text>

              <div className={styles.infoGrid}>
                <div className={styles.infoRow}>
                  <Text size={200} className={styles.infoLabel}>
                    Status
                  </Text>
                  <span
                    className={`${styles.statusBadge} ${styles[`status${license.status.charAt(0).toUpperCase() + license.status.slice(1)}`]}`}
                  >
                    {statusLabel}
                  </span>
                </div>

                <div className={styles.infoRow}>
                  <Text size={200} className={styles.infoLabel}>
                    Type
                  </Text>
                  <Text>{typeLabel}</Text>
                </div>

                {license.expiresAt && (
                  <div className={styles.infoRow}>
                    <Text size={200} className={styles.infoLabel}>
                      Expires
                    </Text>
                    <Text>
                      {formatDate(license.expiresAt)}
                      {typeof license.daysRemaining === 'number' && license.daysRemaining > 0 && (
                        <span className={styles.daysRemaining}>
                          {' '}
                          ({license.daysRemaining} days)
                        </span>
                      )}
                    </Text>
                  </div>
                )}

                {license.issuedTo && (
                  <div className={styles.infoRow}>
                    <Text size={200} className={styles.infoLabel}>
                      Issued to
                    </Text>
                    <Text>{license.issuedTo}</Text>
                  </div>
                )}
              </div>

              {license.features && license.features.length > 0 && (
                <div className={styles.featuresSection}>
                  <Text size={200} className={styles.infoLabel}>
                    Enabled features
                  </Text>
                  <div className={styles.featureList}>
                    {license.features.map((feature) => (
                      <span key={feature} className={styles.featureTag}>
                        {formatFeature(feature)}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <Button
                size="small"
                appearance="secondary"
                onClick={handleRefresh}
                disabled={loading}
                className={styles.refreshButton}
              >
                {loading ? 'Checking...' : 'Check status'}
              </Button>
            </div>

            {/* Activation Section */}
            <div className={styles.activationSection}>
              <Text weight="semibold" className={styles.sectionTitle}>
                {license.status === 'unlicensed' ? 'Get Premium' : 'Update License'}
              </Text>

              {/* Primary: Upgrade to Premium Button */}
              <div className={styles.upgradeContainer}>
                <Text size={300} className={styles.upgradeText}>
                  {license.status === 'unlicensed'
                    ? 'Unlock premium features with a Notely license'
                    : license.status === 'expired'
                      ? 'Renew your license to continue using premium features'
                      : 'Upgrade or renew your license'}
                </Text>
                <Button
                  appearance="primary"
                  size="large"
                  icon={<Open16Regular />}
                  iconPosition="after"
                  onClick={handleUpgrade}
                  disabled={isPendingAuth}
                  className={styles.upgradeButton}
                >
                  {isPendingAuth
                    ? 'Signing in...'
                    : license.status === 'unlicensed'
                      ? 'Upgrade to Premium'
                      : license.status === 'expired'
                        ? 'Renew License'
                        : 'Manage License'}
                </Button>
              </div>

              {/* Secondary: Manual License Key Entry */}
              <div className={styles.manualKeySection}>
                <Text size={200} className={styles.manualKeyText}>
                  Already have a license key?{' '}
                  <Button
                    appearance="transparent"
                    size="small"
                    onClick={() => setShowKeyInput(!showKeyInput)}
                    className={styles.toggleLink}
                  >
                    {showKeyInput ? 'Hide' : 'Enter it here'}
                  </Button>
                </Text>

                {showKeyInput && (
                  <LicenseKeyInput
                    value={keyInput}
                    onChange={setKeyInput}
                    onActivate={handleActivate}
                    onClear={handleClear}
                    activating={activating}
                    disabled={loading}
                    helperText="Paste your license key from the portal or Notely Cloud."
                  />
                )}
              </div>
            </div>
          </DialogContent>

          <DialogActions>
            <DialogTrigger disableButtonEnhancement>
              <Button appearance="secondary">Close</Button>
            </DialogTrigger>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};

LicenseActivationDialog.displayName = 'LicenseActivationDialog';
