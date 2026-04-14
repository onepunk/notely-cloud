import { Badge, Button } from '@fluentui/react-components';
import { ArrowClockwise16Regular } from '@fluentui/react-icons';
import * as React from 'react';

import styles from './LicenseStatus.module.css';
import { LicenseState, LicenseValidationMode } from './types';

export interface LicenseStatusProps {
  status: LicenseState;
  validationMode?: LicenseValidationMode;
  lastValidatedAt?: Date | string | null;
  nextValidationAt?: Date | string | null;
  checking?: boolean;
  statusMessage?: string | null;
  className?: string;
  onCheckNow?: () => void;
}

type StatusDescriptor = {
  label: string;
  badgeColor: 'success' | 'informative' | 'important' | 'warning' | 'danger' | 'severe' | 'subtle';
};

const STATUS_MAP: Record<LicenseState, StatusDescriptor> = {
  active: { label: 'Active', badgeColor: 'success' },
  expiring: { label: 'Expiring soon', badgeColor: 'warning' },
  expired: { label: 'Expired', badgeColor: 'danger' },
  invalid: { label: 'Invalid', badgeColor: 'danger' },
  unlicensed: { label: 'Not activated', badgeColor: 'subtle' },
};

const MODE_LABEL: Record<LicenseValidationMode, string> = {
  online: 'Online',
  offline: 'Offline',
  unknown: 'Unknown',
};

const asDate = (value?: Date | string | null): Date | null => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getRelativeParts = (target: Date, base: Date) => {
  const diffMs = target.getTime() - base.getTime();
  const absMs = Math.abs(diffMs);

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let value: number;
  let unit: 'day' | 'hour' | 'minute';

  if (absMs >= day) {
    value = Math.round(absMs / day);
    unit = 'day';
  } else if (absMs >= hour) {
    value = Math.round(absMs / hour);
    unit = 'hour';
  } else {
    value = Math.max(1, Math.round(absMs / minute));
    unit = 'minute';
  }

  return { value, unit, isFuture: diffMs > 0 };
};

const formatRelativeTime = (value?: Date | string | null): { text: string; title?: string } => {
  const parsed = asDate(value);
  if (!parsed) {
    return { text: 'Unknown', title: undefined };
  }

  const { value: amount, unit, isFuture } = getRelativeParts(parsed, new Date());
  const plural = amount === 1 ? unit : `${unit}s`;
  const text = isFuture ? `in ${amount} ${plural}` : `${amount} ${plural} ago`;
  return { text, title: parsed.toLocaleString() };
};

export const LicenseStatus: React.FC<LicenseStatusProps> = ({
  status,
  validationMode = 'unknown',
  lastValidatedAt,
  nextValidationAt,
  checking = false,
  statusMessage,
  className,
  onCheckNow,
}) => {
  const descriptor = STATUS_MAP[status] ?? STATUS_MAP.unlicensed;
  const modeLabel = MODE_LABEL[validationMode] ?? MODE_LABEL.unknown;
  const lastValidated = formatRelativeTime(lastValidatedAt);
  const nextValidation = formatRelativeTime(nextValidationAt);

  const canCheck = typeof onCheckNow === 'function';
  const containerClassName = className ? `${styles.container} ${className}` : styles.container;

  return (
    <div className={containerClassName} data-testid="license-status">
      <div className={styles.header}>
        <div className={styles.statusInfo}>
          <Badge appearance="filled" color={descriptor.badgeColor}>
            {descriptor.label}
          </Badge>
          {statusMessage ? <span className={styles.statusMessage}>{statusMessage}</span> : null}
        </div>
        <Button
          appearance="secondary"
          size="small"
          icon={<ArrowClockwise16Regular />}
          onClick={() => {
            if (canCheck && !checking) {
              onCheckNow?.();
            }
          }}
          disabled={!canCheck || checking}
        >
          {checking ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      <div className={styles.metaGrid}>
        <div className={styles.metaBlock}>
          <span className={styles.metaLabel}>Validation mode</span>
          <span className={styles.metaValue}>{modeLabel}</span>
        </div>
        <div className={styles.metaBlock}>
          <span className={styles.metaLabel}>Last validated</span>
          <span className={styles.metaValue} title={lastValidated.title}>
            {lastValidated.text}
          </span>
        </div>
        <div className={styles.metaBlock}>
          <span className={styles.metaLabel}>Next validation</span>
          <span className={styles.metaValue} title={nextValidation.title}>
            {nextValidation.text}
          </span>
        </div>
      </div>
    </div>
  );
};

LicenseStatus.displayName = 'LicenseStatus';
