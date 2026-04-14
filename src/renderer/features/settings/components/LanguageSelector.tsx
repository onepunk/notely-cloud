import { Dropdown, Option } from '@fluentui/react-components';
import * as React from 'react';

import { SUPPORTED_LANGUAGES } from '../../../shared/constants/languages';
import { useSettingsStore } from '../../../shared/state/settings.store';

import dropdownStyles from './Dropdown.module.css';

const KEY = 'transcription.language';

export const LanguageSelector: React.FC = () => {
  const values = useSettingsStore((s) => s.values);

  const current = values[KEY] || 'en';
  const onChange = async (_e: React.SyntheticEvent, data: { optionValue?: string }) => {
    try {
      await window.api.settings.set(KEY, data.optionValue || 'en');
    } catch (e) {
      // swallow for now
    }
  };

  return (
    <Dropdown
      selectedOptions={[current]}
      onOptionSelect={onChange}
      appearance="outline"
      className={dropdownStyles.dropdown}
    >
      {SUPPORTED_LANGUAGES.map((lang) => (
        <Option key={lang.code} value={lang.code} disabled={!lang.enabled}>
          {lang.name}
        </Option>
      ))}
    </Dropdown>
  );
};
