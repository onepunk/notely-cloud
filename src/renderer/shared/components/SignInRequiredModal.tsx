import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from '@fluentui/react-components';
import { PersonLock24Regular } from '@fluentui/react-icons';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import styles from './SignInRequiredModal.module.css';

export interface SignInRequiredModalProps {
  /**
   * Whether the modal is open
   */
  open: boolean;

  /**
   * Callback when the modal is dismissed (Cancel button or backdrop click)
   */
  onDismiss: () => void;

  /**
   * Optional feature name to display in the message (e.g., "AI Summary")
   */
  feature?: string;
}

/**
 * Modal displayed when a user attempts to use a feature that requires authentication.
 *
 * Provides options to:
 * - Navigate to the Account settings to sign in
 * - Dismiss the modal and cancel the action
 *
 * @example
 * ```tsx
 * const [showModal, setShowModal] = React.useState(false);
 *
 * <SignInRequiredModal
 *   open={showModal}
 *   onDismiss={() => setShowModal(false)}
 *   feature="AI Summary"
 * />
 * ```
 */
export const SignInRequiredModal: React.FC<SignInRequiredModalProps> = ({
  open,
  onDismiss,
  feature,
}) => {
  const navigate = useNavigate();

  const handleSignIn = React.useCallback(() => {
    onDismiss();
    navigate('/settings/account');
  }, [navigate, onDismiss]);

  const featureMessage = feature
    ? `${feature} requires you to be signed in to your Notely account.`
    : 'This feature requires you to be signed in to your Notely account.';

  return (
    <Dialog
      open={open}
      modalType="modal"
      onOpenChange={(event, data) => {
        if (!data.open) {
          onDismiss();
        }
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <div className={styles.header}>
            <PersonLock24Regular className={styles.icon} />
            <DialogTitle>Sign In Required</DialogTitle>
          </div>
          <DialogContent className={styles.content}>
            <div className={styles.message}>
              <p>{featureMessage}</p>
              <p>Sign in to access all features and sync your data across devices.</p>
            </div>
          </DialogContent>
          <DialogActions className={styles.actions}>
            <Button appearance="secondary" onClick={onDismiss}>
              Cancel
            </Button>
            <Button appearance="primary" onClick={handleSignIn}>
              Sign In
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};

SignInRequiredModal.displayName = 'SignInRequiredModal';
