import {
  Button,
  Dropdown,
  Option,
  Spinner,
  Switch,
  Text,
  Tooltip,
} from '@fluentui/react-components';
import { ArrowClockwise16Regular, ShieldCheckmarkRegular } from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { useSettingsStore } from '../../../shared/state/settings.store';

import dropdownStyles from './Dropdown.module.css';
import styles from './PreferencesSettings.module.css';
import { SettingsInlineActions, SettingsSection, SettingsTabLayout } from './SettingsTabLayout';

type AudioDevice = {
  id: string;
  label: string;
};

type CalendarStatus = {
  connected: boolean;
  syncStatus?: string | null;
  lastSyncTime?: string | null;
  errorMessage?: string | null;
};

const MICROPHONE_KEY = 'system.audio.inputDeviceId';
const OUTPUT_DEVICE_KEY = 'system.audio.outputDeviceId';
const NOISE_SUPPRESSION_KEY = 'system.audio.noiseSuppression';
const ECHO_CANCELLATION_KEY = 'system.audio.echoCancellation';
const SYSTEM_AUDIO_KEY = 'system.audio.captureSystemAudio';
const THEME_KEY = 'system.theme';

const DEFAULT_THEME = 'system';

const canEnumerateDevices = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.enumerateDevices === 'function';

