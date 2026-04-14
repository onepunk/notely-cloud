/**
 * PasswordUnlockPopup - Password unlock window for password-protected databases
 *
 * Displayed at startup when the database is locked with a password.
 * Provides password entry, "remember for 7 days" option, and recovery key fallback.
 */

import * as React from 'react';

import { formatErrorForDisplay } from '@shared/error';

import styles from './PasswordUnlockPopup.module.css';

type UnlockMode = 'password' | 'recovery';

export function PasswordUnlockPopup(): JSX.Element {
  const [password, setPassword] = React.useState('');
  const [remember, setRemember] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [isBusy, setIsBusy] = React.useState(false);
  const [isUnlocking, setIsUnlocking] = React.useState(false); // Stays true after successful verification
  const [mode, setMode] = React.useState<UnlockMode>('password');
  const [recoveryKey, setRecoveryKey] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');

  const passwordInputRef = React.useRef<HTMLInputElement>(null);
  const recoveryInputRef = React.useRef<HTMLTextAreaElement>(null);

  // Focus input on mount
  React.useEffect(() => {
    if (mode === 'password') {
      passwordInputRef.current?.focus();
    } else {
      recoveryInputRef.current?.focus();
    }
  }, [mode]);

  const handleUnlock = React.useCallback(async () => {
    if (!window.api?.security) {
      setError('Security APIs unavailable');
      return;
    }

    if (!password.trim()) {
      setError('Please enter your password');
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      const result = await window.api.security.verifyPassword({
        password: password.trim(),
        remember,
      });

      if (!result.success) {
        // Use specific error code for incorrect password
        setError(
          result.error === 'Incorrect password'
            ? 'Incorrect password (E7001)'
            : formatErrorForDisplay(result.error, 'E7007')
        );
        setPassword('');
        setIsBusy(false);
        passwordInputRef.current?.focus();
      } else {
        // Password verified successfully - show unlocking state
        // Keep isBusy true and show the unlocking panel
        setIsUnlocking(true);
        // The main process will close this window after initialization completes
      }
    } catch (err) {
      setError(formatErrorForDisplay(err, 'E7007'));
      setIsBusy(false);
    }
  }, [password, remember]);

  const handleRecoveryReset = React.useCallback(async () => {
    if (!window.api?.security) {
      setError('Security APIs unavailable');
      return;
    }

    const trimmedKey = recoveryKey.replace(/\s/g, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/i.test(trimmedKey)) {
      setError('Invalid recovery key format. Expected 64 hexadecimal characters.');
      return;
    }

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setIsBusy(true);
    setError(null);

    try {
      const result = await window.api.security.resetPasswordWithRecoveryKey({
        recoveryKey: trimmedKey,
        newPassword,
        confirmPassword,
      });

      if (!result.success) {
        setError(formatErrorForDisplay(result.error, 'E7008'));
        setIsBusy(false);
      } else {
        // Recovery successful - show unlocking state
        setIsUnlocking(true);
        // The main process will close this window after initialization completes
      }
    } catch (err) {
      setError(formatErrorForDisplay(err, 'E7008'));
      setIsBusy(false);
    }
  }, [recoveryKey, newPassword, confirmPassword]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !isBusy) {
        if (mode === 'password') {
          void handleUnlock();
        } else {
          void handleRecoveryReset();
        }
      }
    },
    [mode, handleUnlock, handleRecoveryReset, isBusy]
  );

  const switchToRecovery = React.useCallback(() => {
    setMode('recovery');
    setError(null);
    setPassword('');
  }, []);

  const switchToPassword = React.useCallback(() => {
    setMode('password');
    setError(null);
    setRecoveryKey('');
    setNewPassword('');
    setConfirmPassword('');
  }, []);

  // Show unlocking panel after successful password verification
  if (isUnlocking) {
    return (
      <div className={styles.container} data-unlocking="true">
        <div className={styles.unlockingPanel}>
          <div className={styles.spinner} />
          <h2 className={styles.unlockingTitle}>Unlocking...</h2>
          <p className={styles.unlockingSubtitle}>Opening your encrypted notes</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container} data-busy={isBusy}>
      <header className={styles.header}>
        <h1 className={styles.title}>Notely is Locked</h1>
        <p className={styles.subtitle}>
          {mode === 'password'
            ? 'Enter your password to unlock your notes'
            : 'Reset your password using your recovery key'}
        </p>
      </header>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {mode === 'password' ? (
        <div className={styles.form}>
          <input
            ref={passwordInputRef}
            type="password"
            className={styles.input}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isBusy}
            autoComplete="current-password"
          />

          <button
            type="button"
            className={styles.unlockButton}
            onClick={() => void handleUnlock()}
            disabled={isBusy || !password.trim()}
          >
            {isBusy ? 'Unlocking...' : 'Unlock'}
          </button>

          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={isBusy}
            />
            <span>Remember for 7 days</span>
          </label>

          <button
            type="button"
            className={styles.linkButton}
            onClick={switchToRecovery}
            disabled={isBusy}
          >
            Forgot password? Use recovery key
          </button>
        </div>
      ) : (
        <div className={styles.form}>
          <textarea
            ref={recoveryInputRef}
            className={styles.recoveryInput}
            placeholder="Enter your 64-character recovery key"
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
            disabled={isBusy}
            spellCheck={false}
          />

          <input
            type="password"
            className={styles.input}
            placeholder="New password (min 8 characters)"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={isBusy}
            autoComplete="new-password"
          />

          <input
            type="password"
            className={styles.input}
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isBusy}
            autoComplete="new-password"
          />

          <button
            type="button"
            className={styles.unlockButton}
            onClick={() => void handleRecoveryReset()}
            disabled={isBusy || !recoveryKey.trim() || !newPassword || !confirmPassword}
          >
            {isBusy ? 'Resetting...' : 'Reset Password & Unlock'}
          </button>

          <button
            type="button"
            className={styles.linkButton}
            onClick={switchToPassword}
            disabled={isBusy}
          >
            Back to password unlock
          </button>
        </div>
      )}
    </div>
  );
}

export default PasswordUnlockPopup;
