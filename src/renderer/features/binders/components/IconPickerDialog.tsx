import {
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@fluentui/react-components';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { BINDER_ICONS } from '../../../shared/styles/tokens';

import styles from './IconPickerDialog.module.css';

type LucideIconProps = { size?: number; className?: string };

// Helper to render Lucide icon by name
const LucideIcon: React.FC<{ name: string; size?: number; className?: string }> = ({
  name,
  size = 20,
  className,
}) => {
  const [IconComponent, setIconComponent] =
    React.useState<React.ComponentType<LucideIconProps> | null>(null);

  React.useEffect(() => {
    let mounted = true;

    import('lucide-react').then((module) => {
      if (mounted) {
        const iconModule = module as unknown as Record<
          string,
          React.ComponentType<LucideIconProps>
        >;
        const Icon = iconModule[name];
        if (Icon) setIconComponent(() => Icon);
      }
    });

    return () => {
      mounted = false;
    };
  }, [name]);

  if (!IconComponent) return null;
  return <IconComponent size={size} className={className} />;
};

interface IconPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (iconName: string) => void;
}

export const IconPickerDialog: React.FC<IconPickerDialogProps> = ({ open, onClose, onSelect }) => {
  const { t } = useTranslation();

  const handleIconSelect = (iconName: string) => {
    onSelect(iconName);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(_, data) => !data.open && onClose()}>
      <DialogSurface className={styles['dialog-surface']}>
        <DialogBody>
          <DialogTitle className={styles['dialog-title']}>{t('binders.set_icon')}</DialogTitle>
          <DialogContent className={styles['dialog-content']}>
            {/* Icon Grid */}
            <div className={styles['icon-grid']}>
              {BINDER_ICONS.map((iconName) => (
                <button
                  key={iconName}
                  onClick={() => handleIconSelect(iconName)}
                  className={styles['icon-button']}
                  aria-label={iconName}
                  title={iconName}
                >
                  <LucideIcon name={iconName} size={20} />
                </button>
              ))}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose}>
              {t('common.close')}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
