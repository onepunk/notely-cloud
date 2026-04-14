import {
  Button,
  Checkbox,
  Dropdown,
  Input,
  Option,
  Switch,
  Text,
  Tooltip,
} from '@fluentui/react-components';
import {
  ArrowClockwise16Regular,
  ArrowReset20Regular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { TRANSCRIPTION_CONFIG } from '../../../../common/config';
import { useSettingsStore } from '../../../shared/state/settings.store';

import styles from './AudioSettings.module.css';
import dropdownStyles from './Dropdown.module.css';
import {
  SettingsCard,
  SettingsInlineActions,
  SettingsSection,
  SettingsTabLayout,
} from './SettingsTabLayout';

type AudioDevice = {
  id: string;
  label: string;
};

const MICROPHONE_KEY = 'system.audio.inputDeviceId';
const OUTPUT_DEVICE_KEY = 'system.audio.outputDeviceId';
const NOISE_SUPPRESSION_KEY = 'system.audio.noiseSuppression';
const ECHO_CANCELLATION_KEY = 'system.audio.echoCancellation';
const SYSTEM_AUDIO_KEY = 'system.audio.captureSystemAudio';

// Advanced transcription settings keys
const ADV_BEAM_SIZE_KEY = 'transcription.advanced.beamSize';
const ADV_TEMPERATURE_KEY = 'transcription.advanced.temperature';
const ADV_LANGUAGE_KEY = 'transcription.advanced.language';
const ADV_VAD_THRESHOLD_KEY = 'transcription.advanced.vadThreshold';
const ADV_VAD_MIN_SILENCE_KEY = 'transcription.advanced.vadMinSilenceMs';
const ADV_REPETITION_PENALTY_KEY = 'transcription.advanced.repetitionPenalty';
const ADV_NO_REPEAT_NGRAM_KEY = 'transcription.advanced.noRepeatNgramSize';
const ADV_CONDITION_PREV_KEY = 'transcription.advanced.conditionOnPreviousText';
const ADV_REFINEMENT_BEAM_KEY = 'transcription.advanced.refinementBeamSize';

const ADVANCED_KEYS = [
  ADV_BEAM_SIZE_KEY,
  ADV_TEMPERATURE_KEY,
  ADV_LANGUAGE_KEY,
  ADV_VAD_THRESHOLD_KEY,
  ADV_VAD_MIN_SILENCE_KEY,
  ADV_REPETITION_PENALTY_KEY,
  ADV_NO_REPEAT_NGRAM_KEY,
  ADV_CONDITION_PREV_KEY,
  ADV_REFINEMENT_BEAM_KEY,
] as const;

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'advanced_language_auto' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ru', label: 'Russian' },
  { value: 'ar', label: 'Arabic' },
  { value: 'hi', label: 'Hindi' },
  { value: 'pl', label: 'Polish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'da', label: 'Danish' },
  { value: 'fi', label: 'Finnish' },
  { value: 'no', label: 'Norwegian' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'tr', label: 'Turkish' },
  { value: 'he', label: 'Hebrew' },
] as const;

const canEnumerateDevices = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices &&
  typeof navigator.mediaDevices.enumerateDevices === 'function';

export const AudioSettings: React.FC = () => {
  const { t } = useTranslation();
  const values = useSettingsStore((s) => s.values);
  const setValue = useSettingsStore((s) => s.setValue);
  const setBoolean = useSettingsStore((s) => s.setBoolean);

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

  // Output test state
  const [outputTestStatus, setOutputTestStatus] = React.useState<'idle' | 'playing'>('idle');
  const outputTestRefs = React.useRef<{
    audioCtx: AudioContext | null;
    timeout: number | null;
  }>({ audioCtx: null, timeout: null });
  const outputTestStatusRef = React.useRef(outputTestStatus);

  // Save state
  const [saving, setSaving] = React.useState(false);
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  const isDirty =
    deviceSelection !== selectedDeviceFromStore ||
    outputDeviceSelection !== selectedOutputDeviceFromStore ||
    noiseSuppression !== noiseSuppressionFromStore ||
    echoCancellation !== echoCancellationFromStore ||
    captureSystemAudio !== systemAudioFromStore;

  // Advanced transcription local state — reads from store, saves on blur
  const advBeamSizeFromStore = values[ADV_BEAM_SIZE_KEY] || '';
  const advTemperatureFromStore = values[ADV_TEMPERATURE_KEY] || '';
  const advLanguageFromStore = values[ADV_LANGUAGE_KEY] || '';
  const advVadThresholdFromStore = values[ADV_VAD_THRESHOLD_KEY] || '';
  const advVadMinSilenceFromStore = values[ADV_VAD_MIN_SILENCE_KEY] || '';
  const advRepetitionPenaltyFromStore = values[ADV_REPETITION_PENALTY_KEY] || '';
  const advNoRepeatNgramFromStore = values[ADV_NO_REPEAT_NGRAM_KEY] || '';
  const advConditionPrevFromStore = values[ADV_CONDITION_PREV_KEY] || '';
  const advRefinementBeamFromStore = values[ADV_REFINEMENT_BEAM_KEY] || '';

  const [advBeamSize, setAdvBeamSize] = React.useState(
    advBeamSizeFromStore || String(TRANSCRIPTION_CONFIG.beamSize)
  );
  const [advTemperature, setAdvTemperature] = React.useState(
    advTemperatureFromStore || String(TRANSCRIPTION_CONFIG.temperature)
  );
  const [advLanguage, setAdvLanguage] = React.useState(
    advLanguageFromStore || TRANSCRIPTION_CONFIG.language
  );
  const [advVadThreshold, setAdvVadThreshold] = React.useState(
    advVadThresholdFromStore || String(TRANSCRIPTION_CONFIG.vadThreshold)
  );
  const [advVadMinSilence, setAdvVadMinSilence] = React.useState(
    advVadMinSilenceFromStore || String(TRANSCRIPTION_CONFIG.vadMinSilenceDurationMs)
  );
  const [advRepetitionPenalty, setAdvRepetitionPenalty] = React.useState(
    advRepetitionPenaltyFromStore || String(TRANSCRIPTION_CONFIG.repetitionPenalty)
  );
  const [advNoRepeatNgram, setAdvNoRepeatNgram] = React.useState(
    advNoRepeatNgramFromStore || String(TRANSCRIPTION_CONFIG.noRepeatNgramSize)
  );
  const [advConditionPrev, setAdvConditionPrev] = React.useState(
    advConditionPrevFromStore === 'true'
  );
  const [advRefinementBeam, setAdvRefinementBeam] = React.useState(
    advRefinementBeamFromStore || String(TRANSCRIPTION_CONFIG.refinementBeamSize)
  );

  // Sync advanced state from store when store updates externally
  React.useEffect(() => {
    setAdvBeamSize(advBeamSizeFromStore || String(TRANSCRIPTION_CONFIG.beamSize));
    setAdvTemperature(advTemperatureFromStore || String(TRANSCRIPTION_CONFIG.temperature));
    setAdvLanguage(advLanguageFromStore || TRANSCRIPTION_CONFIG.language);
    setAdvVadThreshold(advVadThresholdFromStore || String(TRANSCRIPTION_CONFIG.vadThreshold));
    setAdvVadMinSilence(
      advVadMinSilenceFromStore || String(TRANSCRIPTION_CONFIG.vadMinSilenceDurationMs)
    );
    setAdvRepetitionPenalty(
      advRepetitionPenaltyFromStore || String(TRANSCRIPTION_CONFIG.repetitionPenalty)
    );
    setAdvNoRepeatNgram(
      advNoRepeatNgramFromStore || String(TRANSCRIPTION_CONFIG.noRepeatNgramSize)
    );
    setAdvConditionPrev(advConditionPrevFromStore === 'true');
    setAdvRefinementBeam(
      advRefinementBeamFromStore || String(TRANSCRIPTION_CONFIG.refinementBeamSize)
    );
  }, [
    advBeamSizeFromStore,
    advTemperatureFromStore,
    advLanguageFromStore,
    advVadThresholdFromStore,
    advVadMinSilenceFromStore,
    advRepetitionPenaltyFromStore,
    advNoRepeatNgramFromStore,
    advConditionPrevFromStore,
    advRefinementBeamFromStore,
  ]);

  const clampAdvanced = (value: number, min: number, max: number): number => {
    if (Number.isNaN(value) || !Number.isFinite(value)) return min;
    return Math.min(Math.max(value, min), max);
  };

  const saveAdvancedNumber = React.useCallback(
    async (
      key: string,
      raw: string,
      min: number,
      max: number,
      step: number,
      setter: (v: string) => void
    ) => {
      const parsed = parseFloat(raw);
      const clamped = clampAdvanced(parsed, min, max);
      // Round to step precision
      const rounded = Math.round(clamped / step) * step;
      // Use a fixed decimal count based on step to avoid floating point artifacts
      const decimalPlaces = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
      const display =
        decimalPlaces > 0 ? rounded.toFixed(decimalPlaces) : String(Math.round(rounded));
      setter(display);
      await setValue(key, display);
    },
    [setValue]
  );

  const handleResetAdvancedDefaults = React.useCallback(async () => {
    for (const key of ADVANCED_KEYS) {
      await setValue(key, '');
    }
    // Local state will sync via the useEffect above
  }, [setValue]);

  // Sync refs
  React.useEffect(() => {
    testStatusRef.current = testStatus;
  }, [testStatus]);

  React.useEffect(() => {
    outputTestStatusRef.current = outputTestStatus;
  }, [outputTestStatus]);

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

  // Output test
  const releaseOutputTestResources = React.useCallback(() => {
    const refs = outputTestRefs.current;
    if (refs.timeout) clearTimeout(refs.timeout);
    refs.audioCtx?.close().catch(() => {});
    Object.assign(refs, { audioCtx: null, timeout: null });
  }, []);

  React.useEffect(() => () => releaseOutputTestResources(), [releaseOutputTestResources]);

  const handleTestOutput = React.useCallback(async () => {
    if (outputTestStatusRef.current !== 'idle') return;
    releaseOutputTestResources();

    try {
      setOutputTestStatus('playing');
      outputTestStatusRef.current = 'playing';

      const audioCtx = new AudioContext();
      outputTestRefs.current.audioCtx = audioCtx;

      // Route to selected output device if supported and a specific device is chosen
      const ctxWithSink = audioCtx as AudioContext & {
        setSinkId?: (sinkId: string) => Promise<void>;
      };
      if (outputDeviceSelection && ctxWithSink.setSinkId) {
        await ctxWithSink.setSinkId(outputDeviceSelection);
      }

      // Close Encounters of the Third Kind five-note motif: D5 → E5 → C5 → C4 → G4
      const notes = [
        { freq: 587, duration: 0.3 }, // D5
        { freq: 659, duration: 0.3 }, // E5
        { freq: 523, duration: 0.3 }, // C5
        { freq: 262, duration: 0.45 }, // C4 (octave drop, held longer)
        { freq: 392, duration: 0.65 }, // G4 (resolving note, held longest)
      ];
      const now = audioCtx.currentTime;

      let offset = 0;
      for (const note of notes) {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.value = note.freq;
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        const start = now + offset;
        const end = start + note.duration;

        // Smooth gain envelope: quick attack, sustain, quick release
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(0.3, start + 0.02);
        gain.gain.setValueAtTime(0.3, end - 0.03);
        gain.gain.linearRampToValueAtTime(0, end);

        osc.start(start);
        osc.stop(end);
        offset += note.duration;
      }

      const totalDuration = notes.reduce((sum, n) => sum + n.duration, 0);
      outputTestRefs.current.timeout = window.setTimeout(
        () => {
          releaseOutputTestResources();
          setOutputTestStatus('idle');
          outputTestStatusRef.current = 'idle';
        },
        totalDuration * 1000 + 100
      );
    } catch {
      releaseOutputTestResources();
      setOutputTestStatus('idle');
      outputTestStatusRef.current = 'idle';
    }
  }, [outputDeviceSelection, releaseOutputTestResources]);

  const handleTestMicrophone = React.useCallback(async () => {
    console.log('[MicTest] clicked, current status:', testStatusRef.current);
    if (testStatusRef.current !== 'idle') return;
    releaseTestResources();

    try {
      setTestStatus('recording');
      testStatusRef.current = 'recording';
      setTestLevel(0);

      const useExplicitDevice = deviceSelection && deviceSelection !== 'default';
      const constraints = useExplicitDevice
        ? { audio: { deviceId: { exact: deviceSelection } } }
        : { audio: true };
      console.log('[MicTest] getUserMedia constraints:', JSON.stringify(constraints));

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getAudioTracks()[0];
      console.log(
        '[MicTest] got stream, tracks:',
        stream.getTracks().length,
        'muted:',
        track?.muted,
        'readyState:',
        track?.readyState,
        'enabled:',
        track?.enabled,
        'label:',
        track?.label
      );
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

      const recorderMime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : undefined;
      console.log('[MicTest] supported mime:', recorderMime);
      const recorder = new MediaRecorder(
        stream,
        recorderMime ? { mimeType: recorderMime } : undefined
      );
      console.log('[MicTest] MediaRecorder created, mimeType:', recorder.mimeType);
      testRefs.current.recorder = recorder;
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => {
        console.log('[MicTest] ondataavailable, size:', e.data?.size);
        if (e.data?.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        console.log('[MicTest] onstop, chunks:', chunks.length);
        releaseTestResources();
        setTestLevel(0);

        if (chunks.length === 0) {
          console.warn('[MicTest] no chunks recorded');
          setTestStatus('error');
          return;
        }

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        console.log('[MicTest] blob size:', blob.size, 'type:', blob.type);
        const url = URL.createObjectURL(blob);
        testRefs.current.playbackUrl = url;
        const audio = new Audio(url);
        testRefs.current.audio = audio;

        setTestStatus('playing');
        testStatusRef.current = 'playing';

        audio.onended = () => {
          console.log('[MicTest] playback ended');
          releaseTestResources();
          setTestStatus('idle');
          testStatusRef.current = 'idle';
        };

        audio.onerror = (e) => {
          console.error('[MicTest] playback error:', e);
          releaseTestResources();
          setTestStatus('error');
        };

        audio.play().catch((err) => {
          console.error('[MicTest] play() rejected:', err);
          releaseTestResources();
          setTestStatus('error');
        });
      };

      recorder.start(200);
      console.log('[MicTest] recording started (timeslice=200ms)');
      testRefs.current.timeout = window.setTimeout(() => {
        console.log('[MicTest] timeout fired, recorder state:', recorder.state);
        if (recorder.state === 'recording') recorder.stop();
      }, 3000);
    } catch (err) {
      console.error('[MicTest] caught error:', err);
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
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to save audio settings', err);
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
  ]);

  // Reset handler — restore all audio and transcription settings to defaults
  const handleReset = React.useCallback(async () => {
    // Reset audio device settings to defaults and persist
    await Promise.all([
      setValue(MICROPHONE_KEY, ''),
      setValue(OUTPUT_DEVICE_KEY, ''),
      setBoolean(NOISE_SUPPRESSION_KEY, true),
      setBoolean(ECHO_CANCELLATION_KEY, true),
      setBoolean(SYSTEM_AUDIO_KEY, false),
    ]);

    // Clear all advanced transcription settings (falls back to TRANSCRIPTION_CONFIG)
    await handleResetAdvancedDefaults();

    // Sync local state to defaults
    setDeviceSelection('');
    setOutputDeviceSelection('');
    setNoiseSuppression(true);
    setEchoCancellation(true);
    setCaptureSystemAudio(false);
    setSaveSuccess(false);
  }, [setValue, setBoolean, handleResetAdvancedDefaults]);

  return (
    <SettingsTabLayout
      title={t('settings.preferences.audio')}
      description={t('settings.preferences.audio_desc')}
      actions={
        <>
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowReset20Regular />}
            onClick={() => void handleReset()}
          >
            {t('common.reset', { defaultValue: 'Reset' })}
          </Button>
          <Button
            size="small"
            appearance="primary"
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
          >
            {saving ? t('common.saving') : saveSuccess ? t('common.saved') : t('common.save')}
          </Button>
        </>
      }
    >
      {/* Audio Devices */}
      <SettingsSection
        title={t('settings.preferences.audio')}
        description={t('settings.preferences.audio_desc')}
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
        bodyClassName={styles.devicesGrid}
      >
        <SettingsCard
          title={t('settings.preferences.input_device')}
          description={t('settings.preferences.input_device_desc')}
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
          </div>

          {deviceError && (
            <Text size={200} className={styles.errorText}>
              {deviceError}
            </Text>
          )}

          <div className={styles.deviceCardFooter}>
            <div className={styles.testMeter}>
              <div className={styles.testMeterFill} style={{ transform: `scaleX(${testLevel})` }} />
            </div>
            <div className={styles.deviceCardFooterActions}>
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
          </div>
        </SettingsCard>

        <SettingsCard
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

          <div className={styles.deviceCardFooter}>
            <div className={styles.testMeter}>
              <div
                className={styles.testMeterFill}
                style={{
                  transform: outputTestStatus === 'playing' ? 'scaleX(1)' : 'scaleX(0)',
                  transition: outputTestStatus === 'playing' ? 'transform 1.5s linear' : 'none',
                }}
              />
            </div>
            <div className={styles.deviceCardFooterActions}>
              <Button
                size="small"
                appearance="secondary"
                onClick={() => void handleTestOutput()}
                disabled={enumerating || outputTestStatus !== 'idle'}
              >
                {outputTestStatus === 'playing'
                  ? t('settings.system.test_output_playing_button')
                  : t('settings.system.test_output_button')}
              </Button>
            </div>
          </div>
        </SettingsCard>
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

      {/* Advanced Transcription */}
      <SettingsSection
        title={t('settings.preferences.advanced_transcription')}
        description={t('settings.preferences.advanced_transcription_desc')}
        action={
          <Button
            size="small"
            appearance="subtle"
            onClick={() => void handleResetAdvancedDefaults()}
          >
            {t('settings.preferences.advanced_reset_defaults')}
          </Button>
        }
      >
        <div className={styles.advancedGrid}>
          {/* ── Transcription Quality ── */}
          <div className={styles.subsectionTitle}>{t('settings.preferences.advanced_quality')}</div>

          <div className={styles.advancedInputGroup}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_beam_size')}
            </label>
            <Input
              type="number"
              min={1}
              max={10}
              step={1}
              value={advBeamSize}
              onChange={(e) => setAdvBeamSize(e.target.value)}
              onBlur={() =>
                void saveAdvancedNumber(ADV_BEAM_SIZE_KEY, advBeamSize, 1, 10, 1, setAdvBeamSize)
              }
              appearance="outline"
              className={styles.advancedInputField}
            />
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_beam_size_hint')}
            </div>
          </div>

          <div className={styles.advancedInputGroup}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_temperature')}
            </label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.1}
              value={advTemperature}
              onChange={(e) => setAdvTemperature(e.target.value)}
              onBlur={() =>
                void saveAdvancedNumber(
                  ADV_TEMPERATURE_KEY,
                  advTemperature,
                  0,
                  1,
                  0.1,
                  setAdvTemperature
                )
              }
              appearance="outline"
              className={styles.advancedInputField}
            />
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_temperature_hint')}
            </div>
          </div>

          <div className={`${styles.advancedInputGroup} ${styles.advancedFullRow}`}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_language')}
            </label>
            <Dropdown
              appearance="outline"
              className={`${dropdownStyles.dropdown} ${styles.advancedInputField}`}
              selectedOptions={[advLanguage]}
              value={
                advLanguage === 'auto'
                  ? t('settings.preferences.advanced_language_auto')
                  : (LANGUAGE_OPTIONS.find((l) => l.value === advLanguage)?.label ?? advLanguage)
              }
              onOptionSelect={(_, data) => {
                const next = data.optionValue ?? 'auto';
                setAdvLanguage(next);
                void setValue(ADV_LANGUAGE_KEY, next);
              }}
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <Option key={lang.value} value={lang.value}>
                  {lang.value === 'auto'
                    ? t('settings.preferences.advanced_language_auto')
                    : lang.label}
                </Option>
              ))}
            </Dropdown>
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_language_hint')}
            </div>
          </div>

          {/* ── Voice Activity Detection ── */}
          <div className={styles.subsectionTitle}>{t('settings.preferences.advanced_vad')}</div>

          <div className={styles.advancedInputGroup}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_vad_threshold')}
            </label>
            <Input
              type="number"
              min={0.1}
              max={0.9}
              step={0.05}
              value={advVadThreshold}
              onChange={(e) => setAdvVadThreshold(e.target.value)}
              onBlur={() =>
                void saveAdvancedNumber(
                  ADV_VAD_THRESHOLD_KEY,
                  advVadThreshold,
                  0.1,
                  0.9,
                  0.05,
                  setAdvVadThreshold
                )
              }
              appearance="outline"
              className={styles.advancedInputField}
            />
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_vad_threshold_hint')}
            </div>
          </div>

          <div className={styles.advancedInputGroup}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_vad_min_silence')}
            </label>
            <Input
              type="number"
              min={100}
              max={2000}
              step={50}
              value={advVadMinSilence}
              onChange={(e) => setAdvVadMinSilence(e.target.value)}
              onBlur={() =>
                void saveAdvancedNumber(
                  ADV_VAD_MIN_SILENCE_KEY,
                  advVadMinSilence,
                  100,
                  2000,
                  50,
                  setAdvVadMinSilence
                )
              }
              appearance="outline"
              className={styles.advancedInputField}
              contentAfter={<span className={styles.advancedUnit}>ms</span>}
            />
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_vad_min_silence_hint')}
            </div>
          </div>

          {/* ── Hallucination Prevention ── */}
          <div className={styles.subsectionTitle}>
            {t('settings.preferences.advanced_hallucination')}
          </div>

          <div className={styles.advancedInputGroup}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_repetition_penalty')}
            </label>
            <Input
              type="number"
              min={1.0}
              max={2.0}
              step={0.1}
              value={advRepetitionPenalty}
              onChange={(e) => setAdvRepetitionPenalty(e.target.value)}
              onBlur={() =>
                void saveAdvancedNumber(
                  ADV_REPETITION_PENALTY_KEY,
                  advRepetitionPenalty,
                  1.0,
                  2.0,
                  0.1,
                  setAdvRepetitionPenalty
                )
              }
              appearance="outline"
              className={styles.advancedInputField}
            />
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_repetition_penalty_hint')}
            </div>
          </div>

          <div className={styles.advancedInputGroup}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_no_repeat_ngram')}
            </label>
            <Input
              type="number"
              min={0}
              max={5}
              step={1}
              value={advNoRepeatNgram}
              onChange={(e) => setAdvNoRepeatNgram(e.target.value)}
              onBlur={() =>
                void saveAdvancedNumber(
                  ADV_NO_REPEAT_NGRAM_KEY,
                  advNoRepeatNgram,
                  0,
                  5,
                  1,
                  setAdvNoRepeatNgram
                )
              }
              appearance="outline"
              className={styles.advancedInputField}
            />
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_no_repeat_ngram_hint')}
            </div>
          </div>

          <div className={styles.advancedCheckboxGroup}>
            <Checkbox
              label={t('settings.preferences.advanced_condition_prev_text')}
              checked={advConditionPrev}
              onChange={(_, data) => {
                const checked = !!data.checked;
                setAdvConditionPrev(checked);
                void setBoolean(ADV_CONDITION_PREV_KEY, checked);
              }}
            />
            <span className={styles.advancedHintText}>
              {t('settings.preferences.advanced_condition_prev_text_hint')}
            </span>
          </div>

          <div className={styles.advancedInputGroup}>
            <label className={styles.advancedInputLabel}>
              {t('settings.preferences.advanced_refinement_beam_size')}
            </label>
            <Input
              type="number"
              min={1}
              max={10}
              step={1}
              value={advRefinementBeam}
              onChange={(e) => setAdvRefinementBeam(e.target.value)}
              onBlur={() =>
                void saveAdvancedNumber(
                  ADV_REFINEMENT_BEAM_KEY,
                  advRefinementBeam,
                  1,
                  10,
                  1,
                  setAdvRefinementBeam
                )
              }
              appearance="outline"
              className={styles.advancedInputField}
            />
            <div className={styles.advancedInputDescription}>
              {t('settings.preferences.advanced_refinement_beam_size_hint')}
            </div>
          </div>
        </div>
      </SettingsSection>
    </SettingsTabLayout>
  );
};
