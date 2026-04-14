import { Button, Field, Textarea } from '@fluentui/react-components';
import * as React from 'react';

import styles from './LicenseKeyInput.module.css';

export interface LicenseKeyInputProps {
  value: string;
  onChange: (value: string) => void;
  onActivate?: (value: string) => void;
  onClear?: () => void;
  disabled?: boolean;
  activating?: boolean;
  helperText?: string;
  className?: string;
  onValidityChange?: (valid: boolean) => void;
}

const LICENSE_CHAR_PATTERN = /^[A-Za-z0-9+=/_-]+(?:\.[A-Za-z0-9+=/_-]+)*$/;

export const normalizeLicenseKey = (input: string): string => {
  if (!input) return '';
  const trimmed = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^-----BEGIN/i.test(line) &&
        !/^-----END/i.test(line) &&
        !line.startsWith('#')
    )
    .join('');
  return trimmed;
};

export const getLicenseValidationError = (value: string): string | null => {
  const compact = value.replace(/\s+/g, '');
  if (!compact) {
    return 'Enter your license key to continue.';
  }
  if (!LICENSE_CHAR_PATTERN.test(compact)) {
    return 'License key contains unsupported characters.';
  }
  if (compact.length < 48) {
    return 'License key looks incomplete.';
  }
  return null;
};

export const LicenseKeyInput: React.FC<LicenseKeyInputProps> = ({
  value,
  onChange,
  onActivate,
  onClear,
  disabled = false,
  activating = false,
  helperText = 'Paste the signed license token provided by Notely or your portal administrator.',
  className,
  onValidityChange,
}) => {
  const [dirty, setDirty] = React.useState(() => Boolean(value.trim()));
  const errorMessage = getLicenseValidationError(value);
  const isValid = !errorMessage;
  const showError = dirty && !!errorMessage;

  React.useEffect(() => {
    onValidityChange?.(isValid);
  }, [isValid, onValidityChange]);

  React.useEffect(() => {
    if (!value && dirty) {
      setDirty(false);
    }
  }, [dirty, value]);

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!dirty) {
      setDirty(true);
    }
    onChange(event.target.value);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (pasted) {
      event.preventDefault();
      const normalized = normalizeLicenseKey(pasted);
      setDirty(true);
      onChange(normalized);
    }
  };

  const handleClear = () => {
    setDirty(false);
    if (onClear) {
      onClear();
    } else {
      onChange('');
    }
  };

  const handleActivate = () => {
    if (onActivate && isValid && !activating) {
      onActivate(value.trim());
    }
  };

  const containerClassName = className ? `${styles.container} ${className}` : styles.container;

  return (
    <div className={containerClassName} data-testid="license-key-input">
      <Field
        label="Enter license key"
        validationState={showError ? 'error' : undefined}
        validationMessage={showError ? errorMessage : undefined}
        hint={helperText}
      >
        <Textarea
          value={value}
          onChange={handleChange}
          onPaste={handlePaste}
          className={styles.textarea}
          disabled={disabled || activating}
          resize="vertical"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </Field>
      <div className={styles.actions}>
        <Button
          appearance="primary"
          onClick={handleActivate}
          disabled={!isValid || disabled || activating || !value.trim()}
        >
          {activating ? 'Activating…' : 'Activate license'}
        </Button>
        <Button
          appearance="secondary"
          onClick={handleClear}
          disabled={disabled || (!value && !dirty)}
        >
          Clear
        </Button>
      </div>
    </div>
  );
};

LicenseKeyInput.displayName = 'LicenseKeyInput';
