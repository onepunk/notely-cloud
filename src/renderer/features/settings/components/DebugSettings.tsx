import {
  Button,
  Caption1,
  Combobox,
  Checkbox,
  Input,
  Option,
  Spinner,
} from '@fluentui/react-components';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { useSettingsStore } from '../../../shared/state/settings.store';

import styles from './DebugSettings.module.css';
import dropdownStyles from './Dropdown.module.css';
import { SettingsSection, SettingsTabLayout } from './SettingsTabLayout';

// Default model that matches TRANSCRIPTION_CONFIG in config.ts
const DEFAULT_MODEL = 'small.en';

export const DebugSettings: React.FC = () => {
  const { t } = useTranslation();
  const values = useSettingsStore((s) => s.values);
  const setBoolean = useSettingsStore((s) => s.setBoolean);
  const setValue = useSettingsStore((s) => s.setValue);
  const [models, setModels] = React.useState<string[] | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [restarting, setRestarting] = React.useState(false);
  const [restartError, setRestartError] = React.useState<string | null>(null);

  // Use the stored model or fall back to the actual default that the Python engine uses
  const currentModel = values['transcription.model_name'] || DEFAULT_MODEL;
  const useGpu = values['transcription.use_gpu'] === 'true';
  const frameDurationMs = Number.parseInt(values['transcription.stream.frameDurationMs'] ?? '', 10);
  const initialBufferMs = Number.parseInt(values['transcription.stream.initialBufferMs'] ?? '', 10);
  const [frameDurationInput, setFrameDurationInput] = React.useState(
    Number.isFinite(frameDurationMs) ? String(frameDurationMs) : '200'
  );
  const [initialBufferInput, setInitialBufferInput] = React.useState(
    Number.isFinite(initialBufferMs)
      ? String(Math.max(initialBufferMs, frameDurationMs || 0))
      : '800'
  );

  React.useEffect(() => {
    setFrameDurationInput(Number.isFinite(frameDurationMs) ? String(frameDurationMs) : '200');
  }, [frameDurationMs]);

  React.useEffect(() => {
    const base = Number.isFinite(frameDurationMs) ? Math.max(frameDurationMs, 0) : 0;
    setInitialBufferInput(
      Number.isFinite(initialBufferMs) ? String(Math.max(initialBufferMs, base)) : '800'
    );
  }, [initialBufferMs, frameDurationMs]);

  React.useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await window.api?.transcription?.listModels?.();
        if (mounted) setModels(Array.isArray(list) ? list : []);
      } catch {
        if (mounted) setModels([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const onSelectModel = async (_: unknown, data: { optionValue?: string }) => {
    const next = data.optionValue || '';
    if (next === currentModel) return; // No change

    setSaving(true);
    setRestartError(null);

    try {
      // Save the setting
      await window.api.settings.set('transcription.model_name', next);

      // Automatically restart the transcription server to load the new model
      setRestarting(true);
      const result = await window.api.transcription.restartServer();

      if (!result.success) {
        setRestartError(result.message || 'Failed to restart transcription server');
      }
    } catch (error) {
      setRestartError(error instanceof Error ? error.message : 'Unknown error occurred');
    } finally {
      setSaving(false);
      setRestarting(false);
    }
  };

  const onToggleGpu = async (_: unknown, data: { checked: boolean }) => {
    await setBoolean('transcription.use_gpu', !!data.checked);
  };

  const clamp = (value: number, min: number, max: number): number => {
    if (Number.isNaN(value) || !Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  };

  const saveFrameDuration = async () => {
    const parsed = Number.parseInt(frameDurationInput, 10);
    const value = clamp(parsed, 80, 1000);
    setFrameDurationInput(String(value));
    await setValue('transcription.stream.frameDurationMs', String(value));
  };

  const saveInitialBuffer = async () => {
    const baseFrame = clamp(Number.parseInt(frameDurationInput, 10), 80, 1000);
    const parsed = Number.parseInt(initialBufferInput, 10);
    const value = clamp(parsed, baseFrame, 4000);
    setInitialBufferInput(String(value));
    await setValue('transcription.stream.initialBufferMs', String(value));
  };

  const layoutMeta =
    saving && !restarting ? (
      <Caption1 className={styles.saveIndicator}>{t('settings.debug.saving')}</Caption1>
    ) : null;

  return (
    <SettingsTabLayout
      title={t('settings.debug.title')}
      description={t('settings.debug.description')}
      meta={layoutMeta ?? undefined}
    >
      {/* Meeting Reminders Test */}
      <SettingsSection
        title={t('settings.debug.reminders')}
        description={t('settings.debug.reminders_desc')}
      >
        <Button
          size="small"
          appearance="secondary"
          onClick={() => {
            window.api?.meetingReminder?.testTrigger?.().catch(console.error);
          }}
        >
          {t('settings.debug.show_test_reminder')}
        </Button>
      </SettingsSection>

      {/* Whisper Model Selection */}
      <SettingsSection
        title={t('settings.debug.whisper_title')}
        description={t('settings.debug.whisper_description')}
      >
        {models === null ? (
          <div className={styles.spinnerRow}>
            <Spinner size="small" />
            <span>{t('settings.debug.models_loading')}</span>
          </div>
        ) : models.length === 0 ? (
          <div className={styles.noModels}>{t('settings.debug.no_models')}</div>
        ) : (
          <Combobox
            value={currentModel}
            onOptionSelect={onSelectModel}
            appearance="outline"
            className={dropdownStyles.dropdown}
          >
            {models.map((m) => (
              <Option key={m} text={m} value={m}>
                {m}
              </Option>
            ))}
          </Combobox>
        )}
        <div className={styles.modelStatus}>
          {restarting && (
            <div className={styles.statusLoading}>{t('settings.debug.model_restarting')}</div>
          )}
          {!restarting && !saving && !restartError && (
            <div className={styles.statusSuccess}>
              {t('settings.debug.model_loaded', { model: currentModel })}
            </div>
          )}
          {restartError && (
            <div className={styles.statusError}>
              {t('settings.debug.model_error', { message: restartError })}
            </div>
          )}
        </div>
      </SettingsSection>

      {/* Performance / GPU */}
      <SettingsSection
        title={t('settings.debug.performance_title')}
        description={t('settings.debug.performance_description')}
      >
        <div className={styles.checkboxGroup}>
          <Checkbox label={t('settings.debug.use_gpu')} checked={useGpu} onChange={onToggleGpu} />
          <span className={styles.hintText}>{t('settings.debug.gpu_hint')}</span>
        </div>
      </SettingsSection>

      {/* Live Transcription Tuning */}
      <SettingsSection
        title={t('settings.debug.tuning_title')}
        description={t('settings.debug.tuning_description')}
      >
        <div className={styles.inputStack}>
          <div className={styles.inputGroup}>
            <label className={styles.inputLabel}>{t('settings.debug.frame_duration')}</label>
            <Input
              type="number"
              min={80}
              max={1000}
              step={20}
              value={frameDurationInput}
              onChange={(event) => setFrameDurationInput(event.target.value)}
              onBlur={saveFrameDuration}
              appearance="outline"
              className={styles.inputField}
              contentAfter={<span className={styles.unit}>{t('settings.debug.ms')}</span>}
            />
            <div className={styles.inputDescription}>{t('settings.debug.frame_duration_hint')}</div>
          </div>
          <div className={styles.inputGroup}>
            <label className={styles.inputLabel}>{t('settings.debug.initial_buffer')}</label>
            <Input
              type="number"
              min={frameDurationInput ? Number.parseInt(frameDurationInput, 10) || 80 : 80}
              max={4000}
              step={50}
              value={initialBufferInput}
              onChange={(event) => setInitialBufferInput(event.target.value)}
              onBlur={saveInitialBuffer}
              appearance="outline"
              className={styles.inputField}
              contentAfter={<span className={styles.unit}>{t('settings.debug.ms')}</span>}
            />
            <div className={styles.inputDescription}>{t('settings.debug.initial_buffer_hint')}</div>
          </div>
        </div>
      </SettingsSection>
    </SettingsTabLayout>
  );
};
