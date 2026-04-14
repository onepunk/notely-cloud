import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Label,
} from '@fluentui/react-components';
import type { InputOnChangeData } from '@fluentui/react-components';
import * as React from 'react';
import { HexColorPicker } from 'react-colorful';
import { useTranslation } from 'react-i18next';

import { BINDER_COLOR_PRESETS } from '../../../shared/styles/tokens';

import styles from './ColorPickerDialog.module.css';

type ColorPickerDialogProps = {
  open: boolean;
  initialColor?: string | null;
  onClose: () => void;
  onSelect: (hexColor: string) => void;
};

const normalizeHex = (value: string): string => {
  const hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) {
    return (
      '#' +
      hex
        .split('')
        .map((c) => c + c)
        .join('')
        .toUpperCase()
    );
  }

  if (hex.length === 6) {
    return `#${hex.toUpperCase()}`;
  }

  return '#000000';
};

const isValidHex = (value: string): boolean => /^#?[0-9A-Fa-f]{6}$/.test(value.trim());

export const ColorPickerDialog: React.FC<ColorPickerDialogProps> = ({
  open,
  initialColor,
  onClose,
  onSelect,
}) => {
  const { t } = useTranslation();
  const fallback = BINDER_COLOR_PRESETS[0] || '#E57373';
  const [currentColor, setCurrentColor] = React.useState<string>(initialColor || fallback);
  const [hexInput, setHexInput] = React.useState<string>(initialColor || fallback);

  React.useEffect(() => {
    if (open) {
      const base = initialColor && isValidHex(initialColor) ? normalizeHex(initialColor) : fallback;
      setCurrentColor(base);
      setHexInput(base);
    }
  }, [open, initialColor, fallback]);

  const handlePresetClick = React.useCallback((hex: string) => {
    setCurrentColor(hex);
    setHexInput(hex);
  }, []);

  const handleColorChange = React.useCallback((hex: string) => {
    const normalized = normalizeHex(hex);
    setCurrentColor(normalized);
    setHexInput(normalized);
  }, []);

  const handleHexInputChange = React.useCallback(
    (_: React.FormEvent<HTMLInputElement>, data: InputOnChangeData) => {
      const value = data.value;
      setHexInput(value);
      if (isValidHex(value)) {
        const normalized = normalizeHex(value);
        setCurrentColor(normalized);
      }
    },
    []
  );

  const handleSave = React.useCallback(() => {
    const normalized = normalizeHex(currentColor);
    onSelect(normalized);
    onClose();
  }, [currentColor, onClose, onSelect]);

  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!data.open) onClose();
      }}
    >
      <DialogSurface className={styles['dialog-surface']}>
        <DialogBody>
          <DialogTitle className={styles['dialog-title']}>
            {t('binders.set_colour')}
          </DialogTitle>
          <DialogContent className={styles['dialog-content']}>
            {/* Color Picker */}
            <div className={styles['picker-container']}>
              <HexColorPicker color={currentColor} onChange={handleColorChange} />
            </div>

            {/* Hex Input */}
            <div className={styles['hex-input-row']}>
              <Label htmlFor="hex-input">
                {t('binders.hex_code')}
              </Label>
              <Input
                id="hex-input"
                value={hexInput}
                onChange={handleHexInputChange}
                maxLength={7}
                appearance="outline"
                placeholder="#000000"
              />
            </div>

            {/* Preset Colors */}
            <div>
              <Label>{t('binders.quick_colours')}</Label>
              <div className={styles['color-presets']}>
                {BINDER_COLOR_PRESETS.map((preset) => {
                  const isActive = normalizeHex(preset) === normalizeHex(currentColor);
                  return (
                    <button
                      key={preset}
                      type="button"
                      className={`${styles['preset-button']} ${isActive ? styles['preset-active'] : ''}`}
                      style={{ background: preset }}
                      onClick={() => handlePresetClick(preset)}
                      aria-label={preset}
                    />
                  );
                })}
              </div>
            </div>
          </DialogContent>
          <DialogActions className={styles.actions}>
            <Button appearance="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button onClick={handleSave}>{t('common.save')}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
