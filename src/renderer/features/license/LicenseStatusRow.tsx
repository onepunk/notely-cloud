import { Button, Spinner, Text } from '@fluentui/react-components';
import { ChevronRight16Regular } from '@fluentui/react-icons';
import * as React from 'react';

import styles from './LicenseStatusRow.module.css';
import type { LicenseState, LicenseTier, LicenseGrantType } from './types';

export interface LicenseStatusRowProps {
  status: LicenseState;
  type: LicenseTier;
  tierName?: string; // New: actual tier display name (Professional, Starter, etc.)
  grantType?: LicenseGrantType; // How the license was acquired
  isBeta?: boolean; // Convenience flag for beta licenses
  expiresAt: string | null;
  daysRemaining: number | null;
  loading?: boolean;
  onAction?: () => void;
  actionLabel?: string;
}

const STATUS_CONFIG: Record<LicenseState, { label: string; className: string }> = {
  active: { label: 'Active', className: 'statusActive' },
  expiring: { label: 'Expiring', className: 'statusExpiring' },
  expired: { label: 'Expired', className: 'statusExpired' },
  invalid: { label: 'Invalid', className: 'statusInvalid' },
  unlicensed: { label: 'No License', className: 'statusUnlicensed' },
};

// Fallback labels for legacy type field (used when tierName is not available)
const TYPE_LABELS: Record<LicenseTier, string> = {
  public: 'Notely Cloud',
  custom: 'Portal License',
  unknown: 'Not configured',
};

export const LicenseStatusRow: React.FC<LicenseStatusRowProps> = ({
  status,
  type,
  tierName,
  grantType,
  isBeta,
  expiresAt,
  daysRemaining,
  loading = false,
  onAction,
  actionLabel = 'Manage',
}) => {
  const statusConfig = STATUS_CONFIG[status] || STATUS_CONFIG.unlicensed;
  // Prefer tierName (actual tier like "Professional") over legacy type labels
  const typeLabel =
    tierName && tierName !== 'Unknown' ? tierName : TYPE_LABELS[type] || TYPE_LABELS.unknown;

  const formatExpiry = () => {
    if (!expiresAt) return null;

    const date = new Date(expiresAt);
    if (Number.isNaN(date.getTime())) return null;

    const formatted = date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    if (typeof daysRemaining === 'number') {
      if (daysRemaining <= 0) return `Expired ${formatted}`;
      if (daysRemaining === 1) return `${formatted} (1 day left)`;
      return `${formatted} (${daysRemaining} days)`;
    }

    return formatted;
  };

  const expiryText = formatExpiry();

  if (loading) {
    return (
      <div className={styles.row}>
        <div className={styles.loadingState}>
          <Spinner size="tiny" />
          <Text size={200}>Checking license...</Text>
        </div>
      </div>
    );
  }

  // Don't show badge for 'active' (license name is enough) or 'invalid' (show "Not configured" only)
  const showBadge = status !== 'active' && status !== 'invalid';

  // Build display label with grant type suffix if applicable
  const getDisplayLabel = () => {
    // For invalid/unlicensed status, show "Free"
    if (status === 'invalid' || status === 'unlicensed') {
      return 'Free';
    }

    const baseLabel = typeLabel;

    // Append grant type indicator for non-purchase licenses
    if (isBeta || grantType === 'beta') {
      return `${baseLabel} (Beta)`;
    }
    if (grantType === 'trial') {
      return `${baseLabel} (Trial)`;
    }
    if (grantType === 'promotional') {
      return `${baseLabel} (Promo)`;
    }
    if (grantType === 'admin_grant') {
      return `${baseLabel} (Granted)`;
    }

    return baseLabel;
  };

  const displayTypeLabel = getDisplayLabel();

  return (
    <div className={styles.row}>
      <div className={styles.statusSection}>
        {showBadge && (
          <span className={`${styles.statusBadge} ${styles[statusConfig.className]}`}>
            {statusConfig.label}
          </span>
        )}
        <Text className={styles.typeLabel}>{displayTypeLabel}</Text>
        {expiryText && status !== 'unlicensed' && status !== 'invalid' && (
          <>
            <span className={styles.separator}>•</span>
            <Text size={200} className={styles.expiryText}>
              {expiryText}
            </Text>
          </>
        )}
      </div>

      {onAction && (
        <Button
          appearance="subtle"
          size="small"
          onClick={onAction}
          className={styles.manageButton}
          icon={<ChevronRight16Regular />}
          iconPosition="after"
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
};

LicenseStatusRow.displayName = 'LicenseStatusRow';
