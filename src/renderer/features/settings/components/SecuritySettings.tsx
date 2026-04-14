import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
} from '@fluentui/react-components';
import {
  Checkmark16Regular,
  Copy16Regular,
  Eye16Regular,
  EyeOff16Regular,
  Key16Regular,
  LockClosed16Regular,
  ShieldCheckmark16Regular,
  Warning16Regular,
} from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { formatErrorForDisplay } from '@shared/error';

import styles from './SecuritySettings.module.css';
import { SettingsCard, SettingsSection, SettingsTabLayout } from './SettingsTabLayout';

type PasswordStatus = {
  enabled: boolean;
  locked: boolean;
  rememberActive: boolean;
  rememberUntil: string | null;
  recoveryKeyShown: boolean;
  passwordChangedAt: string | null;
};

export const SecuritySettings: React.FC = () => {
  const { t } = useTranslation();
  const securityApi = React.useMemo(
    () => (typeof window !== 'undefined' ? window.api?.security : undefined),
    []
  );

  // Status state
  const [status, setStatus] = React.useState<PasswordStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Enable dialog state
  const [enableDialogOpen, setEnableDialogOpen] = React.useState(false);
  const [enablePassword, setEnablePassword] = React.useState('');
  const [enableConfirm, setEnableConfirm] = React.useState('');
  const [enableLoading, setEnableLoading] = React.useState(false);
  const [enableError, setEnableError] = React.useState<string | null>(null);
  const [showEnablePassword, setShowEnablePassword] = React.useState(false);

  // Disable dialog state
  const [disableDialogOpen, setDisableDialogOpen] = React.useState(false);
  const [disablePassword, setDisablePassword] = React.useState('');
  const [disableLoading, setDisableLoading] = React.useState(false);
  const [disableError, setDisableError] = React.useState<string | null>(null);
  const [showDisablePassword, setShowDisablePassword] = React.useState(false);

  // Change password dialog state
  const [changeDialogOpen, setChangeDialogOpen] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [changeLoading, setChangeLoading] = React.useState(false);
  const [changeError, setChangeError] = React.useState<string | null>(null);
  const [showChangePasswords, setShowChangePasswords] = React.useState(false);

  // Recovery key dialog state
  const [recoveryDialogOpen, setRecoveryDialogOpen] = React.useState(false);
  const [recoveryKey, setRecoveryKey] = React.useState<string | null>(null);
  const [recoveryLoading, setRecoveryLoading] = React.useState(false);
  const [recoveryCopied, setRecoveryCopied] = React.useState(false);
  const [showRecoveryKey, setShowRecoveryKey] = React.useState(false);

  // Load status
  const loadStatus = React.useCallback(async () => {
    if (!securityApi?.getPasswordStatus) {
      setLoading(false);
      return;
    }
    try {
      setError(null);
      const result = await securityApi.getPasswordStatus();
      setStatus(result);
    } catch (err) {
      setError(formatErrorForDisplay(err, 'E7009'));
    } finally {
      setLoading(false);
    }
  }, [securityApi]);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Subscribe to status changes
  React.useEffect(() => {
    if (!securityApi?.onStatusChanged) return;
    const unsubscribe = securityApi.onStatusChanged((newStatus) => {
      setStatus(newStatus);
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
    };
  }, [securityApi]);

  // Enable password protection
  const handleEnablePassword = async () => {
    if (!securityApi?.enablePassword) return;
    if (enablePassword.length < 8) {
      setEnableError(t('settings.security.password_min_length'));
      return;
    }
    if (enablePassword !== enableConfirm) {
      setEnableError(t('settings.security.passwords_do_not_match'));
      return;
    }

    setEnableLoading(true);
    setEnableError(null);
    try {
      const result = await securityApi.enablePassword({
        password: enablePassword,
        confirmPassword: enableConfirm,
      });
      if (result.success) {
        setEnableDialogOpen(false);
        setEnablePassword('');
        setEnableConfirm('');
        // Show recovery key after enabling
        setRecoveryDialogOpen(true);
        void loadRecoveryKey();
      } else {
        setEnableError(result.error || t('settings.security.failed_to_enable_password'));
      }
    } catch (err) {
      setEnableError(
        err instanceof Error ? err.message : t('settings.security.failed_to_enable_password')
      );
    } finally {
      setEnableLoading(false);
    }
  };

  // Disable password protection
  const handleDisablePassword = async () => {
    if (!securityApi?.disablePassword) return;

    setDisableLoading(true);
    setDisableError(null);
    try {
      const result = await securityApi.disablePassword({
        password: disablePassword,
      });
      if (result.success) {
        setDisableDialogOpen(false);
        setDisablePassword('');
      } else {
        setDisableError(result.error || t('settings.security.incorrect_password'));
      }
    } catch (err) {
      setDisableError(
        err instanceof Error ? err.message : t('settings.security.failed_to_disable_password')
      );
    } finally {
      setDisableLoading(false);
    }
  };

  // Change password
  const handleChangePassword = async () => {
    if (!securityApi?.changePassword) return;
    if (newPassword.length < 8) {
      setChangeError(t('settings.security.password_min_length'));
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangeError(t('settings.security.passwords_do_not_match'));
      return;
    }

    setChangeLoading(true);
    setChangeError(null);
    try {
      const result = await securityApi.changePassword({
        currentPassword,
        newPassword,
        confirmPassword,
      });
      if (result.success) {
        setChangeDialogOpen(false);
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } else {
        setChangeError(result.error || t('settings.security.failed_to_change_password'));
      }
    } catch (err) {
      setChangeError(
        err instanceof Error ? err.message : t('settings.security.failed_to_change_password')
      );
    } finally {
      setChangeLoading(false);
    }
  };

  // Load recovery key
  const loadRecoveryKey = async () => {
    if (!securityApi?.exportRecoveryKey) return;
    setRecoveryLoading(true);
    try {
      const key = await securityApi.exportRecoveryKey();
      setRecoveryKey(key);
      // Mark as shown
      await securityApi.markRecoveryKeyShown?.();
    } catch (err) {
      setRecoveryKey(null);
    } finally {
      setRecoveryLoading(false);
    }
  };

  // Copy recovery key
  const handleCopyRecoveryKey = async () => {
    if (!recoveryKey) return;
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setRecoveryCopied(true);
      setTimeout(() => setRecoveryCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  // Clear remember password
  const handleClearRemember = async () => {
    if (!securityApi?.clearRemember) return;
    try {
      await securityApi.clearRemember();
      void loadStatus();
    } catch {
      /* ignore */
    }
  };

  const isEnabled = status?.enabled === true;

  if (loading) {
    return (
      <SettingsTabLayout
        title={t('settings.security.title')}
        description={t('settings.security.description')}
      >
        <div className={styles.loadingContainer}>
          <Spinner size="medium" />
          <Text>{t('settings.security.loading')}</Text>
        </div>
      </SettingsTabLayout>
    );
  }

  if (error) {
    return (
      <SettingsTabLayout
        title={t('settings.security.title')}
        description={t('settings.security.description')}
      >
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      </SettingsTabLayout>
    );
  }

  return (
    <SettingsTabLayout
      title={t('settings.security.title')}
      description={t('settings.security.description')}
    >
      {/* Password Protection Status */}
      <SettingsSection
        title={t('settings.security.password_protection')}
        description={t('settings.security.password_protection_desc')}
      >
        <SettingsCard
          title={
            isEnabled
              ? t('settings.security.password_enabled')
              : t('settings.security.password_disabled')
          }
          description={
            isEnabled
              ? t('settings.security.password_protected_hint')
              : t('settings.security.auto_unlock_hint')
          }
        >
          <div className={styles.statusRow}>
            <div className={styles.statusIcon}>
              {isEnabled ? (
                <LockClosed16Regular className={styles.enabledIcon} />
              ) : (
                <ShieldCheckmark16Regular className={styles.disabledIcon} />
              )}
            </div>
            <div className={styles.statusActions}>
              {isEnabled ? (
                <>
                  <Button
                    size="small"
                    appearance="secondary"
                    onClick={() => setChangeDialogOpen(true)}
                  >
                    {t('settings.security.change_password')}
                  </Button>
                  <Button
                    size="small"
                    appearance="secondary"
                    onClick={() => setDisableDialogOpen(true)}
                  >
                    {t('settings.security.disable')}
                  </Button>
                </>
              ) : (
                <Button size="small" appearance="primary" onClick={() => setEnableDialogOpen(true)}>
                  {t('settings.security.enable_password')}
                </Button>
              )}
            </div>
          </div>

          {isEnabled && status?.passwordChangedAt && (
            <Text size={200} className={styles.metaText}>
              {t('settings.security.password_last_changed', {
                date: new Date(status.passwordChangedAt).toLocaleDateString(),
              })}
            </Text>
          )}
        </SettingsCard>
      </SettingsSection>

      {/* Remember Password (only when enabled) */}
      {isEnabled && (
        <SettingsSection
          title={t('settings.security.remember_password')}
          description={t('settings.security.remember_password_desc')}
        >
          <div className={styles.rememberRow}>
            <div className={styles.rememberInfo}>
              {status?.rememberActive ? (
                <>
                  <Checkmark16Regular className={styles.enabledIcon} />
                  <Text>
                    {t('settings.security.remembered_until', {
                      date: status.rememberUntil
                        ? new Date(status.rememberUntil).toLocaleDateString()
                        : t('settings.security.unknown'),
                    })}
                  </Text>
                </>
              ) : (
                <Text size={200}>{t('settings.security.remember_hint')}</Text>
              )}
            </div>
            {status?.rememberActive && (
              <Button
                size="small"
                appearance="secondary"
                onClick={() => void handleClearRemember()}
              >
                {t('settings.security.forget')}
              </Button>
            )}
          </div>
        </SettingsSection>
      )}

      {/* Recovery Key */}
      <SettingsSection
        title={t('settings.security.recovery_key')}
        description={t('settings.security.recovery_key_desc')}
      >
        <SettingsCard
          title={t('settings.security.export_recovery_key')}
          description={t('settings.security.recovery_key_warning')}
          tone={!status?.recoveryKeyShown && isEnabled ? 'danger' : 'default'}
        >
          {!status?.recoveryKeyShown && isEnabled && (
            <MessageBar intent="warning" className={styles.warningBar}>
              <MessageBarBody>
                <Warning16Regular /> {t('settings.security.recovery_key_not_saved')}
              </MessageBarBody>
            </MessageBar>
          )}
          <div className={styles.recoveryActions}>
            <Button
              size="small"
              appearance="secondary"
              icon={<Key16Regular />}
              onClick={() => {
                setRecoveryDialogOpen(true);
                void loadRecoveryKey();
              }}
            >
              {t('settings.security.view_recovery_key')}
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>

      {/* Enable Password Dialog */}
      <Dialog open={enableDialogOpen} onOpenChange={(_, d) => setEnableDialogOpen(d.open)}>
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle className={styles.dialogTitle}>
              {t('settings.security.enable_password')}
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Text>{t('settings.security.enable_password_desc')}</Text>
              <Field label={t('settings.security.password')} required>
                <Input
                  type={showEnablePassword ? 'text' : 'password'}
                  value={enablePassword}
                  onChange={(_, d) => setEnablePassword(d.value)}
                  contentAfter={
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={showEnablePassword ? <EyeOff16Regular /> : <Eye16Regular />}
                      onClick={() => setShowEnablePassword(!showEnablePassword)}
                    />
                  }
                />
              </Field>
              <Field label={t('settings.security.confirm_password')} required>
                <Input
                  type={showEnablePassword ? 'text' : 'password'}
                  value={enableConfirm}
                  onChange={(_, d) => setEnableConfirm(d.value)}
                />
              </Field>
              {enableError && (
                <MessageBar intent="error">
                  <MessageBarBody>{enableError}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary" disabled={enableLoading}>
                  {t('settings.security.cancel')}
                </Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                onClick={() => void handleEnablePassword()}
                disabled={enableLoading || !enablePassword || !enableConfirm}
              >
                {enableLoading ? <Spinner size="tiny" /> : t('settings.security.enable')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Disable Password Dialog */}
      <Dialog open={disableDialogOpen} onOpenChange={(_, d) => setDisableDialogOpen(d.open)}>
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle className={styles.dialogTitle}>
              {t('settings.security.disable_password_protection')}
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Text>{t('settings.security.disable_password_desc')}</Text>
              <Field label={t('settings.security.current_password')} required>
                <Input
                  type={showDisablePassword ? 'text' : 'password'}
                  value={disablePassword}
                  onChange={(_, d) => setDisablePassword(d.value)}
                  contentAfter={
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={showDisablePassword ? <EyeOff16Regular /> : <Eye16Regular />}
                      onClick={() => setShowDisablePassword(!showDisablePassword)}
                    />
                  }
                />
              </Field>
              {disableError && (
                <MessageBar intent="error">
                  <MessageBarBody>{disableError}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary" disabled={disableLoading}>
                  {t('settings.security.cancel')}
                </Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                onClick={() => void handleDisablePassword()}
                disabled={disableLoading || !disablePassword}
              >
                {disableLoading ? <Spinner size="tiny" /> : t('settings.security.disable')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Change Password Dialog */}
      <Dialog open={changeDialogOpen} onOpenChange={(_, d) => setChangeDialogOpen(d.open)}>
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle className={styles.dialogTitle}>
              {t('settings.security.change_password')}
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <Field label={t('settings.security.current_password')} required>
                <Input
                  type={showChangePasswords ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(_, d) => setCurrentPassword(d.value)}
                  contentAfter={
                    <Button
                      appearance="transparent"
                      size="small"
                      icon={showChangePasswords ? <EyeOff16Regular /> : <Eye16Regular />}
                      onClick={() => setShowChangePasswords(!showChangePasswords)}
                    />
                  }
                />
              </Field>
              <Field label={t('settings.security.new_password')} required>
                <Input
                  type={showChangePasswords ? 'text' : 'password'}
                  value={newPassword}
                  onChange={(_, d) => setNewPassword(d.value)}
                />
              </Field>
              <Field label={t('settings.security.confirm_new_password')} required>
                <Input
                  type={showChangePasswords ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(_, d) => setConfirmPassword(d.value)}
                />
              </Field>
              {changeError && (
                <MessageBar intent="error">
                  <MessageBarBody>{changeError}</MessageBarBody>
                </MessageBar>
              )}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary" disabled={changeLoading}>
                  {t('settings.security.cancel')}
                </Button>
              </DialogTrigger>
              <Button
                appearance="primary"
                onClick={() => void handleChangePassword()}
                disabled={changeLoading || !currentPassword || !newPassword || !confirmPassword}
              >
                {changeLoading ? <Spinner size="tiny" /> : t('settings.security.change_password')}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      {/* Recovery Key Dialog */}
      <Dialog open={recoveryDialogOpen} onOpenChange={(_, d) => setRecoveryDialogOpen(d.open)}>
        <DialogSurface className={styles.dialogSurface}>
          <DialogBody>
            <DialogTitle className={styles.dialogTitle}>
              {t('settings.security.recovery_key')}
            </DialogTitle>
            <DialogContent className={styles.dialogContent}>
              <MessageBar intent="warning">
                <MessageBarBody>
                  {t('settings.security.recovery_key_dialog_warning')}
                </MessageBarBody>
              </MessageBar>
              {recoveryLoading ? (
                <div className={styles.recoveryLoading}>
                  <Spinner size="small" />
                  <Text>{t('settings.security.loading_recovery_key')}</Text>
                </div>
              ) : recoveryKey ? (
                <div className={styles.recoveryKeyBox}>
                  <code className={styles.recoveryKeyText}>
                    {showRecoveryKey ? recoveryKey : '••••••••••••••••••••••••••••••••'}
                  </code>
                  <div className={styles.recoveryKeyActions}>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={showRecoveryKey ? <EyeOff16Regular /> : <Eye16Regular />}
                      onClick={() => setShowRecoveryKey(!showRecoveryKey)}
                    >
                      {showRecoveryKey ? t('settings.security.hide') : t('settings.security.show')}
                    </Button>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={recoveryCopied ? <Checkmark16Regular /> : <Copy16Regular />}
                      onClick={() => void handleCopyRecoveryKey()}
                    >
                      {recoveryCopied ? t('settings.security.copied') : t('settings.security.copy')}
                    </Button>
                  </div>
                </div>
              ) : (
                <MessageBar intent="error">
                  <MessageBarBody>{t('settings.security.recovery_key_load_failed')}</MessageBarBody>
                </MessageBar>
              )}
              <Text size={200}>{t('settings.security.recovery_key_storage_hint')}</Text>
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="primary">{t('settings.security.done')}</Button>
              </DialogTrigger>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </SettingsTabLayout>
  );
};
