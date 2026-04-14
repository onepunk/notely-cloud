import { Button, Spinner, Text } from '@fluentui/react-components';
import {
  ArrowSync20Regular,
  ArrowUpload20Regular,
  Checkmark20Regular,
} from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import type { UpdateInfo } from '../../../../preload/index';
import { useIsAuthenticated } from '../../../shared/hooks/useAuthStore';

import styles from './AboutSettings.module.css';
import { SettingsSection, SettingsTabLayout } from './SettingsTabLayout';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'error';
type DiagnosticsStatus = 'idle' | 'uploading' | 'success' | 'error';

// Module-level flag: persists across component remounts, resets on app restart
let diagnosticsUploaded = false;

export const AboutSettings: React.FC = () => {
  const { t } = useTranslation();
  const isAuthenticated = useIsAuthenticated();
  const [appVersion, setAppVersion] = React.useState<string>(
    typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'
  );
  const [updateStatus, setUpdateStatus] = React.useState<UpdateStatus>('idle');
  const [updateInfo, setUpdateInfo] = React.useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = React.useState<string | null>(null);
  const [diagnosticsStatus, setDiagnosticsStatus] = React.useState<DiagnosticsStatus>(
    diagnosticsUploaded ? 'success' : 'idle'
  );
  const [diagnosticsError, setDiagnosticsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    // Fetch app version when component mounts
    const fetchVersion = async () => {
      try {
        if (typeof window.api?.getVersion === 'function') {
          console.log('About: Calling getVersion API');
          const version = await window.api.getVersion();
          console.log('About: Received version:', version);
          setAppVersion((prev) => version || prev);
        } else {
          console.warn('About: getVersion API not available');
          // Fallback to compile-time version if available
          setAppVersion((prev) =>
            typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : prev
          );
        }
      } catch (error) {
        console.warn('Failed to get app version:', error);
        // Preserve whatever version we have (likely compile-time)
      }
    };
    void fetchVersion();
  }, []);

  const handleCheckForUpdates = React.useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateError(null);
    setUpdateInfo(null);

    try {
      // Force a fresh check by passing true
      const result = await window.api?.update?.check?.(true);

      if (result?.success && result.data) {
        setUpdateInfo(result.data);
        if (result.data.updateAvailable) {
          setUpdateStatus('available');
        } else {
          setUpdateStatus('up-to-date');
        }
      } else {
        setUpdateStatus('error');
        setUpdateError(result?.error || t('about.update_check_failed'));
      }
    } catch (error) {
      setUpdateStatus('error');
      setUpdateError(error instanceof Error ? error.message : t('about.update_check_failed'));
    }
  }, [t]);

  const handleDownloadUpdate = React.useCallback(async () => {
    try {
      await window.api?.update?.openDownload?.();
    } catch (error) {
      console.error('Failed to open download:', error);
    }
  }, []);

  const handleUploadDiagnostics = React.useCallback(async () => {
    setDiagnosticsStatus('uploading');
    setDiagnosticsError(null);

    try {
      if (typeof window.api?.diagnostics?.upload !== 'function') {
        setDiagnosticsStatus('error');
        setDiagnosticsError('Diagnostics API not available. Restart the app and try again.');
        return;
      }

      const result = await window.api.diagnostics.upload();

      if (result?.success) {
        diagnosticsUploaded = true;
        setDiagnosticsStatus('success');
      } else {
        setDiagnosticsStatus('error');
        setDiagnosticsError(result?.error || t('about.diagnostics_export_failed'));
      }
    } catch (error) {
      setDiagnosticsStatus('error');
      setDiagnosticsError(error instanceof Error ? error.message : String(error));
    }
  }, [t]);

  return (
    <SettingsTabLayout title={t('common.about')} description={t('about.description')}>
      <SettingsSection
        title={t('about.overview_title')}
        description={t('about.overview_description')}
      >
        <div className={styles.infoStack}>
          <span className={styles.name}>{t('about.app_name')}</span>
          <span className={styles.meta}>{t('about.version', { version: appVersion })}</span>
          <span className={styles.meta}>{t('about.website')}</span>
        </div>
      </SettingsSection>

      <div className={styles.twoColGrid}>
        <SettingsSection
          title={t('about.updates_title')}
          description={t('about.updates_description')}
        >
          <div className={styles.updateSection}>
            <Button
              appearance="secondary"
              size="small"
              icon={updateStatus === 'checking' ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
              onClick={handleCheckForUpdates}
              disabled={updateStatus === 'checking'}
            >
              {updateStatus === 'checking'
                ? t('about.checking_updates')
                : t('about.check_for_updates')}
            </Button>

            {updateStatus === 'up-to-date' && (
              <div className={styles.updateResult}>
                <Checkmark20Regular className={styles.successIcon} />
                <Text size={200} className={styles.successText}>
                  {t('about.up_to_date')}
                </Text>
              </div>
            )}

            {updateStatus === 'available' && updateInfo && (
              <div className={styles.updateAvailable}>
                <Text size={200} weight="semibold">
                  {t('about.update_available', { version: updateInfo.latestVersion })}
                </Text>
                {updateInfo.releaseNotes && (
                  <Text size={200} className={styles.releaseNotes}>
                    {updateInfo.releaseNotes}
                  </Text>
                )}
                <Button appearance="primary" size="small" onClick={handleDownloadUpdate}>
                  {t('about.download_update')}
                </Button>
              </div>
            )}

            {updateStatus === 'error' && updateError && (
              <Text size={200} className={styles.errorText}>
                {updateError}
              </Text>
            )}
          </div>
        </SettingsSection>

        <SettingsSection
          title={t('about.diagnostics_title')}
          description={t('about.diagnostics_description')}
        >
          <div className={styles.updateSection}>
            <Button
              appearance="secondary"
              size="small"
              icon={
                diagnosticsStatus === 'uploading' ? (
                  <Spinner size="tiny" />
                ) : (
                  <ArrowUpload20Regular />
                )
              }
              onClick={handleUploadDiagnostics}
              disabled={
                !isAuthenticated ||
                diagnosticsStatus === 'uploading' ||
                diagnosticsStatus === 'success'
              }
            >
              {diagnosticsStatus === 'uploading'
                ? t('about.exporting_diagnostics')
                : diagnosticsStatus === 'success'
                  ? t('about.diagnostics_already_uploaded')
                  : t('about.export_diagnostics')}
            </Button>

            {!isAuthenticated && (
              <Text size={200} className={styles.hintText}>
                {t('about.diagnostics_sign_in_required')}
              </Text>
            )}

            {diagnosticsStatus === 'success' && (
              <div className={styles.updateResult}>
                <Checkmark20Regular className={styles.successIcon} />
                <Text size={200} className={styles.successText}>
                  {t('about.diagnostics_exported')}
                </Text>
              </div>
            )}

            {diagnosticsStatus === 'error' && diagnosticsError && (
              <Text size={200} className={styles.errorText}>
                {diagnosticsError}
              </Text>
            )}
          </div>
        </SettingsSection>
      </div>
    </SettingsTabLayout>
  );
};
