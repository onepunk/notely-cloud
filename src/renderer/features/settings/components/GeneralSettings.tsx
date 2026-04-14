import {
  Button,
  Caption1,
  Dropdown,
  Input,
  MessageBar,
  Option,
  Spinner,
  Switch,
  Text,
  Tooltip,
} from '@fluentui/react-components';
import { ArrowClockwise16Regular, ShieldCheckmarkRegular } from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_API_URL, isNotelyService } from '../../../../common/config';
import { ServerHealthIndicator } from '../../../components/ServerHealthIndicator';
import { formatErrorForDisplay } from '../../../shared/error';
import { useAuthStore } from '../../../shared/hooks/useAuthStore';
import { useLicense } from '../../../shared/hooks/useLicense';
import { useSettingsStore } from '../../../shared/state/settings.store';
import { LicenseKeyInput } from '../../license/LicenseKeyInput';
import { LicenseStatus } from '../../license/LicenseStatus';

import dropdownStyles from './Dropdown.module.css';
import styles from './GeneralSettings.module.css';
import { LicenseDiagnostics } from './LicenseDiagnostics';
import serverStyles from './ServerSettings.module.css';
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

type SyncProvider = 'notely' | 'custom';

type InlineMessage = {
  type: 'success' | 'error' | 'warning' | 'info';
  text: string;
};

const MICROPHONE_KEY = 'system.audio.inputDeviceId';
const NOISE_SUPPRESSION_KEY = 'system.audio.noiseSuppression';
const ECHO_CANCELLATION_KEY = 'system.audio.echoCancellation';
const SYSTEM_AUDIO_KEY = 'system.audio.captureSystemAudio';
const THEME_KEY = 'system.theme';

const DEFAULT_THEME = 'system';
const THEME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'system', label: 'Follow system' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const canEnumerateDevices = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.enumerateDevices === 'function';

