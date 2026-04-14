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
  Spinner,
} from '@fluentui/react-components';
import { Dismiss24Regular } from '@fluentui/react-icons';
import * as React from 'react';

import styles from './LicenseDiagnostics.module.css';

interface LicenseDiagnosticsProps {
  className?: string;
}

interface DiagnosticData {
  licenseStatus: {
    status: string;
    type: string;
    validationMode: string;
    statusMessage: string | null;
  };
  cacheInfo: {
    lastValidatedAt: string | null;
    nextValidationAt: string | null;
    cacheAgeDays: number | null;
    daysUntilNextValidation: number | null;
  };
  features: {
    enabled: string[];
    count: number;
  };
  validationHistory: Array<{
    timestamp: string;
    success: boolean;
    validationType: string;
    errorMessage?: string;
    validationMode?: string;
  }>;
  heartbeatStatus: {
    isRunning: boolean;
    isPaused: boolean;
    sessionToken: string;
    lastHeartbeatTime?: string | null;
    activeSessions?: number;
  };
  serverConfig: {
    apiUrl: string;
    serverHealthy: boolean | null;
    lastChecked: string | null;
  };
  networkStatus: {
    online: boolean;
    lastOnlineTime: string | null;
  };
  systemInfo: {
    appVersion: string;
    platform: string;
    clientId: string;
    electronVersion: string;
    nodeVersion: string;
  };
  errorLogs: Array<{
    timestamp: string;
    level: string;
    message: string;
    context?: string;
  }>;
  metadata: {
    generatedAt: string;
    diagnosticVersion: string;
  };
}

