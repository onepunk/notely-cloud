import {
  Dialog,
  DialogSurface,
  DialogBody,
  DialogContent,
  Button,
} from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import { useSettingsStore } from '../../../shared/state/settings.store';
import { AboutSettings } from '../components/AboutSettings';
import { AccountSettings } from '../components/AccountSettings';
import { AdvancedSettings } from '../components/AdvancedSettings';
import { AudioSettings } from '../components/AudioSettings';
import { DebugSettings } from '../components/DebugSettings';
import { PreferencesSettings } from '../components/PreferencesSettings';
import { PremiumSettings } from '../components/PremiumSettings';
import { SecuritySettings } from '../components/SecuritySettings';
import { SettingsTemplate } from '../components/SettingsTemplate';

import styles from './SettingsModal.module.css';
import layoutStyles from './SystemSettingsLayout.module.css';

const NavItem: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({
  active,
  onClick,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`${layoutStyles.navItem} ${active ? layoutStyles.navItemActive : ''}`}
  >
    {children}
  </button>
);

type SettingsSection =
  | 'account'
  | 'preferences'
  | 'audio'
  | 'security'
  | 'premium'
  | 'advanced'
  | 'debug'
  | 'about'
  | 'template';

export const SettingsModal: React.FC = () => {
  const navigate = useNavigate();
  const { section } = useParams();
  const { t } = useTranslation();
  const close = () => navigate('/');
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const onRemoteChange = useSettingsStore((s) => s.onRemoteChange);

  const sections: Array<{ key: SettingsSection; label: string }> = React.useMemo(
    () => [
      { key: 'account', label: t('settings.tabs.account') },
      { key: 'preferences', label: t('settings.tabs.preferences') },
      { key: 'audio', label: t('settings.tabs.audio', { defaultValue: 'Audio' }) },
      { key: 'security', label: t('settings.tabs.security') },
      { key: 'premium', label: t('settings.tabs.premium') },
      { key: 'advanced', label: t('common.advanced') },
      // Developer tab hidden - re-enable manually if needed for debugging
      // { key: 'debug', label: t('settings.tabs.debug') },
      { key: 'about', label: t('common.about') },
      // Template tab hidden - used only for internal reference
      // { key: 'template', label: t('settings.template.tab_label', { defaultValue: 'Template' }) },
    ],
    [t]
  );

  const activeSection: SettingsSection = React.useMemo(() => {
    const candidate = (section as SettingsSection | undefined) ?? 'account';
    const isValid = sections.some((entry) => entry.key === candidate);
    return isValid ? candidate : 'account';
  }, [section, sections]);

  React.useEffect(() => {
    if (!hydrated) void hydrate();
    const subscribe =
      typeof window.api?.onSettingsChanged === 'function' ? window.api.onSettingsChanged : null;
    const off = subscribe ? subscribe((key, value) => onRemoteChange(key, value)) : () => {};
    return () => {
      try {
        off();
      } catch (error) {
        console.warn('Failed to unsubscribe from settings changes:', error);
      }
    };
  }, [hydrate, hydrated, onRemoteChange]);

  return (
    <Dialog
      open
      onOpenChange={(_, d) => {
        if (!d.open) close();
      }}
    >
      <DialogSurface className={styles['wide-dialog']}>
        <DialogBody className={styles['dialog-body']}>
          <Button
            appearance="transparent"
            size="small"
            className={styles['close-button']}
            onClick={close}
            aria-label="Close"
          >
            <Dismiss20Regular />
          </Button>
          {/* Title removed for cleaner modal appearance */}
          <DialogContent className={styles['content-area']}>
            <div className={layoutStyles.layout}>
              <nav className={layoutStyles.navBar}>
                {sections.map((entry) => (
                  <NavItem
                    key={entry.key}
                    active={activeSection === entry.key}
                    onClick={() => navigate(`/settings/${entry.key}`)}
                  >
                    {entry.label}
                  </NavItem>
                ))}
              </nav>
              <div className={layoutStyles['content-shell']}>
                <div className={layoutStyles['content-scroll']}>
                  {activeSection === 'account' && (
                    <div>
                      <AccountSettings />
                    </div>
                  )}
                  {activeSection === 'preferences' && (
                    <div>
                      <PreferencesSettings />
                    </div>
                  )}
                  {activeSection === 'audio' && (
                    <div>
                      <AudioSettings />
                    </div>
                  )}
                  {activeSection === 'security' && (
                    <div>
                      <SecuritySettings />
                    </div>
                  )}
                  {activeSection === 'premium' && (
                    <div>
                      <PremiumSettings />
                    </div>
                  )}
                  {activeSection === 'advanced' && (
                    <div>
                      <AdvancedSettings />
                    </div>
                  )}
                  {activeSection === 'debug' && (
                    <div>
                      <DebugSettings />
                    </div>
                  )}
                  {activeSection === 'about' && (
                    <div>
                      <AboutSettings />
                    </div>
                  )}
                  {activeSection === 'template' && (
                    <div>
                      <SettingsTemplate />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </DialogContent>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
};