export const SystemSettings: React.FC = () => {
  const { t } = useTranslation();
  const values = useSettingsStore((s) => s.values);
  const setValue = useSettingsStore((s) => s.setValue);
  const setBoolean = useSettingsStore((s) => s.setBoolean);
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
  const [calendarLoadError, setCalendarLoadError] = React.useState<string | null>(null);
  const [calendarActionError, setCalendarActionError] = React.useState<string | null>(null);
  const [devices, setDevices] = React.useState<AudioDevice[]>([]);
  const selectedDeviceFromStore = values[MICROPHONE_KEY] || '';
  const themeFromStore = values[THEME_KEY] ?? DEFAULT_THEME;
  const noiseSuppressionFromStore = values[NOISE_SUPPRESSION_KEY] !== 'false';
  const echoCancellationFromStore = values[ECHO_CANCELLATION_KEY] !== 'false';
  const systemAudioFromStore = values[SYSTEM_AUDIO_KEY] === 'true';

  const [deviceSelection, setDeviceSelection] = React.useState(selectedDeviceFromStore);
  const [themeSelection, setThemeSelection] = React.useState(themeFromStore);
  const [noiseSuppression, setNoiseSuppression] = React.useState(noiseSuppressionFromStore);
  const [echoCancellation, setEchoCancellation] = React.useState(echoCancellationFromStore);
  const [captureSystemAudio, setCaptureSystemAudio] = React.useState(systemAudioFromStore);
  const [systemAudioSupported, setSystemAudioSupported] = React.useState(false);

  const [enumerating, setEnumerating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState<Date | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveSuccess, setSaveSuccess] = React.useState<Date | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  const [testStatus, setTestStatus] = React.useState<'idle' | 'recording' | 'playing' | 'error'>(
    'idle'
  );
  const [testMessage, setTestMessage] = React.useState<string | null>(null);
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
  const testStatusRef = React.useRef<'idle' | 'recording' | 'playing' | 'error'>('idle');

  // Account section state - now using shared auth store
  const { authStatus, profile, refreshAuth } = useAuthStore();
  const isAuthenticated = authStatus?.isAuthenticated ?? false;
  const userEmail = profile?.email ?? null;

  const [accountProvider, setAccountProvider] = React.useState<SyncProvider>('notely');
  const [accountServerUrl, setAccountServerUrl] = React.useState<string>(DEFAULT_API_URL);
  const [authStarting, setAuthStarting] = React.useState(false);
  const [accountMessage, setAccountMessage] = React.useState<InlineMessage | null>(null);

  const {
    license,
    loading: licenseLoading,
    activating: licenseActivating,
    error: licenseError,
    refresh: refreshLicense,
    activate: activateLicenseKey,
    clear: clearLicense,
  } = useLicense();
  const [licenseKeyInput, setLicenseKeyInput] = React.useState('');
  const [licenseMessage, setLicenseMessage] = React.useState<InlineMessage | null>(null);

  // License Server state
  const [licenseServerUrl, setLicenseServerUrl] = React.useState<string>(DEFAULT_API_URL);
  const [licenseServerOverride, setLicenseServerOverride] = React.useState<string | null>(null);
  const [licenseServerUrlInput, setLicenseServerUrlInput] = React.useState<string>('');
  const [licenseServerDirty, setLicenseServerDirty] = React.useState(false);
  const [licenseServerSaving, setLicenseServerSaving] = React.useState(false);
  const [licenseServerMessage, setLicenseServerMessage] = React.useState<InlineMessage | null>(
    null
  );
  const [testingConnection, setTestingConnection] = React.useState(false);

  const formatLicenseDate = React.useCallback((value: string | null) => {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toLocaleDateString(undefined, {
      dateStyle: 'long',
    });
  }, []);

  const formatFeatureLabel = React.useCallback(
    (featureKey: string) => {
      const normalized = featureKey.toLowerCase();
      const registry: Record<string, string> = {
        'ai-summary': t('settings.license.features.ai_summary'),
        'advanced-search': t('settings.license.features.advanced_search'),
        offline: t('settings.license.features.offline_mode'),
      };
      if (registry[normalized]) {
        return registry[normalized];
      }
      return normalized
        .split(/[-_]/g)
        .filter(Boolean)
        .map((segment) =>
          segment.length <= 2 ? segment.toUpperCase() : segment[0].toUpperCase() + segment.slice(1)
        )
        .join(' ');
    },
    [t]
  );

  const licenseTypeLabel = React.useMemo(() => {
    if (license.type === 'public') {
      return t('settings.license.type_public');
    }
    if (license.type === 'custom') {
      return t('settings.license.type_custom');
    }
    return t('settings.license.type_unknown');
  }, [license.type, t]);

  const licenseExpiryText = React.useMemo(() => {
    if (!license.expiresAt) {
      return t('settings.license.no_expiry');
    }
    const formatted = formatLicenseDate(license.expiresAt) ?? license.expiresAt;
    if (typeof license.daysRemaining === 'number') {
      const daysLabel =
        license.daysRemaining === 1
          ? t('settings.license.days_remaining_single')
          : t('settings.license.days_remaining_plural', { count: license.daysRemaining });
      return `${formatted} (${daysLabel})`;
    }
    return formatted;
  }, [formatLicenseDate, license.daysRemaining, license.expiresAt, t]);

  const featureLabels = React.useMemo(
    () =>
      (license.features ?? []).map((featureKey) => ({
        key: featureKey,
        label: formatFeatureLabel(featureKey),
      })),
    [formatFeatureLabel, license.features]
  );

  const issuedToLabel = React.useMemo(
    () => license.issuedTo ?? t('settings.license.issued_unknown'),
    [license.issuedTo, t]
  );

  React.useEffect(() => {
    testStatusRef.current = testStatus;
  }, [testStatus]);

  // Check if system audio capture is supported on this platform
  React.useEffect(() => {
    const checkSystemAudioSupport = async () => {
      try {
        const supported = await window.api.systemAudio.isSupported();
        setSystemAudioSupported(supported);
      } catch (error) {
        console.warn('Failed to check system audio support:', error);
        setSystemAudioSupported(false);
      }
    };
    checkSystemAudioSupport();
  }, []);

  React.useEffect(() => {
    if (!licenseMessage) return;
    const timeout = window.setTimeout(() => {
      setLicenseMessage(null);
    }, 6000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [licenseMessage]);

  React.useEffect(() => {
    if (!licenseServerMessage) return;
    const timeout = window.setTimeout(() => {
      setLicenseServerMessage(null);
    }, 6000);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [licenseServerMessage]);

  // Load license server configuration on mount
  React.useEffect(() => {
    const loadLicenseServerConfig = async () => {
      try {
        const [serverUrl, overrideUrl] = await Promise.all([
          window.api.license.getApiUrl(),
          window.api.settings.get('server.apiUrl'),
        ]);

        const normalizedOverride =
          typeof overrideUrl === 'string' && overrideUrl.trim().length > 0
            ? overrideUrl.trim()
            : '';

        const effectiveUrl = serverUrl || DEFAULT_API_URL;
        setLicenseServerUrl(effectiveUrl);
        setLicenseServerOverride(normalizedOverride || null);
        setLicenseServerUrlInput(normalizedOverride);
        setLicenseServerDirty(false);
      } catch (error) {
        console.error('Failed to load license server settings:', error);
      }
    };

    void loadLicenseServerConfig();
  }, []);

  // Initialize account provider from settings on mount
  React.useEffect(() => {
    const loadServerUrl = async () => {
      try {
        const serverUrl = await window.api.settings.get('auth.serverUrl');
        setAccountProvider(isNotelyService(serverUrl || '') ? 'notely' : 'custom');
        setAccountServerUrl(serverUrl || DEFAULT_API_URL);
      } catch (error) {
        console.error('Failed to load server URL:', error);
      }
    };

    void loadServerUrl();
  }, []);

  // Listen for auth:completed events to handle auth state updates
  React.useEffect(() => {
    const offAuth =
      typeof window.api?.onAuthCompleted === 'function'
        ? window.api.onAuthCompleted(async (p) => {
            if (p.success) {
              // Success: Auth store will automatically update via its own listener
              // Just refresh to pick up the latest state immediately
              setAuthStarting(false);
              await refreshAuth();
            } else {
              // Error: Show error message to user
              setAccountMessage({ type: 'error', text: formatErrorForDisplay(p.error, 'E1001') });
              setAuthStarting(false);
            }
          })
        : () => {
            /* noop */
          };
    return () => {
      try {
        offAuth();
      } catch {
        /* ignore */
      }
    };
  }, [refreshAuth]);

  const releaseTestResources = React.useCallback((options?: { resetState?: boolean }) => {
    const { resetState = false } = options ?? {};
    const refs = testRefs.current;
    if (refs.timeout) {
      clearTimeout(refs.timeout);
      refs.timeout = null;
    }
    if (refs.animation !== null) {
      cancelAnimationFrame(refs.animation);
      refs.animation = null;
    }
    if (refs.recorder && refs.recorder.state !== 'inactive') {
      try {
        refs.recorder.stop();
      } catch (err) {
        console.warn('Failed to stop test recorder', err);
      }
    }
    refs.recorder = null;
    if (refs.stream) {
      refs.stream.getTracks().forEach((track) => track.stop());
      refs.stream = null;
    }
    if (refs.audioCtx) {
      refs.audioCtx.close().catch(() => {});
      refs.audioCtx = null;
    }
    refs.analyser = null;
    if (refs.audio) {
      refs.audio.pause();
      refs.audio.src = '';
      refs.audio = null;
    }
    if (refs.playbackUrl) {
      URL.revokeObjectURL(refs.playbackUrl);
      refs.playbackUrl = null;
    }
    if (resetState) {
      setTestLevel(0);
      setTestMessage(null);
      setTestStatus('idle');
      testStatusRef.current = 'idle';
    }
  }, []);

  const cleanupTest = React.useCallback(() => {
    releaseTestResources({ resetState: true });
  }, [releaseTestResources]);

  React.useEffect(
    () => () => {
      releaseTestResources();
    },
    [releaseTestResources]
  );

  const resetSaveIndicators = React.useCallback(() => {
    setSaveSuccess(null);
    setSaveError(null);
  }, []);

  const mapDevices = React.useCallback((list: MediaDeviceInfo[]): AudioDevice[] => {
    let unnamedCount = 1;
    return list
      .filter((device) => device.kind === 'audioinput')
      .map((device) => {
        let label = device.label?.trim();
        if (!label) {
          label = `Microphone ${unnamedCount}`;
          unnamedCount += 1;
        }
        return {
          id: device.deviceId,
          label,
        };
      });
  }, []);

  const enumerate = React.useCallback(async () => {
    if (!canEnumerateDevices()) {
      setError(t('settings.system.microphone_not_supported'));
      return;
    }
    try {
      setEnumerating(true);
      setError(null);
      const deviceInfos = ((await navigator.mediaDevices?.enumerateDevices?.()) ??
        []) as MediaDeviceInfo[];
      const mapped = mapDevices(deviceInfos);
      setDevices(mapped);
      const hasLabels = mapped.some(
        (device) => device.label && !device.label.startsWith('Microphone ')
      );
      setNeedsPermission(!hasLabels);
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Failed to enumerate devices', err);
      setError(t('settings.system.microphone_error'));
    } finally {
      setEnumerating(false);
    }
  }, [mapDevices, t]);

  const requestPermission = React.useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError(t('settings.system.microphone_permission_error'));
      return;
    }

    try {
      setEnumerating(true);
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await enumerate();
    } catch (err) {
      console.warn('Microphone permission denied', err);
      setError(t('settings.system.microphone_permission_denied'));
    } finally {
      setEnumerating(false);
    }
  }, [enumerate, t]);

  React.useEffect(() => {
    void enumerate();
  }, [enumerate]);

  React.useEffect(() => {
    if (!canEnumerateDevices()) return;
    const handler = () => {
      void enumerate();
    };
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
    };
  }, [enumerate]);

  const handleDeviceSelect = (_event: React.SyntheticEvent, data: { optionValue?: string }) => {
    resetSaveIndicators();
    setDeviceSelection(data.optionValue ?? '');
  };

  const handleThemeSelect = (_event: React.SyntheticEvent, data: { optionValue?: string }) => {
    resetSaveIndicators();
    setThemeSelection(data.optionValue ?? DEFAULT_THEME);
  };

  const formatCalendarTimestamp = React.useCallback((value: string) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return parsed.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }, []);

  const loadCalendarStatus = React.useCallback(async () => {
    if (!calendarApi?.getStatus) {
      setCalendarLoading(false);
      if (!calendarApi) {
        setCalendarLoadError(t('settings.calendar.unavailable'));
      }
      return;
    }

    try {
      setCalendarLoading(true);
      setCalendarLoadError(null);
      const status = await calendarApi.getStatus();
      setCalendarStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : t('settings.calendar.load_failed');
      setCalendarStatus(null);
      setCalendarLoadError(message);
    } finally {
      setCalendarLoading(false);
    }
  }, [calendarApi, t]);

  const handleCalendarConnect = React.useCallback(async () => {
    if (!calendarApi?.startConnect) {
      setCalendarActionError(t('settings.calendar.unavailable'));
      return;
    }

    setCalendarActionError(null);
    try {
      setCalendarConnecting(true);
      const started = await calendarApi.startConnect();
      if (!started) {
        setCalendarConnecting(false);
        setCalendarActionError(t('settings.calendar.connect_failed'));
      }
    } catch (error) {
      setCalendarConnecting(false);
      setCalendarActionError(
        error instanceof Error ? error.message : t('settings.calendar.connect_failed')
      );
    }
  }, [calendarApi, t]);

  const handleCalendarDisconnect = React.useCallback(async () => {
    if (!calendarApi?.disconnect) {
      setCalendarActionError(t('settings.calendar.unavailable'));
      return;
    }

    setCalendarActionError(null);
    setCalendarDisconnecting(true);
    try {
      await calendarApi.disconnect();
      await loadCalendarStatus();
    } catch (error) {
      setCalendarActionError(
        error instanceof Error ? error.message : t('settings.calendar.disconnect_failed')
      );
    } finally {
      setCalendarDisconnecting(false);
    }
  }, [calendarApi, loadCalendarStatus, t]);

  const handleCalendarRefresh = React.useCallback(() => {
    if (!calendarApi?.getStatus) {
      return;
    }
    setCalendarActionError(null);
    setCalendarLoadError(null);
    void loadCalendarStatus();
  }, [calendarApi, loadCalendarStatus]);

  const formatTimestamp = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  const isDirty =
    deviceSelection !== selectedDeviceFromStore ||
    noiseSuppression !== noiseSuppressionFromStore ||
    echoCancellation !== echoCancellationFromStore ||
    captureSystemAudio !== systemAudioFromStore ||
    themeSelection !== themeFromStore;

  React.useEffect(() => {
    if (!calendarApi?.getStatus) {
      setCalendarLoading(false);
      if (!calendarApi) {
        setCalendarLoadError(t('settings.calendar.unavailable'));
      }
      return;
    }
    void loadCalendarStatus();
  }, [calendarApi, loadCalendarStatus, t]);

  React.useEffect(() => {
    if (!calendarApi?.onConnectResult) {
      return;
    }
    const unsubscribe = calendarApi.onConnectResult((result) => {
      setCalendarConnecting(false);
      if (result.success) {
        setCalendarActionError(null);
        loadCalendarStatus();
      } else if (result.error) {
        setCalendarActionError(result.error);
      } else {
        setCalendarActionError(null);
      }
    });
    return () => {
      try {
        unsubscribe?.();
      } catch (error) {
        console.warn('Failed to unsubscribe from calendar connect events', error);
      }
    };
  }, [calendarApi, loadCalendarStatus]);

  React.useEffect(() => {
    if (!isDirty) {
      setDeviceSelection(selectedDeviceFromStore);
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
    systemAudioFromStore,
    themeFromStore,
  ]);

  const handleSave = React.useCallback(async () => {
    if (!isDirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setValue(MICROPHONE_KEY, deviceSelection);
      await setBoolean(NOISE_SUPPRESSION_KEY, noiseSuppression);
      await setBoolean(ECHO_CANCELLATION_KEY, echoCancellation);
      await setBoolean(SYSTEM_AUDIO_KEY, captureSystemAudio);
      await setValue(THEME_KEY, themeSelection);
      const timestamp = new Date();
      setSaveSuccess(timestamp);
    } catch (err) {
      console.error('Failed to save system settings', err);
      setSaveError(t('settings.system.save_error'));
    } finally {
      setSaving(false);
    }
  }, [
    captureSystemAudio,
    deviceSelection,
    echoCancellation,
    isDirty,
    noiseSuppression,
    setBoolean,
    setValue,
    t,
    themeSelection,
  ]);

  const saveMessage = React.useMemo(() => {
    if (saving) {
      return t('settings.system.saving');
    }
    if (saveError) {
      return saveError;
    }
    if (saveSuccess) {
      return t('settings.system.save_success', { time: formatTimestamp(saveSuccess) });
    }
    return '';
  }, [saveError, saveSuccess, saving, t]);

  const layoutMeta = React.useMemo(() => {
    if (!saveMessage) {
      return null;
    }
    const classes = [styles.saveMeta];
    if (saveError) {
      classes.push(styles.saveMetaError);
    } else if (saveSuccess && !saving) {
      classes.push(styles.saveMetaSuccess);
    }
    return <Caption1 className={classes.join(' ')}>{saveMessage}</Caption1>;
  }, [saveError, saveMessage, saveSuccess, saving]);

  const calendarConnected = calendarStatus?.connected === true;
  const calendarRefreshDisabled =
    calendarLoading || calendarConnecting || calendarDisconnecting || !calendarApi?.getStatus;

  const testDisplayMessage = testMessage ?? t('settings.system.test_ready');

  const testStatusClassName =
    testStatus === 'recording'
      ? styles.testStatusRecording
      : testStatus === 'error'
        ? styles.testStatusError
        : '';

  const handleTestMicrophone = React.useCallback(async () => {
    if (testStatusRef.current === 'recording' || testStatusRef.current === 'playing') {
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setTestStatus('error');
      setTestMessage(t('settings.system.test_not_supported'));
      return;
    }

    if (typeof MediaRecorder === 'undefined') {
      setTestStatus('error');
      setTestMessage(t('settings.system.test_not_supported'));
      return;
    }

    cleanupTest();

    try {
      setTestStatus('recording');
      testStatusRef.current = 'recording';
      setTestMessage(t('settings.system.test_recording'));

      const constraints: MediaStreamConstraints = deviceSelection
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
        for (let i = 0; i < dataArray.length; i += 1) {
          const value = (dataArray[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        setTestLevel(Math.min(1, rms * 3));
        if (testStatusRef.current === 'recording') {
          testRefs.current.animation = requestAnimationFrame(updateLevel);
        }
      };
      updateLevel();

      const recorder = new MediaRecorder(stream);
      testRefs.current.recorder = recorder;
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.warn('Microphone test recorder error', event);
        releaseTestResources();
        setTestLevel(0);
        setTestStatus('error');
        testStatusRef.current = 'error';
        setTestMessage(t('settings.system.test_error'));
      };

      recorder.onstop = () => {
        testRefs.current.recorder = null;
        if (testRefs.current.timeout) {
          clearTimeout(testRefs.current.timeout);
          testRefs.current.timeout = null;
        }
        if (testRefs.current.animation !== null) {
          cancelAnimationFrame(testRefs.current.animation);
          testRefs.current.animation = null;
        }
        if (testRefs.current.stream) {
          testRefs.current.stream.getTracks().forEach((track) => track.stop());
          testRefs.current.stream = null;
        }
        if (testRefs.current.audioCtx) {
          testRefs.current.audioCtx.close().catch(() => {});
          testRefs.current.audioCtx = null;
        }
        testRefs.current.analyser = null;
        setTestLevel(0);

        if (chunks.length === 0) {
          setTestStatus('error');
          testStatusRef.current = 'error';
          setTestMessage(t('settings.system.test_silent'));
          return;
        }

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const playbackUrl = URL.createObjectURL(blob);
        testRefs.current.playbackUrl = playbackUrl;
        const audio = new Audio(playbackUrl);
        testRefs.current.audio = audio;

        setTestStatus('playing');
        testStatusRef.current = 'playing';
        setTestMessage(t('settings.system.test_playing'));

        audio.onended = () => {
          audio.pause();
          audio.src = '';
          testRefs.current.audio = null;
          if (testRefs.current.playbackUrl) {
            URL.revokeObjectURL(testRefs.current.playbackUrl);
            testRefs.current.playbackUrl = null;
          }
          setTestStatus('idle');
          testStatusRef.current = 'idle';
          setTestMessage(t('settings.system.test_completed'));
          setTimeout(() => {
            if (testStatusRef.current === 'idle') {
              setTestMessage(null);
            }
          }, 3000);
          setTestLevel(0);
        };

        audio.onerror = (err) => {
          console.error('Microphone test playback error', err);
          releaseTestResources();
          setTestLevel(0);
          setTestStatus('error');
          testStatusRef.current = 'error';
          setTestMessage(t('settings.system.test_playback_error'));
        };

        audio.play().catch((err) => {
          console.error('Microphone test playback start error', err);
          releaseTestResources();
          setTestLevel(0);
          setTestStatus('error');
          testStatusRef.current = 'error';
          setTestMessage(t('settings.system.test_playback_error'));
        });
      };

      recorder.start();
      const timeout = window.setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      }, 4000);
      testRefs.current.timeout = timeout;
    } catch (err) {
      console.error('Microphone test failed', err);
      releaseTestResources();
      setTestLevel(0);
      setTestStatus('error');
      testStatusRef.current = 'error';
      setTestMessage(t('settings.system.test_error'));
    }
  }, [cleanupTest, deviceSelection, releaseTestResources, t]);

  // Account section handlers
  const handleProviderChange = (provider: SyncProvider) => {
    setAccountProvider(provider);
    setAccountServerUrl(provider === 'notely' ? DEFAULT_API_URL : '');
    setAccountMessage(null);
  };

  const handleFieldChange = (field: string, value: string) => {
    if (field === 'serverUrl') {
      setAccountServerUrl(value);
    }
  };

  const handlePopupSignIn = async () => {
    setAccountMessage(null);

    const effectiveServerUrl =
      accountProvider === 'notely' ? DEFAULT_API_URL : accountServerUrl?.trim();

    if (!effectiveServerUrl) {
      setAccountMessage({ type: 'warning', text: 'Please enter a server URL.' });
      return;
    }

    try {
      setAuthStarting(true);
      setAccountMessage({ type: 'info', text: 'Opening sign-in window…' });

      // Store server URL in settings for auth to use
      await window.api.settings.set('auth.serverUrl', effectiveServerUrl);

      if (!licenseServerOverride) {
        try {
          const resolvedUrl = await window.api.license.getApiUrl();
          setLicenseServerUrl(resolvedUrl || DEFAULT_API_URL);
        } catch (error) {
          console.error('Failed to refresh license server URL after auth server update:', error);
        }
      }

      const opened = await window.api.auth.startWebLogin();
      setAuthStarting(false);

      if (!opened) {
        setAccountMessage({
          type: 'error',
          text: 'Sign-in window could not be opened. Please try again.',
        });
      } else {
        setAccountMessage({
          type: 'info',
          text: 'Complete authentication in the sign-in window to finish linking your account.',
        });
      }
    } catch (error) {
      console.error('Opening sign-in window failed:', error);
      setAccountMessage({
        type: 'error',
        text: 'Unable to open the sign-in window. Please verify your settings and try again.',
      });
      setAuthStarting(false);
    }
  };

  const handleLogout = async () => {
    try {
      const res = await window.api.auth.logout();
      if (!res.success) {
        setAccountMessage({ type: 'error', text: formatErrorForDisplay(res.error, 'E1007') });
        return;
      }
      setAccountMessage({ type: 'info', text: 'Signed out. You can sign in again anytime.' });

      // Auth store will automatically update via its own listener
      // Just refresh to pick up the latest state immediately
      await refreshAuth();

      // Clear message after a few seconds
      setTimeout(() => {
        setAccountMessage(null);
      }, 5000);
    } catch (e) {
      setAccountMessage({ type: 'error', text: formatErrorForDisplay(e, 'E1007') });
    }
  };

  const handleLicenseActivate = React.useCallback(async () => {
    if (!licenseKeyInput.trim()) {
      setLicenseMessage({
        type: 'warning',
        text: t('settings.license.enter_key_prompt'),
      });
      return;
    }
    const result = await activateLicenseKey(licenseKeyInput);
    if (result.success) {
      setLicenseKeyInput('');
      setLicenseMessage({
        type: 'success',
        text: t('settings.license.activate_success'),
      });
    } else if (result.message) {
      setLicenseMessage({ type: 'error', text: result.message });
    } else {
      setLicenseMessage({
        type: 'error',
        text: t('settings.license.activate_failed'),
      });
    }
  }, [activateLicenseKey, licenseKeyInput, t]);

  const handleLicenseClear = React.useCallback(async () => {
    await clearLicense();
    setLicenseKeyInput('');
    setLicenseMessage({
      type: 'info',
      text: t('settings.license.cleared'),
    });
  }, [clearLicense, t]);

  const handleLicenseServerUrlChange = (value: string) => {
    setLicenseServerUrlInput(value);
    const normalized = value.trim();
    setLicenseServerDirty(normalized !== (licenseServerOverride ?? ''));
    setLicenseServerMessage(null);
  };

  const validateServerUrl = (url: string): { valid: boolean; error?: string } => {
    if (!url) {
      return { valid: false, error: 'Server URL cannot be empty' };
    }

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { valid: false, error: 'URL must use http or https protocol' };
      }

      // Warn about HTTP in production
      if (parsed.protocol === 'http:' && !url.includes('localhost') && !url.includes('127.0.0.1')) {
        setLicenseServerMessage({
          type: 'warning',
          text: 'Warning: Using HTTP in production is insecure. Consider using HTTPS.',
        });
      }

      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid URL format' };
    }
  };

  const handleSaveLicenseServerUrl = async () => {
    const trimmed = licenseServerUrlInput.trim();

    if (trimmed) {
      const validation = validateServerUrl(trimmed);
      if (!validation.valid) {
        setLicenseServerMessage({
          type: 'error',
          text: validation.error || 'Invalid URL',
        });
        return;
      }
    }

    setLicenseServerSaving(true);
    setLicenseServerMessage(null);

    try {
      await window.api.license.setApiUrl(trimmed || null);
      const effectiveUrl = await window.api.license.getApiUrl();
      setLicenseServerUrl(effectiveUrl || DEFAULT_API_URL);
      setLicenseServerOverride(trimmed || null);
      setLicenseServerUrlInput(trimmed);
      setLicenseServerDirty(false);
      setLicenseServerMessage({
        type: 'success',
        text: trimmed
          ? 'License server URL updated successfully'
          : 'License server now follows your account settings',
      });
    } catch (error) {
      console.error('Failed to save license server URL:', error);
      setLicenseServerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Failed to save server URL',
      });
    } finally {
      setLicenseServerSaving(false);
    }
  };

  const handleTestConnection = async () => {
    const targetUrl = licenseServerUrlInput.trim() || licenseServerUrl || DEFAULT_API_URL;
    const validation = validateServerUrl(targetUrl);
    if (!validation.valid) {
      setLicenseServerMessage({
        type: 'error',
        text: validation.error || 'Invalid URL',
      });
      return;
    }

    setTestingConnection(true);
    setLicenseServerMessage(null);

    try {
      const result = await window.api.license.checkServerHealth(targetUrl);
      if (result.online) {
        setLicenseServerMessage({
          type: 'success',
          text: `Server is online (${result.responseTime}ms response time)`,
        });
      } else {
        setLicenseServerMessage({
          type: 'error',
          text: result.error || 'Server is offline',
        });
      }
    } catch (error) {
      console.error('Failed to test connection:', error);
      setLicenseServerMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Connection test failed',
      });
    } finally {
      setTestingConnection(false);
    }
  };

  const handleResetToDefault = () => {
    setLicenseServerUrlInput('');
    setLicenseServerDirty(Boolean(licenseServerOverride));
    setLicenseServerMessage(null);
  };

  return (
    <SettingsTabLayout
      title={t('common.general')}
      description={t('settings.system.layout_description')}
      actions={
        <Button
          size="small"
          appearance="primary"
          onClick={() => void handleSave()}
          disabled={!isDirty || saving}
        >
          {saving ? t('settings.system.saving_button') : t('common.save')}
        </Button>
      }
      meta={layoutMeta ?? undefined}
    >
      <SettingsSection
        title={t('settings.account.title')}
        description={t('settings.account.description')}
      >
        {accountMessage && (
          <MessageBar intent={accountMessage.type} className={serverStyles.messageBar}>
            {accountMessage.text}
          </MessageBar>
        )}

        <div className={serverStyles.providerGrid}>
          <button
            type="button"
            className={`${serverStyles.providerButton} ${
              accountProvider === 'notely' ? serverStyles.providerSelected : ''
            }`}
            onClick={() => handleProviderChange('notely')}
            aria-pressed={accountProvider === 'notely'}
          >
            <span className={serverStyles.providerTitle}>{t('sync.provider_notely')}</span>
            <span className={serverStyles.providerDescription}>
              {t('sync.provider_notely_description')}
            </span>
          </button>
          <button
            type="button"
            className={`${serverStyles.providerButton} ${
              accountProvider === 'custom' ? serverStyles.providerSelected : ''
            }`}
            onClick={() => handleProviderChange('custom')}
            aria-pressed={accountProvider === 'custom'}
          >
            <span className={serverStyles.providerTitle}>{t('sync.provider_custom')}</span>
            <span className={serverStyles.providerDescription}>
              {t('sync.provider_custom_description')}
            </span>
          </button>
        </div>

        {accountProvider === 'custom' && (
          <div className={serverStyles.serverField}>
            <Text>Server URL</Text>
            <input
              type="text"
              value={accountServerUrl}
              onChange={(e) => handleFieldChange('serverUrl', e.target.value)}
              placeholder="https://your-server.com"
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid var(--stroke)',
                background: 'var(--bg-container)',
                color: 'var(--text-primary)',
              }}
            />
          </div>
        )}

        <div className={serverStyles.signInRow} style={{ marginTop: 'var(--spacing-md)' }}>
          {isAuthenticated ? (
            <>
              {userEmail && (
                <div style={{ flex: 1 }}>
                  <Text weight="semibold">Signed in as:</Text>
                  <Text style={{ display: 'block', marginTop: '4px' }}>{userEmail}</Text>
                </div>
              )}
              <Button appearance="secondary" onClick={handleLogout}>
                {t('common.sign_out')}
              </Button>
            </>
          ) : (
            <Button appearance="primary" onClick={handlePopupSignIn} disabled={authStarting}>
              {authStarting ? (
                <span className={serverStyles.signInSpinner}>
                  <Spinner size="tiny" />
                  <span>{t('common.sign_in')}</span>
                </span>
              ) : (
                t('common.sign_in')
              )}
            </Button>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.license.title')}
        description={t('settings.license.description')}
      >
        <div className={styles.licenseSection}>
          {(licenseError || licenseMessage) && (
            <MessageBar
              intent={licenseError ? 'error' : (licenseMessage?.type ?? 'info')}
              className={serverStyles.messageBar}
            >
              {licenseError ?? licenseMessage?.text}
            </MessageBar>
          )}
          <div className={styles.licenseGrid}>
            <div className={styles.licenseCard}>
              <div className={styles.licenseMetaList}>
                <div className={styles.licenseMetaRow}>
                  <span className={styles.licenseMetaLabel}>
                    {t('settings.license.type_label')}
                  </span>
                  <span className={styles.licenseMetaValue}>{licenseTypeLabel}</span>
                </div>
                <div className={styles.licenseMetaRow}>
                  <span className={styles.licenseMetaLabel}>
                    {t('settings.license.expires_label')}
                  </span>
                  <span className={styles.licenseMetaValue}>{licenseExpiryText}</span>
                </div>
                <div className={styles.licenseMetaRow}>
                  <span className={styles.licenseMetaLabel}>
                    {t('settings.license.issued_label')}
                  </span>
                  <span className={styles.licenseMetaValue}>{issuedToLabel}</span>
                </div>
              </div>
            </div>
            <LicenseStatus
              className={styles.licenseStatusCard}
              status={license.status}
              validationMode={license.validationMode}
              lastValidatedAt={license.lastValidatedAt}
              nextValidationAt={license.nextValidationAt}
              statusMessage={license.statusMessage}
              checking={licenseLoading}
              onCheckNow={() => {
                void refreshLicense();
              }}
            />
          </div>
          <div className={styles.licenseFeatures}>
            <span className={styles.licenseMetaLabel}>{t('settings.license.features_label')}</span>
            {featureLabels.length > 0 ? (
              <ul className={styles.licenseFeatureList}>
                {featureLabels.map((feature) => (
                  <li key={feature.key} className={styles.licenseFeatureItem}>
                    <span className={styles.licenseFeatureBullet} aria-hidden="true" />
                    <span>{feature.label}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.licenseEmptyFeatures}>
                {license.status === 'active'
                  ? t('settings.license.no_features_detected')
                  : t('settings.license.activate_hint')}
              </p>
            )}
          </div>
          <LicenseKeyInput
            value={licenseKeyInput}
            onChange={setLicenseKeyInput}
            onActivate={handleLicenseActivate}
            onClear={handleLicenseClear}
            activating={licenseActivating}
            disabled={licenseLoading}
            helperText={t('settings.license.input_hint')}
          />
          <div style={{ marginTop: 'var(--spacing-md)' }}>
            <LicenseDiagnostics />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.license_server.title')}
        description={t('settings.license_server.description')}
      >
        <div className={styles.licenseServerSection}>
          {licenseServerMessage && (
            <MessageBar intent={licenseServerMessage.type} className={serverStyles.messageBar}>
              {licenseServerMessage.text}
            </MessageBar>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs)' }}>
              <Text weight="semibold">Server URL</Text>
              <Input
                value={licenseServerUrlInput}
                onChange={(e) => handleLicenseServerUrlChange(e.target.value)}
                placeholder="https://your-server.com"
                disabled={licenseServerSaving}
                style={{ width: '100%' }}
              />
              <Caption1 style={{ color: 'var(--text-secondary)' }}>
                Leave empty to use the server selected in the Account section (Notely or your
                custom URL).
              </Caption1>
              {!licenseServerOverride && (
                <Caption1 style={{ color: 'var(--text-tertiary)' }}>
                  Following: {licenseServerUrl || DEFAULT_API_URL}
                </Caption1>
              )}
            </div>

            <ServerHealthIndicator apiUrl={licenseServerUrl || DEFAULT_API_URL} />

            <SettingsInlineActions>
              <Button
                size="small"
                appearance="primary"
                onClick={handleSaveLicenseServerUrl}
                disabled={!licenseServerDirty || licenseServerSaving}
              >
                {licenseServerSaving ? 'Saving...' : 'Save Server URL'}
              </Button>
              <Button
                size="small"
                appearance="secondary"
                onClick={handleTestConnection}
                disabled={testingConnection || licenseServerSaving}
              >
                {testingConnection ? 'Testing...' : 'Test Connection'}
              </Button>
              <Button
                size="small"
                appearance="secondary"
                onClick={handleResetToDefault}
                disabled={licenseServerSaving}
              >
                Reset to Default
              </Button>
            </SettingsInlineActions>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.calendar.title')}
        description={t('settings.calendar.description')}
        action={
          <SettingsInlineActions>
            {calendarLoading ? (
              <span className={styles.spinner}>
                <Spinner size="tiny" />
                {t('settings.calendar.loading')}
              </span>
            ) : (
              <span
                className={`${styles.calendarStatus} ${
                  calendarConnected
                    ? styles.calendarStatusConnected
                    : styles.calendarStatusDisconnected
                }`}
              >
                {calendarConnected
                  ? t('settings.calendar.connected')
                  : t('settings.calendar.disconnected')}
              </span>
            )}
            {calendarConnected ? (
              <Button
                size="small"
                appearance="secondary"
                onClick={() => void handleCalendarDisconnect()}
                disabled={calendarDisconnecting || calendarLoading}
              >
                {calendarDisconnecting
                  ? t('settings.calendar.disconnecting')
                  : t('settings.calendar.disconnect')}
              </Button>
            ) : (
              <Button
                size="small"
                appearance="primary"
                onClick={() => void handleCalendarConnect()}
                disabled={calendarConnecting || !calendarApi?.startConnect}
              >
                {calendarConnecting
                  ? t('settings.calendar.connecting')
                  : t('settings.calendar.connect')}
              </Button>
            )}
            <Button
              size="small"
              appearance="secondary"
              onClick={() => void handleCalendarRefresh()}
              disabled={calendarRefreshDisabled}
            >
              {t('common.refresh')}
            </Button>
          </SettingsInlineActions>
        }
      >
        <div className={styles.calendarBody}>
          {calendarLoadError && <div className={styles.error}>{calendarLoadError}</div>}
          {calendarActionError && <div className={styles.error}>{calendarActionError}</div>}
          {calendarStatus?.syncStatus && (
            <div className={styles.calendarMeta}>
              {t('settings.calendar.sync_status', { status: calendarStatus.syncStatus })}
            </div>
          )}
          {calendarStatus?.lastSyncTime && (
            <div className={styles.calendarMeta}>
              {t('settings.calendar.last_sync', {
                time: formatCalendarTimestamp(calendarStatus.lastSyncTime),
              })}
            </div>
          )}
          {!calendarConnected && !calendarLoading && !calendarLoadError && (
            <div className={styles.calendarMeta}>{t('settings.calendar.disconnected_hint')}</div>
          )}
          {calendarStatus?.errorMessage && (
            <div className={styles.calendarWarning}>{calendarStatus.errorMessage}</div>
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('settings.system.audio_title')}
        description={t('settings.system.audio_description')}
        action={
          <SettingsInlineActions>
            <Tooltip content={t('settings.system.refresh_devices')} relationship="label">
              <Button
                size="small"
                appearance="secondary"
                icon={<ArrowClockwise16Regular />}
                onClick={() => enumerate()}
                disabled={enumerating}
              >
                {t('common.refresh')}
              </Button>
            </Tooltip>
            <Tooltip content={t('settings.system.allow_microphone')} relationship="label">
              <Button
                size="small"
                appearance="secondary"
                icon={<ShieldCheckmarkRegular />}
                onClick={() => requestPermission()}
                disabled={enumerating}
              >
                {t('settings.system.allow_access')}
              </Button>
            </Tooltip>
            <Button
              size="small"
              appearance="secondary"
              onClick={() => void handleTestMicrophone()}
              disabled={
                enumerating ||
                testStatus === 'recording' ||
                testStatus === 'playing' ||
                !canEnumerateDevices()
              }
            >
              {testStatus === 'recording'
                ? t('settings.system.test_recording_button')
                : testStatus === 'playing'
                  ? t('settings.system.test_playing_button')
                  : t('settings.system.test_button')}
            </Button>
          </SettingsInlineActions>
        }
      >
        <div className={styles.microphoneBody}>
          <div className={styles.deviceGrid}>
            <Dropdown
              appearance="outline"
              className={`${dropdownStyles.dropdown} ${styles.dropdown}`}
              selectedOptions={[deviceSelection]}
              onOptionSelect={handleDeviceSelect}
              placeholder={t('settings.system.select_microphone')}
              value={
                deviceSelection
                  ? (devices.find((device) => device.id === deviceSelection)?.label ??
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
          </div>
          <div className={styles.statusRow}>
            {enumerating ? (
              <span className={styles.spinner}>
                <Spinner size="tiny" />
                {t('settings.system.loading_devices')}
              </span>
            ) : (
              <span className={styles.status}>
                {lastUpdated
                  ? t('settings.system.last_checked', { time: formatTimestamp(lastUpdated) })
                  : t('settings.system.never_checked')}
              </span>
            )}
            {needsPermission && (
              <span className={styles.hint}>{t('settings.system.permission_hint')}</span>
            )}
          </div>
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.testPanel}>
            <div className={styles.testMeter} aria-hidden="true">
              <div
                className={styles.testMeterFill}
                style={{ transform: `scaleX(${Math.min(1, testLevel)})` }}
              />
            </div>
            <span className={`${styles.testStatus} ${testStatusClassName}`}>
              {testDisplayMessage}
            </span>
          </div>
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('settings.system.audio_processing_title')}
        description={t('settings.system.audio_processing_description')}
      >
        <div className={styles.switchStack}>
          <div className={styles.switchRow}>
            <div>
              <p className={styles.switchTitle}>{t('settings.system.noise_suppression')}</p>
              <p className={styles.switchDescription}>
                {t('settings.system.noise_suppression_description')}
              </p>
            </div>
            <Switch
              checked={noiseSuppression}
              onChange={(_, data) => {
                resetSaveIndicators();
                setNoiseSuppression(data.checked);
              }}
            />
          </div>
          <div className={styles.switchRow}>
            <div>
              <p className={styles.switchTitle}>{t('settings.system.echo_cancellation')}</p>
              <p className={styles.switchDescription}>
                {t('settings.system.echo_cancellation_description')}
              </p>
            </div>
            <Switch
              checked={echoCancellation}
              onChange={(_, data) => {
                resetSaveIndicators();
                setEchoCancellation(data.checked);
              }}
            />
          </div>
          {systemAudioSupported && (
            <div className={styles.switchRow}>
              <div>
                <p className={styles.switchTitle}>{t('settings.system.system_audio')}</p>
                <p className={styles.switchDescription}>
                  {t('settings.system.system_audio_description')}
                </p>
              </div>
              <Switch
                checked={captureSystemAudio}
                onChange={(_, data) => {
                  resetSaveIndicators();
                  setCaptureSystemAudio(data.checked);
                }}
              />
            </div>
          )}
        </div>
      </SettingsSection>
      <SettingsSection
        title={t('settings.system.theme_title')}
        description={t('settings.system.theme_description')}
      >
        <div className={styles.themeGrid}>
          <Dropdown
            appearance="outline"
            className={`${dropdownStyles.dropdown} ${styles.dropdown}`}
            selectedOptions={[themeSelection]}
            onOptionSelect={handleThemeSelect}
          >
            {THEME_OPTIONS.map((option) => (
              <Option key={option.value} value={option.value}>
                {t(`settings.system.theme_option.${option.value}`)}
              </Option>
            ))}
          </Dropdown>
        </div>
        <p className={styles.hint}>{t('settings.system.theme_hint')}</p>
      </SettingsSection>
      <SettingsSection
        title={t('settings.system.meeting_reminders_title')}
        description={t('settings.system.meeting_reminders_description')}
      >
        <SettingsInlineActions>
          <Button
            size="small"
            appearance="secondary"
            onClick={() => {
              window.api?.meetingReminder?.testTrigger?.().catch((err) => {
                console.error('Failed to trigger test reminder', err);
              });
            }}
          >
            {t('settings.system.test_reminder')}
          </Button>
        </SettingsInlineActions>
      </SettingsSection>
    </SettingsTabLayout>
  );
};
