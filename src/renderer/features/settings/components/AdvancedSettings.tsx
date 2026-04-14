import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { LanguageSelector } from './LanguageSelector';
import { SettingsSection, SettingsTabLayout } from './SettingsTabLayout';

export const AdvancedSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <SettingsTabLayout
      title={t('common.advanced')}
      description={t('settings.advanced.description')}
    >
      <SettingsSection
        title={t('settings.transcription_language')}
        description={t('settings.advanced.language_description')}
      >
        <LanguageSelector />
      </SettingsSection>
    </SettingsTabLayout>
  );
};