export const LicenseDiagnostics: React.FC<LicenseDiagnosticsProps> = ({ className }) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [diagnostics, setDiagnostics] = React.useState<DiagnosticData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [exportMessage, setExportMessage] = React.useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const loadDiagnostics = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = (await window.api.license.getDiagnostics()) as DiagnosticData;
      setDiagnostics(data);
    } catch (err) {
      console.error('Failed to load diagnostics:', err);
      setError(err instanceof Error ? err.message : 'Failed to load diagnostics');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleOpen = () => {
    setIsOpen(true);
    void loadDiagnostics();
  };

  const handleClose = () => {
    setIsOpen(false);
    setDiagnostics(null);
    setError(null);
    setExportMessage(null);
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      setExportMessage(null);
      const result = await window.api.license.exportDiagnostics();
      if (result.success && result.path) {
        setExportMessage({
          type: 'success',
          text: `Diagnostics exported successfully to ${result.path}`,
        });
      } else {
        setExportMessage({
          type: 'error',
          text: result.error || 'Failed to export diagnostics',
        });
      }
    } catch (err) {
      console.error('Failed to export diagnostics:', err);
      setExportMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to export diagnostics',
      });
    } finally {
      setExporting(false);
    }
  };

  const formatTimestamp = (timestamp: string | null) => {
    if (!timestamp) return 'Never';
    try {
      const date = new Date(timestamp);
      return date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return timestamp;
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(_, data) => setIsOpen(data.open)}>
      <DialogTrigger disableButtonEnhancement>
        <Button appearance="outline" size="small" onClick={handleOpen} className={className}>
          View Diagnostics
        </Button>
      </DialogTrigger>

      <DialogSurface className={styles.dialogSurface}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                aria-label="Close"
                icon={<Dismiss24Regular />}
                onClick={handleClose}
              />
            }
          >
            License Diagnostics
          </DialogTitle>

          <DialogContent className={styles.dialogContent}>
            {loading && (
              <div className={styles.loadingState}>
                <Spinner size="medium" />
                <span>Loading diagnostics...</span>
              </div>
            )}

            {error && (
              <MessageBar intent="error" className={styles.message}>
                {error}
              </MessageBar>
            )}

            {exportMessage && (
              <MessageBar intent={exportMessage.type} className={styles.message}>
                {exportMessage.text}
              </MessageBar>
            )}

            {diagnostics && !loading && (
              <div className={styles.diagnosticsGrid}>
                {/* License Status Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>License Status</h3>
                  <div className={styles.dataTable}>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Status</span>
                      <span className={styles.dataValue}>{diagnostics.licenseStatus.status}</span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Type</span>
                      <span className={styles.dataValue}>{diagnostics.licenseStatus.type}</span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Validation Mode</span>
                      <span className={styles.dataValue}>
                        {diagnostics.licenseStatus.validationMode}
                      </span>
                    </div>
                    {diagnostics.licenseStatus.statusMessage && (
                      <div className={styles.dataRow}>
                        <span className={styles.dataLabel}>Status Message</span>
                        <span className={styles.dataValue}>
                          {diagnostics.licenseStatus.statusMessage}
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                {/* Cache Information Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Cache Information</h3>
                  <div className={styles.dataTable}>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Last Validated</span>
                      <span className={styles.dataValue}>
                        {formatTimestamp(diagnostics.cacheInfo.lastValidatedAt)}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Next Validation</span>
                      <span className={styles.dataValue}>
                        {formatTimestamp(diagnostics.cacheInfo.nextValidationAt)}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Cache Age</span>
                      <span className={styles.dataValue}>
                        {diagnostics.cacheInfo.cacheAgeDays !== null
                          ? `${diagnostics.cacheInfo.cacheAgeDays.toFixed(1)} days`
                          : 'N/A'}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Days Until Next Validation</span>
                      <span className={styles.dataValue}>
                        {diagnostics.cacheInfo.daysUntilNextValidation !== null
                          ? `${diagnostics.cacheInfo.daysUntilNextValidation.toFixed(1)} days`
                          : 'N/A'}
                      </span>
                    </div>
                  </div>
                </section>

                {/* Features Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>
                    Enabled Features ({diagnostics.features.count})
                  </h3>
                  {diagnostics.features.enabled.length > 0 ? (
                    <ul className={styles.featureList}>
                      {diagnostics.features.enabled.map((feature) => (
                        <li key={feature} className={styles.featureItem}>
                          {feature}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.emptyState}>No features enabled</p>
                  )}
                </section>

                {/* Validation History Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Recent Validation History</h3>
                  {diagnostics.validationHistory.length > 0 ? (
                    <div className={styles.historyList}>
                      {diagnostics.validationHistory.map((entry, index) => (
                        <div key={index} className={styles.historyItem}>
                          <div className={styles.historyHeader}>
                            <span
                              className={`${styles.historyStatus} ${entry.success ? styles.historySuccess : styles.historyFailure}`}
                            >
                              {entry.success ? 'Success' : 'Failed'}
                            </span>
                            <span className={styles.historyTime}>
                              {formatTimestamp(entry.timestamp)}
                            </span>
                          </div>
                          <div className={styles.historyDetails}>
                            <span>Type: {entry.validationType}</span>
                            {entry.validationMode && <span>Mode: {entry.validationMode}</span>}
                          </div>
                          {entry.errorMessage && (
                            <div className={styles.historyError}>{entry.errorMessage}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.emptyState}>No validation history available</p>
                  )}
                </section>

                {/* Heartbeat Status Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Heartbeat Status</h3>
                  <div className={styles.dataTable}>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Running</span>
                      <span className={styles.dataValue}>
                        {diagnostics.heartbeatStatus.isRunning ? 'Yes' : 'No'}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Paused</span>
                      <span className={styles.dataValue}>
                        {diagnostics.heartbeatStatus.isPaused ? 'Yes' : 'No'}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Session Token</span>
                      <span className={`${styles.dataValue} ${styles.monospace}`}>
                        {diagnostics.heartbeatStatus.sessionToken}
                      </span>
                    </div>
                    {diagnostics.heartbeatStatus.activeSessions !== undefined && (
                      <div className={styles.dataRow}>
                        <span className={styles.dataLabel}>Active Sessions</span>
                        <span className={styles.dataValue}>
                          {diagnostics.heartbeatStatus.activeSessions}
                        </span>
                      </div>
                    )}
                  </div>
                </section>

                {/* Server Configuration Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Server Configuration</h3>
                  <div className={styles.dataTable}>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>API URL</span>
                      <span className={`${styles.dataValue} ${styles.monospace}`}>
                        {diagnostics.serverConfig.apiUrl}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Server Healthy</span>
                      <span className={styles.dataValue}>
                        {diagnostics.serverConfig.serverHealthy === null
                          ? 'Unknown'
                          : diagnostics.serverConfig.serverHealthy
                            ? 'Yes'
                            : 'No'}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Last Checked</span>
                      <span className={styles.dataValue}>
                        {formatTimestamp(diagnostics.serverConfig.lastChecked)}
                      </span>
                    </div>
                  </div>
                </section>

                {/* Network Status Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Network Status</h3>
                  <div className={styles.dataTable}>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Online</span>
                      <span className={styles.dataValue}>
                        {diagnostics.networkStatus.online ? 'Yes' : 'No'}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Last Online</span>
                      <span className={styles.dataValue}>
                        {formatTimestamp(diagnostics.networkStatus.lastOnlineTime)}
                      </span>
                    </div>
                  </div>
                </section>

                {/* System Information Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>System Information</h3>
                  <div className={styles.dataTable}>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>App Version</span>
                      <span className={styles.dataValue}>{diagnostics.systemInfo.appVersion}</span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Platform</span>
                      <span className={styles.dataValue}>{diagnostics.systemInfo.platform}</span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Client ID</span>
                      <span className={`${styles.dataValue} ${styles.monospace}`}>
                        {diagnostics.systemInfo.clientId}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Electron Version</span>
                      <span className={styles.dataValue}>
                        {diagnostics.systemInfo.electronVersion}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Node Version</span>
                      <span className={styles.dataValue}>{diagnostics.systemInfo.nodeVersion}</span>
                    </div>
                  </div>
                </section>

                {/* Error Logs Section */}
                {diagnostics.errorLogs.length > 0 && (
                  <section className={styles.section}>
                    <h3 className={styles.sectionTitle}>Recent Errors</h3>
                    <div className={styles.errorList}>
                      {diagnostics.errorLogs.map((error, index) => (
                        <div key={index} className={styles.errorItem}>
                          <div className={styles.errorHeader}>
                            <span className={styles.errorLevel}>{error.level.toUpperCase()}</span>
                            <span className={styles.errorTime}>
                              {formatTimestamp(error.timestamp)}
                            </span>
                          </div>
                          <div className={styles.errorMessage}>{error.message}</div>
                          {error.context && (
                            <div className={styles.errorContext}>{error.context}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {/* Metadata Section */}
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Diagnostic Metadata</h3>
                  <div className={styles.dataTable}>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Generated At</span>
                      <span className={styles.dataValue}>
                        {formatTimestamp(diagnostics.metadata.generatedAt)}
                      </span>
                    </div>
                    <div className={styles.dataRow}>
                      <span className={styles.dataLabel}>Diagnostic Version</span>
                      <span className={styles.dataValue}>
                        {diagnostics.metadata.diagnosticVersion}
                      </span>
                    </div>
                  </div>
                </section>
              </div>
            )}
          </DialogContent>

          <DialogActions>
            <Button appearance="secondary" onClick={handleClose}>
              Close
            </Button>
            {diagnostics && (
              <Button appearance="primary" onClick={handleExport} disabled={exporting}>
                {exporting ? 'Exporting...' : 'Export to File'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