export const PreferencesSettings: React.FC = () => {
  const { t } = useTranslation();
  const values = useSettingsStore((s) => s.values);
  const setValue = useSettingsStore((s) => s.setValue);
  const setBoolean = useSettingsStore((s) => s.setBoolean);

  const THEME_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'system', label: t('settings.system.theme_option.system') },
    { value: 'light', label: t('settings.system.theme_option.light') },
    { value: 'dark', label: t('settings.system.theme_option.dark') },
  ];

  // Calendar state
  const calendarApi = React.useMemo(
    () => (typeof window !== 'undefined' ? window.api?.calendar : undefined),
    []
  );
  const [calendarStatus, setCalendarStatus] = React.useState<CalendarStatus | null>(null);
  const [calendarLoading, setCalendarLoading] = React.useState<boolean>(
    () => !!calendarApi?.getStatus
  );
  const [calendarConnecting, setCalendarConnecting] = React.useState(false);
  const [calendarDisconnecting, setCalendarDisconnecting] = React.useState(false);
  const [calendarError, setCalendarError] = React.useState<string | null>(null);

  // Audio state
  const [devices, setDevices] = React.useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = React.useState<AudioDevice[]>([]);
  const selectedDeviceFromStore = values[MICROPHONE_KEY] || '';
  const selectedOutputDeviceFromStore = values[OUTPUT_DEVICE_KEY] || '';
  const noiseSuppressionFromStore = values[NOISE_SUPPRESSION_KEY] !== 'false';
  const echoCancellationFromStore = values[ECHO_CANCELLATION_KEY] !== 'false';
  const systemAudioFromStore = values[SYSTEM_AUDIO_KEY] === 'true';

  const [deviceSelection, setDeviceSelection] = React.useState(selectedDeviceFromStore);
  const [outputDeviceSelection, setOutputDeviceSelection] = React.useState(
    selectedOutputDeviceFromStore
  );
  const [noiseSuppression, setNoiseSuppression] = React.useState(noiseSuppressionFromStore);
  const [echoCancellation, setEchoCancellation] = React.useState(echoCancellationFromStore);
  const [captureSystemAudio, setCaptureSystemAudio] = React.useState(systemAudioFromStore);
  const [systemAudioSupported, setSystemAudioSupported] = React.useState(false);
  const [enumerating, setEnumerating] = React.useState(false);
  const [deviceError, setDeviceError] = React.useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = React.useState(false);

  // Theme state
  const themeFromStore = values[THEME_KEY] ?? DEFAULT_THEME;
  const [themeSelection, setThemeSelection] = React.useState(themeFromStore);

  // Microphone test state
  const [testStatus, setTestStatus] = React.useState<'idle' | 'recording' | 'playing' | 'error'>(
    'idle'
  );
  const [testLevel, setTestLevel] = React.useState(0);
  const testRefs = React.useRef<{
    stream: MediaStream | null;
    recorder: MediaRecorder | null;
    audioCtx: AudioContext | null;
    analyser: AnalyserNode | null;
    animation: number | null;
    playbackUrl: string | null;
    audio: HTMLAudioElement | null;
    timeout: number | null;
  }>({
    stream: null,
    recorder: null,
    audioCtx: null,
    analyser: null,
    animation: null,
    playbackUrl: null,
    audio: null,
    timeout: null,
  });
  const testStatusRef = React.useRef(testStatus);

  // Save state
  const [saving, setSaving] = React.useState(false);
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  const isDirty =
    deviceSelection !== selectedDeviceFromStore ||
    outputDeviceSelection !== selectedOutputDeviceFromStore ||
    noiseSuppression !== noiseSuppressionFromStore ||
    echoCancellation !== echoCancellationFromStore ||
    captureSystemAudio !== systemAudioFromStore ||
    themeSelection !== themeFromStore;

  // Sync refs
  React.useEffect(() => {
    testStatusRef.current = testStatus;
  }, [testStatus]);

  // Check if system audio capture is supported on this platform
  // Also enable by default if supported and not yet set
  React.useEffect(() => {
    const checkSystemAudioSupport = async () => {
      try {
        const supported = await window.api.systemAudio.isSupported();
        setSystemAudioSupported(supported);

        // Enable by default if supported and user hasn't explicitly set a value
        if (supported && values[SYSTEM_AUDIO_KEY] === undefined) {
          setCaptureSystemAudio(true);
          // Auto-save the default
          void setBoolean(SYSTEM_AUDIO_KEY, true);
        }
      } catch (error) {
        console.warn('Failed to check system audio support:', error);
        setSystemAudioSupported(false);
      }
    };
    checkSystemAudioSupport();
  }, [setBoolean, values]);

  // Sync store values
  React.useEffect(() => {
    if (!isDirty) {
      setDeviceSelection(selectedDeviceFromStore);
      setOutputDeviceSelection(selectedOutputDeviceFromStore);
      setThemeSelection(themeFromStore);
      setNoiseSuppression(noiseSuppressionFromStore);
      setEchoCancellation(echoCancellationFromStore);
      setCaptureSystemAudio(systemAudioFromStore);
    }
  }, [
    echoCancellationFromStore,
    isDirty,
    noiseSuppressionFromStore,
    selectedDeviceFromStore,
    selectedOutputDeviceFromStore,
    systemAudioFromStore,
    themeFromStore,
  ]);

  // Device enumeration
  const mapInputDevices = React.useCallback((list: MediaDeviceInfo[]): AudioDevice[] => {
    let unnamedCount = 1;
    return list
      .filter((device) => device.kind === 'audioinput')
      .map((device) => {
        let label = device.label?.trim();
        if (!label) {
          label = `Microphone ${unnamedCount}`;
          unnamedCount += 1;
        }
        return { id: device.deviceId, label };
      });
  }, []);

  const mapOutputDevices = React.useCallback((list: MediaDeviceInfo[]): AudioDevice[] => {
    let unnamedCount = 1;
    return list
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => {
        let label = device.label?.trim();
        if (!label) {
          label = `Speaker ${unnamedCount}`;
          unnamedCount += 1;
        }
        return { id: device.deviceId, label };
      });
  }, []);

  const enumerate = React.useCallback(async () => {
    if (!canEnumerateDevices()) {
      setDeviceError(t('settings.system.microphone_not_supported'));
      return;
    }
    try {
      setEnumerating(true);
      setDeviceError(null);
      const deviceInfos = await navigator.mediaDevices.enumerateDevices();
      const mappedInput = mapInputDevices(deviceInfos);
      const mappedOutput = mapOutputDevices(deviceInfos);
      setDevices(mappedInput);
      setOutputDevices(mappedOutput);
      const hasLabels = mappedInput.some((d) => d.label && !d.label.startsWith('Microphone '));
      setNeedsPermission(!hasLabels);
    } catch (err) {
      console.error('Failed to enumerate devices', err);
      setDeviceError(t('settings.system.microphone_error'));
    } finally {
      setEnumerating(false);
    }
  }, [mapInputDevices, mapOutputDevices, t]);

  const requestPermission = React.useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setDeviceError(t('settings.system.microphone_permission_error'));
      return;
    }
    try {
      setEnumerating(true);
      setDeviceError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await enumerate();
    } catch {
      setDeviceError(t('settings.system.microphone_permission_denied'));
    } finally {
      setEnumerating(false);
    }
  }, [enumerate, t]);

  React.useEffect(() => {
    void enumerate();
  }, [enumerate]);

  React.useEffect(() => {
    if (!canEnumerateDevices()) return;
    const handler = () => void enumerate();
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
  }, [enumerate]);

  // Calendar functions
  const loadCalendarStatus = React.useCallback(async () => {
    if (!calendarApi?.getStatus) {
      setCalendarLoading(false);
      return;
    }
    try {
      setCalendarLoading(true);
      setCalendarError(null);
      const status = await calendarApi.getStatus();
      setCalendarStatus(status);
    } catch (error) {
      setCalendarError(error instanceof Error ? error.message : 'Failed to load calendar status.');
    } finally {
      setCalendarLoading(false);
    }
  }, [calendarApi]);

  const handleCalendarConnect = React.useCallback(async () => {
    if (!calendarApi?.startConnect) return;
    setCalendarError(null);
    try {
      setCalendarConnecting(true);
      const started = await calendarApi.startConnect();
      if (!started) {
        setCalendarConnecting(false);
        setCalendarError('Unable to open calendar connection.');
      }
    } catch (error) {
      setCalendarConnecting(false);
      setCalendarError(error instanceof Error ? error.message : 'Connection failed.');
    }
  }, [calendarApi]);

  const handleCalendarDisconnect = React.useCallback(async () => {
    if (!calendarApi?.disconnect) return;
    setCalendarError(null);
    setCalendarDisconnecting(true);
    try {
      await calendarApi.disconnect();
      await loadCalendarStatus();
    } catch (error) {
      setCalendarError(error instanceof Error ? error.message : 'Disconnect failed.');
    } finally {
      setCalendarDisconnecting(false);
    }
  }, [calendarApi, loadCalendarStatus]);

  React.useEffect(() => {
    if (calendarApi?.getStatus) void loadCalendarStatus();
  }, [calendarApi, loadCalendarStatus]);

  React.useEffect(() => {
    if (!calendarApi?.onConnectResult) return;
    const unsubscribe = calendarApi.onConnectResult((result) => {
      setCalendarConnecting(false);
      if (result.success) {
        setCalendarError(null);
        loadCalendarStatus();
      } else if (result.error) {
        setCalendarError(result.error);
      }
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
    };
  }, [calendarApi, loadCalendarStatus]);

  // Microphone test
  const releaseTestResources = React.useCallback(() => {
    const refs = testRefs.current;
    if (refs.timeout) clearTimeout(refs.timeout);
    if (refs.animation !== null) cancelAnimationFrame(refs.animation);
    if (refs.recorder?.state !== 'inactive')
      try {
        refs.recorder?.stop();
      } catch {
        /* ignore */
      }
    refs.stream?.getTracks().forEach((t) => t.stop());
    refs.audioCtx?.close().catch(() => {});
    refs.audio?.pause();
    if (refs.playbackUrl) URL.revokeObjectURL(refs.playbackUrl);
    Object.assign(refs, {
      stream: null,
      recorder: null,
      audioCtx: null,
      analyser: null,
      animation: null,
      playbackUrl: null,
      audio: null,
      timeout: null,
    });
  }, []);

  React.useEffect(() => () => releaseTestResources(), [releaseTestResources]);

  const handleTestMicrophone = React.useCallback(async () => {
    if (testStatusRef.current !== 'idle') return;
    releaseTestResources();

    try {
      setTestStatus('recording');
      testStatusRef.current = 'recording';
      setTestLevel(0);

      const constraints = deviceSelection
        ? { audio: { deviceId: { exact: deviceSelection } } }
        : { audio: true };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      testRefs.current.stream = stream;

      const audioCtx = new AudioContext();
      testRefs.current.audioCtx = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      testRefs.current.analyser = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        if (!testRefs.current.analyser) return;
        analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const value = (dataArray[i] - 128) / 128;
          sum += value * value;
        }
        setTestLevel(Math.min(1, Math.sqrt(sum / dataArray.length) * 3));
        if (testStatusRef.current === 'recording') {
          testRefs.current.animation = requestAnimationFrame(updateLevel);
        }
      };
      updateLevel();

      const recorder = new MediaRecorder(stream);
      testRefs.current.recorder = recorder;
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        releaseTestResources();
        setTestLevel(0);

        if (chunks.length === 0) {
          setTestStatus('error');
          return;
        }

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        testRefs.current.playbackUrl = url;
        const audio = new Audio(url);
        testRefs.current.audio = audio;

        setTestStatus('playing');
        testStatusRef.current = 'playing';

        audio.onended = () => {
          releaseTestResources();
          setTestStatus('idle');
          testStatusRef.current = 'idle';
        };

        audio.onerror = () => {
          releaseTestResources();
          setTestStatus('error');
        };

        audio.play().catch(() => {
          releaseTestResources();
          setTestStatus('error');
        });
      };

      recorder.start();
      testRefs.current.timeout = window.setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 3000);
    } catch {
      releaseTestResources();
      setTestStatus('error');
    }
  }, [deviceSelection, releaseTestResources]);

  // Save handler
  const handleSave = React.useCallback(async () => {
    if (!isDirty) return;
    setSaving(true);
    setSaveSuccess(false);
    try {
      await setValue(MICROPHONE_KEY, deviceSelection);
      await setValue(OUTPUT_DEVICE_KEY, outputDeviceSelection);
      await setBoolean(NOISE_SUPPRESSION_KEY, noiseSuppression);
      await setBoolean(ECHO_CANCELLATION_KEY, echoCancellation);
      await setBoolean(SYSTEM_AUDIO_KEY, captureSystemAudio);
      await setValue(THEME_KEY, themeSelection);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to save preferences', err);
    } finally {
      setSaving(false);
    }
  }, [
    captureSystemAudio,
    deviceSelection,
    echoCancellation,
    isDirty,
    noiseSuppression,
    outputDeviceSelection,
    setBoolean,
    setValue,
    themeSelection,
  ]);

  const calendarConnected = calendarStatus?.connected === true;

  return (
    <SettingsTabLayout
      title={t('settings.preferences.title')}
      description={t('settings.preferences.description')}
      actions={
        <Button
          size="small"
          appearance="primary"
          onClick={() => void handleSave()}
          disabled={!isDirty || saving}
        >
          {saving ? t('common.saving') : saveSuccess ? t('common.saved') : t('common.save')}
        </Button>
      }
    >
      {/* Appearance */}
      <SettingsSection
        title={t('settings.preferences.appearance')}
        description={t('settings.preferences.appearance_desc')}
      >
        <div className={styles.themeSelector}>
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.themeOption} ${themeSelection === option.value ? styles.themeSelected : ''}`}
              onClick={() => setThemeSelection(option.value)}
            >
              <span
                className={`${styles.themePreview} ${styles[`theme${option.value.charAt(0).toUpperCase() + option.value.slice(1)}`]}`}
              />
              <span className={styles.themeLabel}>{option.label}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      {/* Input Device */}
      <SettingsSection
        title={t('settings.preferences.input_device')}
        description={t('settings.preferences.input_device_desc')}
        action={
          <SettingsInlineActions>
            <Tooltip content={t('settings.system.refresh_devices')} relationship="label">
              <Button
                size="small"
                appearance="subtle"
                icon={<ArrowClockwise16Regular />}
                onClick={() => enumerate()}
                disabled={enumerating}
              />
            </Tooltip>
            {needsPermission && (
              <Tooltip content={t('settings.system.allow_access')} relationship="label">
                <Button
                  size="small"
                  appearance="subtle"
                  icon={<ShieldCheckmarkRegular />}
                  onClick={() => requestPermission()}
                  disabled={enumerating}
                />
              </Tooltip>
            )}
          </SettingsInlineActions>
        }
      >
        <div className={styles.deviceRow}>
          <Dropdown
            appearance="outline"
            className={`${dropdownStyles.dropdown} ${styles.deviceDropdown}`}
            selectedOptions={[deviceSelection]}
            onOptionSelect={(_, data) => setDeviceSelection(data.optionValue ?? '')}
            placeholder={t('settings.system.select_microphone')}
            value={
              deviceSelection
                ? (devices.find((d) => d.id === deviceSelection)?.label ??
                  t('settings.system.microphone_default'))
                : t('settings.system.select_microphone')
            }
            disabled={enumerating || !canEnumerateDevices()}
          >
            <Option value="">{t('settings.system.microphone_default')}</Option>
            {devices.map((device) => (
              <Option key={device.id} value={device.id}>
                {device.label}
              </Option>
            ))}
          </Dropdown>

          <Button
            size="small"
            appearance="secondary"
            onClick={() => void handleTestMicrophone()}
            disabled={enumerating || testStatus !== 'idle'}
          >
            {testStatus === 'recording'
              ? t('settings.system.test_recording_button')
              : testStatus === 'playing'
                ? t('settings.system.test_playing_button')
                : t('settings.system.test_button')}
          </Button>
        </div>

        {deviceError && (
          <Text size={200} className={styles.errorText}>
            {deviceError}
          </Text>
        )}

        <div className={styles.testMeter}>
          <div className={styles.testMeterFill} style={{ transform: `scaleX(${testLevel})` }} />
        </div>
      </SettingsSection>

      {/* Output Device */}
      <SettingsSection
        title={t('settings.preferences.output_device')}
        description={t('settings.preferences.output_device_desc')}
      >
        <div className={styles.deviceRow}>
          <Dropdown
            appearance="outline"
            className={`${dropdownStyles.dropdown} ${styles.deviceDropdown}`}
            selectedOptions={[outputDeviceSelection]}
            onOptionSelect={(_, data) => setOutputDeviceSelection(data.optionValue ?? '')}
            placeholder={t('settings.system.select_speaker')}
            value={
              outputDeviceSelection
                ? (outputDevices.find((d) => d.id === outputDeviceSelection)?.label ??
                  t('settings.system.speaker_default'))
                : t('settings.system.select_speaker')
            }
            disabled={enumerating || !canEnumerateDevices()}
          >
            <Option value="">{t('settings.system.speaker_default')}</Option>
            {outputDevices.map((device) => (
              <Option key={device.id} value={device.id}>
                {device.label}
              </Option>
            ))}
          </Dropdown>
        </div>
      </SettingsSection>

      {/* Audio Processing */}
      <SettingsSection
        title={t('settings.preferences.audio_processing')}
        description={t('settings.preferences.audio_processing_desc')}
      >
        <div className={styles.switchStack}>
          <label className={styles.switchRow}>
            <div className={styles.switchLabel}>
              <Text weight="medium">{t('settings.system.noise_suppression')}</Text>
              <Text size={200} className={styles.switchDesc}>
                {t('settings.system.noise_suppression_description')}
              </Text>
            </div>
            <Switch
              checked={noiseSuppression}
              onChange={(_, data) => setNoiseSuppression(data.checked)}
            />
          </label>
          <label className={styles.switchRow}>
            <div className={styles.switchLabel}>
              <Text weight="medium">{t('settings.system.echo_cancellation')}</Text>
              <Text size={200} className={styles.switchDesc}>
                {t('settings.system.echo_cancellation_description')}
              </Text>
            </div>
            <Switch
              checked={echoCancellation}
              onChange={(_, data) => setEchoCancellation(data.checked)}
            />
          </label>
          {systemAudioSupported && (
            <label className={styles.switchRow}>
              <div className={styles.switchLabel}>
                <Text weight="medium">{t('settings.system.system_audio')}</Text>
                <Text size={200} className={styles.switchDesc}>
                  {t('settings.system.system_audio_description')}
                </Text>
              </div>
              <Switch
                checked={captureSystemAudio}
                onChange={(_, data) => setCaptureSystemAudio(data.checked)}
              />
            </label>
          )}
        </div>
      </SettingsSection>

      {/* Calendar */}
      <SettingsSection
        title={t('settings.preferences.calendar')}
        description={t('settings.preferences.calendar_desc')}
        action={
          calendarLoading ? (
            <Spinner size="tiny" />
          ) : calendarConnected ? (
            <SettingsInlineActions>
              <span className={styles.statusBadgeConnected}>{t('common.connected')}</span>
              <Button
                size="small"
                appearance="secondary"
                onClick={() => void handleCalendarDisconnect()}
                disabled={calendarDisconnecting}
              >
                {calendarDisconnecting ? t('common.disconnecting') : t('common.disconnect')}
              </Button>
            </SettingsInlineActions>
          ) : (
            <Button
              size="small"
              appearance="primary"
              onClick={() => void handleCalendarConnect()}
              disabled={calendarConnecting || !calendarApi?.startConnect}
            >
              {calendarConnecting ? t('common.connecting') : t('common.connect')}
            </Button>
          )
        }
      >
        {calendarError && (
          <Text size={200} className={styles.errorText}>
            {calendarError}
          </Text>
        )}
        {calendarStatus?.lastSyncTime && (
          <Text size={200} className={styles.calendarMeta}>
            Last synced: {new Date(calendarStatus.lastSyncTime).toLocaleString()}
          </Text>
        )}
      </SettingsSection>
    </SettingsTabLayout>
  );
};
