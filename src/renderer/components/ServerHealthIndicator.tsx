import { Spinner, Tooltip } from '@fluentui/react-components';
import {
  CheckmarkCircle20Filled,
  DismissCircle20Filled,
  Circle20Regular,
} from '@fluentui/react-icons';
import * as React from 'react';

import { formatErrorForDisplay } from '@shared/error';

import styles from './ServerHealthIndicator.module.css';

export interface ServerHealthIndicatorProps {
  apiUrl: string;
  className?: string;
  autoRefreshIntervalMs?: number;
}

export const ServerHealthIndicator: React.FC<ServerHealthIndicatorProps> = ({
  apiUrl,
  className = '',
  autoRefreshIntervalMs = 300000, // 5 minutes
}) => {
  const [checking, setChecking] = React.useState(false);
  const [health, setHealth] = React.useState<{
    online: boolean;
    responseTime: number;
    error?: string;
  } | null>(null);

  const checkHealth = React.useCallback(async () => {
    if (!apiUrl) {
      return;
    }

    try {
      setChecking(true);
      const result = await window.api.license.checkServerHealth(apiUrl);
      setHealth(result);
    } catch (error) {
      const errorMessage = formatErrorForDisplay(error, 'E2002', { apiUrl });
      setHealth({
        online: false,
        responseTime: 0,
        error: errorMessage,
      });
    } finally {
      setChecking(false);
    }
  }, [apiUrl]);

  // Initial check
  React.useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  // Auto-refresh
  React.useEffect(() => {
    if (!autoRefreshIntervalMs || autoRefreshIntervalMs <= 0) {
      return;
    }

    const interval = setInterval(() => {
      void checkHealth();
    }, autoRefreshIntervalMs);

    return () => clearInterval(interval);
  }, [autoRefreshIntervalMs, checkHealth]);

  if (checking) {
    return (
      <div className={`${styles.indicator} ${className}`}>
        <Spinner size="tiny" />
        <span className={styles.statusText}>Checking...</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className={`${styles.indicator} ${className}`}>
        <Circle20Regular className={styles.iconUnknown} />
        <span className={styles.statusText}>Unknown</span>
      </div>
    );
  }

  if (health.online) {
    const tooltipContent = `Server is online (${health.responseTime}ms response)`;
    return (
      <Tooltip content={tooltipContent} relationship="label">
        <div className={`${styles.indicator} ${styles.indicatorOnline} ${className}`}>
          <CheckmarkCircle20Filled className={styles.iconOnline} />
          <span className={styles.statusText}>Online ({health.responseTime}ms)</span>
        </div>
      </Tooltip>
    );
  }

  const tooltipContent = health.error ? `Server is offline: ${health.error}` : 'Server is offline';
  return (
    <Tooltip content={tooltipContent} relationship="label">
      <div className={`${styles.indicator} ${styles.indicatorOffline} ${className}`}>
        <DismissCircle20Filled className={styles.iconOffline} />
        <span className={styles.statusText}>Offline</span>
        {health.error && <span className={styles.errorText}>{health.error}</span>}
      </div>
    </Tooltip>
  );
};
