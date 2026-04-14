import { Button, Dropdown, Field, Option, Spinner, Text } from '@fluentui/react-components';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { AVAILABLE_LOCALES, type AvailableLocale } from '../../../app/i18n';
import { useSettingsStore } from '../../../shared/state/settings.store';

import styles from './ProfileSettings.module.css';
import { SettingsCard, SettingsSection, SettingsTabLayout } from './SettingsTabLayout';

const LANGUAGE_KEY = 'app.locale';

// Map locale codes to translation keys
const LOCALE_LABEL_KEYS: Record<AvailableLocale, string> = {
  en: 'settings.profile.languages.english',
  de: 'settings.profile.languages.german',
  es: 'settings.profile.languages.spanish',
  fr: 'settings.profile.languages.french',
};

type ProfileResponse = {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
};

export const ProfileSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const localeFromStore = useSettingsStore((s) => s.values[LANGUAGE_KEY]);
  const setValue = useSettingsStore((s) => s.setValue);

  const [firstName, setFirstName] = React.useState('');
  const [lastName, setLastName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [locale, setLocale] = React.useState<AvailableLocale>(
    (localeFromStore as AvailableLocale) ?? (i18n.language as AvailableLocale) ?? 'en'
  );

  const [initialLoad, setInitialLoad] = React.useState(true);
  const [savingLanguage, setSavingLanguage] = React.useState(false);
  const [languageDirty, setLanguageDirty] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const loadProfile = React.useCallback(async () => {
    try {
      const profile: ProfileResponse | null = await window.api.user.getProfile();
      setFirstName(profile?.first_name ?? '');
      setLastName(profile?.last_name ?? '');
      setEmail(profile?.email ?? '');
    } catch (err) {
      console.error('Failed to load profile', err);
      setError(t('settings.profile.load_error'));
    } finally {
      setInitialLoad(false);
    }
  }, [t]);

  React.useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  React.useEffect(() => {
    const unsubscribe = window.api.onProfileChanged?.(() => {
      void loadProfile();
    });

    return () => {
      try {
        unsubscribe?.();
      } catch (err) {
        console.warn('Failed to unsubscribe from profile changes', err);
      }
    };
  }, [loadProfile]);

  React.useEffect(() => {
    const nextLocale =
      (localeFromStore as AvailableLocale) ?? (i18n.language as AvailableLocale) ?? 'en';
    setLocale(nextLocale);
  }, [localeFromStore, i18n.language]);

  const handleLanguageChange = React.useCallback(
    (newLocale: AvailableLocale) => {
      if (newLocale === locale) return;
      setSuccess(null);
      setError(null);
      setLanguageDirty(true);
      setLocale(newLocale);
    },
    [locale]
  );

  const handleSaveLanguage = React.useCallback(async () => {
    if (savingLanguage) return;
    setSavingLanguage(true);
    setError(null);
    setSuccess(null);

    try {
      await setValue(LANGUAGE_KEY, locale);
      await i18n.changeLanguage(locale);

      setSuccess(t('settings.profile.language_save_success'));
      setLanguageDirty(false);
    } catch (err) {
      console.error('Failed to save language preference', err);
      setError(t('settings.profile.language_save_error'));
    } finally {
      setSavingLanguage(false);
    }
  }, [i18n, locale, savingLanguage, setValue, t]);

  const selectedLanguageLabel = React.useMemo(() => {
    const labelKey = LOCALE_LABEL_KEYS[locale];
    return labelKey ? t(labelKey) : locale;
  }, [locale, t]);

  const showLanguageFooter = languageDirty || !!success || !!error;

  return (
    <SettingsTabLayout
      title={t('settings.profile.title')}
      description={t('settings.profile.description')}
    >
      <SettingsSection
        title={t('settings.profile.account_section_title')}
        description={t('settings.profile.account_section_description')}
      >
        <SettingsCard
          title={t('settings.profile.account_card_title')}
          description={t('settings.profile.account_card_description')}
        >
          {initialLoad ? (
            <div className={styles.spinnerRow}>
              <Spinner size="small" />
              <Text>{t('settings.profile.loading')}</Text>
            </div>
          ) : (
            <>
              <div className={styles.identityGrid}>
                <Field label={t('settings.profile.first_name')}>
                  <Text>{firstName || '—'}</Text>
                </Field>

                <Field label={t('settings.profile.last_name')}>
                  <Text>{lastName || '—'}</Text>
                </Field>

                <Field label={t('settings.profile.email')}>
                  <Text>{email || '—'}</Text>
                </Field>
              </div>

              <div className={styles.readOnlyNote}>
                <Text size={200}>{t('settings.profile.readonly_note')}</Text>
              </div>
            </>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.profile.preferences_heading')}
        description={t('settings.profile.preferences_description')}
      >
        <SettingsCard
          title={t('settings.profile.language_card_title')}
          description={t('settings.profile.language_card_description')}
          footer={
            showLanguageFooter ? (
              <div className={styles.languageFooter}>
                <div className={styles.footerActions}>
                  <Button
                    appearance="primary"
                    onClick={handleSaveLanguage}
                    disabled={savingLanguage}
                  >
                    {savingLanguage ? t('settings.profile.saving') : t('common.save')}
                  </Button>
                </div>
                <div className={styles.status}>
                  {success && <span className={styles.statusSuccess}>{success}</span>}
                  {!success && error && <span className={styles.statusError}>{error}</span>}
                </div>
              </div>
            ) : null
          }
        >
          <Field label={t('settings.profile.language')}>
            <Dropdown
              selectedOptions={[locale]}
              value={selectedLanguageLabel}
              disabled={savingLanguage}
              onOptionSelect={(_, data) => {
                if (typeof data.optionValue !== 'string') return;
                if (AVAILABLE_LOCALES.includes(data.optionValue as AvailableLocale)) {
                  handleLanguageChange(data.optionValue as AvailableLocale);
                }
              }}
            >
              {AVAILABLE_LOCALES.map((localeCode) => {
                const labelKey = LOCALE_LABEL_KEYS[localeCode];
                return (
                  <Option key={localeCode} value={localeCode} text={t(labelKey)}>
                    {t(labelKey)}
                  </Option>
                );
              })}
            </Dropdown>
          </Field>
        </SettingsCard>
      </SettingsSection>
    </SettingsTabLayout>
  );
};
