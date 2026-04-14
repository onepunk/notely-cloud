import { create } from 'zustand';

import { getTranscriptionServerWsUrl, TRANSCRIPTION_CONFIG } from '@common/config';
import type { TranscriptionConfig } from '@common/config';
import { ERROR_CODES } from '@common/errors';
import { reportError } from '@shared/error';
import { log } from '@shared/log';
import { useSettingsStore } from '@shared/state/settings.store';

import type {
  TranscriptionMetadata,
  RefinementData,
  TranscriptionSegmentData,
  LanguageDetectionData,
} from '../client/transcriptionClient';
import { BufferedCommitter } from '../services/BufferedCommitter';

// Re-export types for use by other components
export type {
  TranscriptionSegmentData,
  Speaker,
  LanguageDetectionData,
} from '../client/transcriptionClient';

const MICROPHONE_SETTING_KEY = 'system.audio.inputDeviceId';
const SYSTEM_AUDIO_SETTING_KEY = 'system.audio.captureSystemAudio';
const STREAM_FRAME_DURATION_KEY = 'transcription.stream.frameDurationMs';
const STREAM_INITIAL_BUFFER_KEY = 'transcription.stream.initialBufferMs';
const NOTE_PREVIEW_CHAR_LIMIT = 500;
const MIN_LIVE_PERSIST_INTERVAL_MS = 1500;

type MetadataInput = {
  sessionId: string;
  binderId: string;
  noteId?: string;
  language: string;
};

const normalizeDeviceId = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const parseSettingNumber = (
  key: string,
  fallback: number,
  { min, max }: { min: number; max: number }
): number => {
  const rawValue = useSettingsStore.getState().getValue(key, '');
  const parsed = parseInt(rawValue, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
};

/**
 * Keys in the settings store (transcription.*) that map directly to
 * TranscriptionConfig fields.  The value type is inferred from the
 * TRANSCRIPTION_CONFIG default so we can parse strings correctly.
 */
const TRANSCRIPTION_SETTINGS_KEYS: Array<keyof TranscriptionConfig> = [
  'language',
  'beamSize',
  'temperature',
  'vadEnabled',
  'vadThreshold',
  'vadMinSpeechDurationMs',
  'vadMinSilenceDurationMs',
  'vadSpeechPadMs',
  'useSlidingWindow',
  'windowSizeMs',
  'windowOverlapMs',
  'maxSegmentLengthMs',
  'minStableIterations',
  'commitDelayMs',
  'maxPendingAudioMs',
  'contextPromptMaxChars',
  'refinementEnabled',
  'refinementDelayMs',
  'refinementBeamSize',
  'refinementTemperature',
  'refinementWorkers',
  'refinementMaxQueueSize',
  'conditionOnPreviousText',
  'repetitionPenalty',
  'noRepeatNgramSize',
];

/**
 * Read transcription settings from the settings store and build a partial
 * TranscriptionConfig overrides object.
 */
function readAdvancedConfigOverrides(): Partial<TranscriptionConfig> {
  const get = (key: string) => useSettingsStore.getState().getValue(key, '');
  const overrides: Partial<TranscriptionConfig> = {};

  // 1. Read new-style transcription.* keys (set by the Transcription Settings UI)
  for (const key of TRANSCRIPTION_SETTINGS_KEYS) {
    const raw = get(`transcription.${key}`);
    if (!raw) continue;

    const defaultVal = TRANSCRIPTION_CONFIG[key];
    if (typeof defaultVal === 'boolean') {
      (overrides as Record<string, unknown>)[key] = raw === 'true';
    } else if (typeof defaultVal === 'number') {
      const num = Number(raw);
      if (!Number.isNaN(num)) {
        (overrides as Record<string, unknown>)[key] = num;
      }
    } else {
      (overrides as Record<string, unknown>)[key] = raw;
    }
  }

  // 2. Read default model from settings and apply as modelName override
  const defaultModel = get('transcription.defaultModel');
  if (defaultModel) {
    overrides.modelName = defaultModel;
  }

  // 3. Legacy transcription.advanced.* keys (backward compatibility)
  const beamSize = parseInt(get('transcription.advanced.beamSize'), 10);
  if (!Number.isNaN(beamSize)) overrides.beamSize = beamSize;

  const temperature = parseFloat(get('transcription.advanced.temperature'));
  if (!Number.isNaN(temperature)) overrides.temperature = temperature;

  const language = get('transcription.advanced.language');
  if (language) overrides.language = language;

  const vadThreshold = parseFloat(get('transcription.advanced.vadThreshold'));
  if (!Number.isNaN(vadThreshold)) overrides.vadThreshold = vadThreshold;

  const vadMinSilenceMs = parseInt(get('transcription.advanced.vadMinSilenceMs'), 10);
  if (!Number.isNaN(vadMinSilenceMs)) overrides.vadMinSilenceDurationMs = vadMinSilenceMs;

  const repetitionPenalty = parseFloat(get('transcription.advanced.repetitionPenalty'));
  if (!Number.isNaN(repetitionPenalty)) overrides.repetitionPenalty = repetitionPenalty;

  const noRepeatNgramSize = parseInt(get('transcription.advanced.noRepeatNgramSize'), 10);
  if (!Number.isNaN(noRepeatNgramSize)) overrides.noRepeatNgramSize = noRepeatNgramSize;

  const conditionPrev = get('transcription.advanced.conditionOnPreviousText');
  if (conditionPrev === 'true' || conditionPrev === 'false') {
    overrides.conditionOnPreviousText = conditionPrev === 'true';
  }

  const refinementBeamSize = parseInt(get('transcription.advanced.refinementBeamSize'), 10);
  if (!Number.isNaN(refinementBeamSize)) overrides.refinementBeamSize = refinementBeamSize;

  return overrides;
}

async function buildTranscriptionMetadata({
  sessionId,
  binderId,
  noteId,
  language,
}: MetadataInput): Promise<TranscriptionMetadata> {
  const metadata: TranscriptionMetadata = {
    sessionId,
    binderId,
    language,
  };

  try {
    const binders = await window.api.storage.listBinders();
    const binder = binders.find((item) => item.id === binderId);
    if (binder?.name) {
      metadata.binderName = binder.name;
    }
  } catch (error) {
    console.warn('Transcription metadata: failed to resolve binder information', error);
  }

  if (noteId) {
    metadata.noteId = noteId;
    try {
      const note = await window.api.storage.getNote(noteId);
      if (note?.meta) {
        metadata.noteTitle = note.meta.title ?? '';
      }
      const plainText = note?.content?.plainText ?? '';
      if (plainText) {
        metadata.notePreview = plainText.slice(0, NOTE_PREVIEW_CHAR_LIMIT);
      }
    } catch (error) {
      console.warn('Transcription metadata: failed to resolve note context', error);
    }
  }

  return metadata;
}

const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

const splitSentences = (text: string): string[] => {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return [];
  const parts = normalized.split(/(?<=[.!?])\s+/);
  return parts.filter(Boolean).map((s) => s.trim());
};

const dedupeSentencesUnique = (text: string): string => {
  const sentences = splitSentences(text);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const sentence of sentences) {
    const key = sentence.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(sentence);
  }
  return result.join(' ');
};

/** Strip Whisper hallucination artifacts (repeated special chars) */
const stripHallucinationArtifacts = (text: string): string =>
  text
    .replace(/_{3,}/g, '')
    .replace(/-{5,}/g, '')
    .replace(/\.{4,}/g, '')
    .replace(/={3,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

// Protocol v2 partial update structure
export type PartialUpdate = {
  stable: { text: string; tokenCount?: number; sequence?: number; prefixLength?: number };
  unstable: { text: string; tokenCount?: number };
};

// Historical transcription session for display
export type HistoricalTranscription = {
  id: string;
  noteId: string;
  binderId: string;
  status: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  charCount: number;
  wordCount: number;
  createdAt: number;
};

// Audio player state for recording playback
export type AudioPlayerState = {
  isPlaying: boolean;
  currentTimeMs: number;
  durationMs: number;
  volume: number;
  isMuted: boolean;
  filePath: string | null;
  isLoading: boolean;
};

export type TranscriptionState = {
  isRecording: boolean;
  websocketStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  errorMessage?: string;
  partialText: string;
  finalSegments: string[];
  displayText: string; // Accumulated text for UI display
  sentSegments: Set<string>; // Track which segments have been sent to backend
  bufferedCommitter?: BufferedCommitter; // Intelligent buffering for accuracy
  activeSessionId?: string;
  activeNoteId?: string;
  language: string;
  // Language detection state
  detectedLanguage?: string;
  languageConfidence?: number;
  isAutoDetectEnabled: boolean;
  setDetectedLanguage: (data: LanguageDetectionData) => void;
  // WAV recording state for manual refinement
  hasRecording: boolean;
  lastRecordingSessionId?: string;
  isRefining: boolean;
  refinedText?: string;
  // Protocol v2 fields
  protocolVersion?: number;
  stableText?: string; // Protocol v2: stable portion of partial
  unstableText?: string; // Protocol v2: unstable portion of partial
  currentSegmentId?: string; // Protocol v2: current segment identifier
  // Segments with timestamps for user editing tracking
  segments: TranscriptionSegmentData[];
  isFinalizing: boolean; // True between stop-click and final_batch arrival
  batchFinalReceived: boolean; // True if a batch-mode final replaced all text
  hasUserEdits: boolean; // True if any segment has been edited
  originalDisplayText?: string; // Original text before user edits (for highlighting diff)
  refinementHistory?: Map<
    string,
    {
      originalText: string;
      refinedText: string;
      confidenceImprovement?: number;
      timestamp: number;
    }
  >;
  // Historical transcription viewing
  historicalTranscriptions: HistoricalTranscription[];
  selectedHistoricalId?: string;
  historicalContent?: string;
  isLoadingHistorical: boolean;
  viewingNoteId?: string; // The note we're currently viewing transcriptions for
  start: (options?: {
    serverUrl?: string;
    binderId?: string;
    noteId?: string;
    language?: string;
    deviceId?: string;
  }) => Promise<{ noteId: string }>;
  stop: () => Promise<void>;
  setPartial: (text: string | PartialUpdate) => void;
  pushFinal: (text: string) => void;
  pushFinalWithSegments: (data: {
    fullText: string;
    segments: TranscriptionSegmentData[];
    batchFinal?: boolean;
  }) => void;
  markSegmentEdited: (segmentId: string, newText: string) => void;
  applyRefinement: (data: RefinementData) => void;
  reset: () => void;
  forceReset: () => Promise<void>;
  refine: () => Promise<void>;
  // Historical transcription viewing actions
  loadTranscriptionsForNote: (noteId: string) => Promise<void>;
  selectHistoricalTranscription: (sessionId: string) => Promise<void>;
  clearHistoricalView: () => void;
  // Audio player state and actions
  audioPlayer: AudioPlayerState;
  loadAudio: (sessionId: string) => Promise<void>;
  setAudioPlaying: (playing: boolean) => void;
  seekAudioTo: (timeMs: number) => void;
  setAudioVolume: (volume: number) => void;
  setAudioMuted: (muted: boolean) => void;
  updateAudioCurrentTime: (timeMs: number) => void;
  resetAudioPlayer: () => void;
};

export const useTranscriptionStore = create<TranscriptionState>((set, get) => {
  let lastPersistedStableText = '';
  let lastPersistTimestamp = 0;

  const _persistStableText = async (stableText: string) => {
    const trimmed = stableText.trim();
    if (!trimmed) return;
    const now = Date.now();
    if (
      trimmed === lastPersistedStableText &&
      now - lastPersistTimestamp < MIN_LIVE_PERSIST_INTERVAL_MS
    ) {
      return;
    }

    const { activeSessionId } = get();
    if (!activeSessionId) return;

    lastPersistTimestamp = now;
    lastPersistedStableText = trimmed;

    try {
      await window.api.transcription.appendFinalText({
        sessionId: activeSessionId,
        textChunk: trimmed,
      });
    } catch (error) {
      console.warn('Live persist (stable) failed:', error);
    }
  };

  return {
    isRecording: false,
    websocketStatus: 'disconnected',
    errorMessage: undefined,
    partialText: '',
    finalSegments: [],
    displayText: '',
    sentSegments: new Set<string>(),
    language: 'en',
    // Language detection initial state
    detectedLanguage: undefined,
    languageConfidence: undefined,
    isAutoDetectEnabled: false,
    bufferedCommitter: undefined,
    // WAV recording initial state
    hasRecording: false,
    lastRecordingSessionId: undefined,
    isRefining: false,
    refinedText: undefined,
    // Protocol v2 initial state
    protocolVersion: undefined,
    stableText: undefined,
    unstableText: undefined,
    currentSegmentId: undefined,
    refinementHistory: undefined,
    // Segments with timestamps
    segments: [],
    isFinalizing: false,
    batchFinalReceived: false,
    hasUserEdits: false,
    originalDisplayText: undefined,
    // Historical transcription viewing initial state
    historicalTranscriptions: [],
    selectedHistoricalId: undefined,
    historicalContent: undefined,
    isLoadingHistorical: false,
    viewingNoteId: undefined,
    // Audio player initial state
    audioPlayer: {
      isPlaying: false,
      currentTimeMs: 0,
      durationMs: 0,
      volume: 1,
      isMuted: false,
      filePath: null,
      isLoading: false,
    },
    async start(options) {
      // Force cleanup of any previous stuck sessions FIRST
      await get().forceReset();
      lastPersistedStableText = '';
      lastPersistTimestamp = 0;
      if (get().isRecording) return;
      set({ websocketStatus: 'connecting', errorMessage: undefined });
      console.log('Starting transcription with options:', options);
      try {
        const binderId = options?.binderId as string | undefined;
        const preferredLanguage = options?.language || get().language || 'en';
        // Ensure we have a session before connecting audio
        if (!binderId) {
          throw new Error('binderId is required to start transcription');
        }
        const startResp = await window.api.transcription.startSession({
          binderId,
          noteId: options?.noteId,
          language: preferredLanguage,
        });
        set({
          activeSessionId: startResp.sessionId,
          activeNoteId: startResp.noteId,
          language: preferredLanguage,
          isAutoDetectEnabled: preferredLanguage === 'auto',
          detectedLanguage: undefined,
          languageConfidence: undefined,
        });

        // Create BufferedCommitter for intelligent text buffering
        const bufferedCommitter = new BufferedCommitter(
          async (text: string) => {
            console.log(
              'BufferedCommitter: Flushing buffered text to database, length:',
              text.length
            );
            const { activeSessionId } = get();
            if (activeSessionId && text.trim().length > 0) {
              try {
                await window.api.transcription.appendFinalText({
                  sessionId: activeSessionId,
                  textChunk: text.trim(),
                });
                console.log('BufferedCommitter: Database save successful');
              } catch (e) {
                console.error('BufferedCommitter: Database save failed:', e);
                throw e;
              }
            }
          },
          {
            maxBufferTime: 8000, // 8 seconds max buffer
            maxWordCount: 40, // 40 words max buffer
            sentenceBoundaryDelay: 600, // Wait 600ms after sentence end
            flushCheckInterval: 300, // Check for flush conditions every 300ms
            minFlushLength: 3, // Minimum 3 words to flush
          }
        );

        set({ bufferedCommitter });
        // Lazy import to avoid bundling cost until needed
        const { TranscriptionClient } = await import('../client/transcriptionClient');

        // Get the actual server port from the main process
        let serverUrl = options?.serverUrl;
        let httpPort: number | undefined;
        if (!serverUrl) {
          try {
            const { port } = await window.api.transcription.getServerPort();
            httpPort = port;
            serverUrl = getTranscriptionServerWsUrl(port);
            console.log('Using dynamic server port from main process:', port);
          } catch (e) {
            console.warn('Failed to get server port from main process, using default:', e);
            serverUrl = getTranscriptionServerWsUrl();
          }
        }

        // Check if a transcription model is available before connecting
        if (httpPort) {
          try {
            const modelsResp = await fetch(`http://127.0.0.1:${httpPort}/models/status`);
            const modelsData = (await modelsResp.json()) as {
              models: Array<{ downloaded: boolean }>;
            };
            const anyDownloaded = modelsData.models.some((m) => m.downloaded);
            if (!anyDownloaded) {
              set({
                errorMessage: 'NO_MODELS_DOWNLOADED',
                isRecording: false,
                websocketStatus: 'disconnected',
              });
              return;
            }
          } catch {
            // Server not ready — let WebSocket connection handle it
          }
        }

        const metadata = await buildTranscriptionMetadata({
          sessionId: startResp.sessionId,
          binderId,
          noteId: startResp.noteId,
          language: preferredLanguage,
        });
        const storedDeviceId = normalizeDeviceId(
          useSettingsStore.getState().getValue(MICROPHONE_SETTING_KEY, '')
        );
        const explicitDeviceId = normalizeDeviceId(options?.deviceId);
        const deviceId = explicitDeviceId ?? storedDeviceId;
        const systemAudioEnabled =
          useSettingsStore.getState().getValue(SYSTEM_AUDIO_SETTING_KEY, 'false') === 'true';
        const frameDurationMs = parseSettingNumber(STREAM_FRAME_DURATION_KEY, 200, {
          min: 80,
          max: 1000,
        });
        const initialBufferMs = parseSettingNumber(STREAM_INITIAL_BUFFER_KEY, 800, {
          min: frameDurationMs,
          max: 4000,
        });
        // Read advanced transcription overrides from settings
        const configOverrides = readAdvancedConfigOverrides();
        console.log('Creating transcription client with URL:', serverUrl, {
          systemAudioEnabled,
          configOverrides,
        });
        const client = new TranscriptionClient({
          serverUrl,
          deviceId,
          metadata,
          systemAudioEnabled,
          configOverrides,
          streamConfig: {
            frameDurationMs,
            initialBufferMs,
          },
          onHello: (data) => {
            console.log('onHello callback: Protocol version', data.version, 'detected');
            set({ protocolVersion: data.version });
          },
          onPartial: (text) => get().setPartial(text),
          onFinalWithSegments: async (data) => {
            console.log('onFinalWithSegments callback triggered:', {
              fullTextLength: data.fullText.length,
              segmentCount: data.segments.length,
              batchFinal: data.batchFinal,
            });
            const trimmedText = data.fullText.trim();

            // Store segments with timestamps
            get().pushFinalWithSegments({
              fullText: trimmedText,
              segments: data.segments,
              batchFinal: data.batchFinal,
            });

            if (data.batchFinal) {
              // Batch final replaces everything — clear buffer, replace DB text
              const { bufferedCommitter, activeSessionId } = get();
              if (bufferedCommitter) bufferedCommitter.clearBuffer();
              if (activeSessionId && trimmedText.length > 0) {
                console.log(
                  'onFinalWithSegments: Batch final — replacing DB text, length:',
                  trimmedText.length
                );
                await window.api.transcription.replaceFullText({
                  sessionId: activeSessionId,
                  fullText: trimmedText,
                });
              }
            } else {
              // Normal incremental final — buffer for append
              const { bufferedCommitter } = get();
              if (bufferedCommitter && trimmedText && trimmedText.length > 0) {
                console.log(
                  'onFinalWithSegments: Adding segment to buffer, length:',
                  trimmedText.length
                );
                bufferedCommitter.addSegment(trimmedText);
              }
            }
          },
          // Fallback for backward compatibility
          onFinal: async (text) => {
            console.log('onFinal callback triggered, length:', text.length);
            const trimmedText = text.trim();
            get().pushFinal(trimmedText);

            // Use BufferedCommitter instead of immediate save for better accuracy
            const { bufferedCommitter } = get();
            if (bufferedCommitter && trimmedText && trimmedText.length > 0) {
              console.log('onFinal: Adding segment to buffer, length:', trimmedText.length);
              bufferedCommitter.addSegment(trimmedText);
            }
          },
          onRefinement: (data) => {
            console.log('Refinement received for segment:', data.segmentId);
            get().applyRefinement(data);
          },
          onLanguageDetected: (data) => {
            console.log('Language detected:', data);
            get().setDetectedLanguage(data);
          },
          onOpen: () => {
            console.log('WebSocket connected');
            set({ websocketStatus: 'connected' });
          },
          onError: (err) => {
            console.error('WebSocket error:', err);
            set({ websocketStatus: 'error', errorMessage: `${ERROR_CODES.E3004.message} (E3004)` });
          },
          onClose: () => {
            console.log('WebSocket closed');
            set({ websocketStatus: 'disconnected' });
          },
        });
        console.log('Starting transcription client...');
        await client.start();
        // store client instance on window symbol for stop() access without keeping in Zustand (non-serializable)
        (window as unknown as { __transcriptionClient: unknown }).__transcriptionClient = client;
        set({ isRecording: true });
        // BufferedCommitter now handles all intelligent timing - no need for periodic timer
        console.log('Transcription started successfully');
        return { noteId: startResp.noteId };
      } catch (e: unknown) {
        console.error('Failed to start transcription:', e);
        // Clean up any backend session that might have been created
        const sessionId = get().activeSessionId;
        if (sessionId) {
          try {
            await window.api.transcription.completeSession({ sessionId });
            console.log('Cleaned up stuck backend session:', sessionId);
          } catch (cleanupError) {
            console.warn('Failed to clean up backend session:', cleanupError);
          }
        }
        // Clean up BufferedCommitter on failure
        const { bufferedCommitter } = get();
        if (bufferedCommitter) {
          try {
            bufferedCommitter.destroy();
          } catch (cleanupError) {
            console.warn('Failed to cleanup BufferedCommitter on start error:', cleanupError);
          }
        }

        // Classify microphone errors and report user-friendly messages
        const err = e as Error & { name?: string };
        let errorCode: keyof typeof ERROR_CODES = 'E3004';
        if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
          errorCode = 'E3009';
        } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          errorCode = 'E3010';
        } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
          errorCode = 'E3011';
        }

        const errorDef = ERROR_CODES[errorCode];

        // Reset session state on failure to prevent "session already active" errors
        set({
          websocketStatus: 'error',
          errorMessage: `${errorDef.message} (${errorCode})`,
          activeSessionId: undefined,
          activeNoteId: undefined,
          bufferedCommitter: undefined,
          isRecording: false,
        });

        // Report with user-friendly message (shows toast) — do not re-throw
        // so the global handler doesn't fire a second generic "Operation failed" toast
        reportError(e, errorCode);
        return { noteId: '' };
      }
    },
    async stop() {
      set({ isFinalizing: true });

      const client = (window as unknown as { __transcriptionClient: unknown })
        .__transcriptionClient as
        | {
            stop(): Promise<void>;
            getRecordedWavData(): ArrayBuffer | null;
            hasRecordedAudio(): boolean;
          }
        | undefined;

      // Save WAV recording before stopping the client
      const { activeSessionId } = get();
      if (client && activeSessionId && client.hasRecordedAudio?.()) {
        try {
          const wavData = client.getRecordedWavData?.();
          if (wavData) {
            console.log('Saving WAV recording for session:', activeSessionId);
            // Convert ArrayBuffer to base64
            const uint8Array = new Uint8Array(wavData);
            const binaryString = Array.from(uint8Array)
              .map((byte) => String.fromCharCode(byte))
              .join('');
            const base64WavData = btoa(binaryString);

            await window.api.transcription.saveRecording({
              sessionId: activeSessionId,
              wavData: base64WavData,
            });
            console.log('WAV recording saved successfully');
            set({ hasRecording: true, lastRecordingSessionId: activeSessionId });
          }
        } catch (error) {
          console.error('Failed to save WAV recording:', error);
        }
      }

      if (client) {
        try {
          await client.stop();
        } catch (error) {
          console.warn('Failed to stop transcription client:', error);
        }
        (window as unknown as { __transcriptionClient: unknown }).__transcriptionClient = undefined;
      }
      // Legacy timer cleanup (removed - BufferedCommitter handles timing)

      // Force flush BufferedCommitter to ensure all buffered content is saved
      let bufferHadContent = false;
      try {
        const { bufferedCommitter } = get();
        if (bufferedCommitter) {
          console.log('Final flush: forcing BufferedCommitter to flush remaining content');
          // Check if buffer has content before flushing
          const bufferState = bufferedCommitter.getBufferState();
          bufferHadContent = bufferState.segments.length > 0;
          console.log('Final flush: Buffer state before flush:', bufferState);
          await bufferedCommitter.forceFlush();
          bufferedCommitter.destroy();
          console.log('Final flush: BufferedCommitter destroyed');
        }
      } catch (e) {
        console.error('BufferedCommitter final flush error:', e);
      }

      // Safety flush: If BufferedCommitter was empty but we have stable text from partials,
      // save it directly. This handles the case where recording stops before the server
      // sends a finalText message (only partials were received).
      // Skip safety flush if batch final already wrote the complete text.
      const {
        activeSessionId: sessionId,
        stableText: currentStableText,
        displayText: currentDisplayText,
        batchFinalReceived,
      } = get();
      if (sessionId && !bufferHadContent && !batchFinalReceived) {
        // Use stableText (Protocol v2) or fallback to displayText
        const textToSave = currentStableText?.trim() || currentDisplayText?.trim() || '';
        if (textToSave.length > 0) {
          console.log(
            'Safety flush: No finalized text was buffered, saving stable/display text directly'
          );
          console.log('Safety flush: Text to save, length:', textToSave.length);
          try {
            await window.api.transcription.appendFinalText({
              sessionId,
              textChunk: textToSave,
            });
            console.log('Safety flush: Text saved successfully');
          } catch (error) {
            console.error('Safety flush: Failed to save text:', error);
          }
        } else {
          console.log('Safety flush: No text to save (both stable and display text are empty)');
        }
      } else if (batchFinalReceived) {
        console.log('Safety flush: Skipped — batch final already replaced DB text');
      }

      // complete
      try {
        const { activeSessionId } = get();
        if (activeSessionId) {
          await window.api.transcription.completeSession({ sessionId: activeSessionId });
        }
      } catch (e) {
        console.error('completeSession error', e);
      }
      const {
        finalSegments,
        displayText,
        batchFinalReceived: wasBatchFinal,
        stableText: liveStableText,
        unstableText: liveUnstableText,
      } = get();
      const joinedFinals = finalSegments.join(' ');
      // Build fallback display text:
      // 1. Batch final (most accurate) — already in displayText
      // 2. Joined streaming finals (committed segments)
      // 3. Existing displayText
      // 4. Live streaming text (stableText + unstableText from Protocol v2 partials)
      const liveText = (
        (liveStableText || '') + (liveUnstableText ? ' ' + liveUnstableText : '')
      ).trim();
      const resolvedDisplayText = wasBatchFinal
        ? displayText
        : joinedFinals || displayText || liveText;
      set({
        isRecording: false,
        isFinalizing: false,
        partialText: '',
        displayText: resolvedDisplayText,
        activeSessionId: undefined,
        activeNoteId: undefined,
        stableText: undefined,
        unstableText: undefined,
        batchFinalReceived: false,
      });
      lastPersistedStableText = '';
      lastPersistTimestamp = 0;
    },
    setPartial(text) {
      // Handle Protocol v2 (PartialUpdate object)
      if (typeof text === 'object' && 'stable' in text && 'unstable' in text) {
        const stableText = stripHallucinationArtifacts(dedupeSentencesUnique(text.stable.text));
        const unstableText = stripHallucinationArtifacts(text.unstable.text);
        const _combinedText = stableText + (unstableText ? ' ' + unstableText : '');
        const _sequence = text.stable.sequence ?? 0;
        const _prefixLength = text.stable.prefixLength ?? 0;

        set((prev) => {
          const nextStable = stableText?.trim().length ? stableText : prev.stableText || '';
          const nextUnstable = unstableText?.trim().length ? unstableText : prev.unstableText || '';

          // IMPORTANT: Do NOT merge stable text into displayText
          // displayText should only contain finalized text from onFinal callbacks
          // stable text is kept separate for real-time display alongside displayText

          return {
            stableText: nextStable,
            unstableText: nextUnstable,
            // Keep displayText unchanged - it only gets updated by pushFinal
            displayText: prev.displayText,
            // Clear partialText when using Protocol v2 (to avoid duplication in UI)
            partialText: '',
          };
        });

        log.debug('[TRANSCRIPTION-PANEL-DEBUG] partial', {
          stableText: stableText?.substring(0, 200),
          unstableText: unstableText?.substring(0, 200),
          stableLen: stableText?.length ?? 0,
          unstableLen: unstableText?.length ?? 0,
        });

        // NOTE: Disabled auto-persistence of stable text as it was causing duplication
        // Stable text should only be persisted when it becomes final
        // The BufferedCommitter handles intelligent buffering and persistence of finalized text
      } else {
        // Protocol v1 (string)
        const partialText = text as string;

        set({
          partialText: partialText,
          // Clear v2 fields when using v1
          stableText: undefined,
          unstableText: undefined,
        });

        log.debug('[TRANSCRIPTION-PANEL-DEBUG] partial-v1', {
          partialText: partialText?.substring(0, 200),
          partialLen: partialText?.length ?? 0,
        });
      }
    },
    pushFinal(text) {
      if (text && text.trim().length > 0) {
        const _currentState = get();
        const trimmedFinal = normalizeWhitespace(text);

        log.debug('[TRANSCRIPTION-PANEL-DEBUG] final', {
          newText: trimmedFinal?.substring(0, 200),
          newLen: trimmedFinal?.length ?? 0,
          totalDisplayLen: (get().displayText?.length ?? 0) + (trimmedFinal?.length ?? 0),
        });

        set((s) => {
          const existingDisplay = s.displayText || '';
          const currentStable = s.stableText || '';

          // Check if this final text is actually the current stable text being finalized
          // If so, we can clear the stable text since it's now becoming final
          const isFinalizingStable =
            currentStable && trimmedFinal === normalizeWhitespace(currentStable);

          // Only add to displayText if it's not already there
          const alreadyHas = existingDisplay.includes(trimmedFinal);
          const nextDisplay = alreadyHas
            ? existingDisplay
            : existingDisplay
              ? `${existingDisplay} ${trimmedFinal}`
              : trimmedFinal;

          return {
            finalSegments: [...s.finalSegments, trimmedFinal],
            displayText: nextDisplay,
            partialText: '',
            // Clear stable/unstable if this was finalizing the current stable text
            stableText: isFinalizingStable ? '' : s.stableText,
            unstableText: isFinalizingStable ? '' : s.unstableText,
          };
        });
      }
    },
    pushFinalWithSegments(data) {
      const { fullText, segments, batchFinal } = data;
      if (fullText && fullText.trim().length > 0) {
        const trimmedFinal = normalizeWhitespace(fullText);

        log.debug('[TRANSCRIPTION-PANEL-DEBUG] final-with-segments', {
          newText: trimmedFinal?.substring(0, 200),
          newLen: trimmedFinal?.length ?? 0,
          segmentCount: segments.length,
          batchFinal: !!batchFinal,
          totalDisplayLen: (get().displayText?.length ?? 0) + (trimmedFinal?.length ?? 0),
        });

        set((s) => {
          if (batchFinal) {
            // Batch final: REPLACE everything with the accurate batch result
            return {
              finalSegments: [trimmedFinal],
              displayText: trimmedFinal,
              partialText: '',
              stableText: '',
              unstableText: '',
              segments: [...segments],
              batchFinalReceived: true,
              isFinalizing: false,
            };
          }

          // Existing append logic (unchanged)
          const existingDisplay = s.displayText || '';
          const currentStable = s.stableText || '';

          const isFinalizingStable =
            currentStable && trimmedFinal === normalizeWhitespace(currentStable);

          const alreadyHas = existingDisplay.includes(trimmedFinal);
          const nextDisplay = alreadyHas
            ? existingDisplay
            : existingDisplay
              ? `${existingDisplay} ${trimmedFinal}`
              : trimmedFinal;

          return {
            finalSegments: [...s.finalSegments, trimmedFinal],
            displayText: nextDisplay,
            partialText: '',
            stableText: isFinalizingStable ? '' : s.stableText,
            unstableText: isFinalizingStable ? '' : s.unstableText,
            // Accumulate segments with timestamps across batches
            segments: [...s.segments, ...segments],
          };
        });

        // Save segments to database
        const sessionId = get().activeSessionId;
        if (sessionId && segments.length > 0) {
          window.api.transcription
            .saveSegments({
              sessionId,
              segments: segments.map((seg, index) => ({
                segmentId: seg.segmentId,
                text: seg.text,
                startTime: seg.startTime,
                endTime: seg.endTime,
                sequenceOrder: index,
              })),
            })
            .then((result) => {
              console.log('[SEGMENTS SAVED]', {
                sessionId,
                segmentCount: result.segmentCount,
              });
            })
            .catch((error) => {
              console.error('[SEGMENTS SAVE ERROR]', error);
            });
        }
      }
    },
    markSegmentEdited(segmentId, newText) {
      console.log('[MARK SEGMENT EDITED]', { segmentId, newText: newText.substring(0, 50) });

      set((s) => {
        const updatedSegments = s.segments.map((seg) => {
          if (seg.segmentId === segmentId) {
            return {
              ...seg,
              originalText: seg.originalText || seg.text, // Preserve original if not already set
              text: newText,
              userEdited: true,
            };
          }
          return seg;
        });

        // Check if any segment has user edits
        const hasUserEdits = updatedSegments.some((seg) => seg.userEdited);

        return {
          segments: updatedSegments,
          hasUserEdits,
        };
      });

      // Persist edit to database
      const sessionId = get().activeSessionId;
      if (sessionId) {
        window.api.transcription
          .markSegmentEdited({
            sessionId,
            segmentId,
            newText,
          })
          .then(() => {
            console.log('[SEGMENT EDIT SAVED]', { sessionId, segmentId });
          })
          .catch((error) => {
            console.error('[SEGMENT EDIT SAVE ERROR]', error);
          });
      }
    },
    applyRefinement(data) {
      console.log('Refinement received:', {
        segmentId: data.segmentId,
        originalText: data.originalText,
        refinedText: data.refinedText,
        confidenceImprovement: data.confidenceImprovement,
      });

      // Initialize refinementHistory if needed
      const history = get().refinementHistory ?? new Map();

      // Store in refinement history
      history.set(data.segmentId, {
        originalText: data.originalText,
        refinedText: data.refinedText,
        confidenceImprovement: data.confidenceImprovement,
        timestamp: data.timestamp,
      });

      // Replace text in displayText
      const currentDisplayText = get().displayText;
      const updatedDisplayText = currentDisplayText.replace(data.originalText, data.refinedText);

      // Update finalSegments array
      const currentSegments = get().finalSegments;
      const updatedSegments = currentSegments.map((segment) =>
        segment === data.originalText ? data.refinedText : segment
      );

      set({
        refinementHistory: history,
        displayText: updatedDisplayText,
        finalSegments: updatedSegments,
      });

      console.log('Refinement applied:', {
        segmentId: data.segmentId,
        before: data.originalText,
        after: data.refinedText,
        displayTextUpdated: currentDisplayText !== updatedDisplayText,
      });

      // Persist refinement to database via IPC
      const sessionId = get().activeSessionId;
      if (sessionId) {
        window.api.transcription
          .applyRefinement({
            sessionId,
            segmentId: data.segmentId,
            originalText: data.originalText,
            refinedText: data.refinedText,
            confidenceImprovement: data.confidenceImprovement,
            timestamp: data.timestamp,
          })
          .then(() => {
            console.log('Refinement persisted to database:', {
              sessionId,
              segmentId: data.segmentId,
            });
          })
          .catch((error) => {
            console.error('Failed to persist refinement:', error);
            // Don't throw - UI update already succeeded
          });
      } else {
        console.warn('No active session to persist refinement');
      }
    },
    setDetectedLanguage(data) {
      console.log('Setting detected language:', data);
      set({
        detectedLanguage: data.language,
        languageConfidence: data.confidence,
      });
    },
    reset() {
      // Clean up BufferedCommitter
      const { bufferedCommitter } = get();
      if (bufferedCommitter) {
        bufferedCommitter.destroy();
      }
      set({
        isRecording: false,
        isFinalizing: false,
        websocketStatus: 'disconnected',
        errorMessage: undefined,
        partialText: '',
        finalSegments: [],
        displayText: '',
        sentSegments: new Set(),
        bufferedCommitter: undefined,
        activeSessionId: undefined,
        activeNoteId: undefined,
        // Clear Protocol v2 fields
        protocolVersion: undefined,
        stableText: undefined,
        unstableText: undefined,
        currentSegmentId: undefined,
        refinementHistory: undefined,
        // Clear segments with timestamps
        segments: [],
        hasUserEdits: false,
        originalDisplayText: undefined,
        // Clear language detection state
        detectedLanguage: undefined,
        languageConfidence: undefined,
        isAutoDetectEnabled: false,
      });
      lastPersistedStableText = '';
      lastPersistTimestamp = 0;
    },
    async forceReset() {
      // Force cleanup of any stuck sessions
      const sessionId = get().activeSessionId;
      if (sessionId) {
        try {
          await window.api.transcription.completeSession({ sessionId });
          console.log('Force reset: cleaned up backend session:', sessionId);
        } catch (e) {
          console.warn('Force reset: failed to clean up backend session:', e);
        }
      }
      // Clear any stuck client
      const client: unknown = (window as unknown as { __transcriptionClient: unknown })
        .__transcriptionClient;
      if (client) {
        try {
          await (client as { stop(): Promise<void> }).stop();
        } catch (error) {
          console.warn('Failed to stop stuck client:', error);
        }
        (window as unknown as { __transcriptionClient: unknown }).__transcriptionClient = undefined;
      }
      // Legacy timer cleanup (removed - BufferedCommitter handles timing)

      // Clean up BufferedCommitter
      const { bufferedCommitter } = get();
      if (bufferedCommitter) {
        try {
          bufferedCommitter.destroy();
          console.log('Force reset: BufferedCommitter destroyed');
        } catch (e) {
          console.warn('Force reset: failed to destroy BufferedCommitter:', e);
        }
      }

      // Reset all state
      set({
        isRecording: false,
        isFinalizing: false,
        websocketStatus: 'disconnected',
        errorMessage: undefined,
        partialText: '',
        finalSegments: [],
        displayText: '',
        sentSegments: new Set(),
        bufferedCommitter: undefined,
        activeSessionId: undefined,
        activeNoteId: undefined,
        // Clear Protocol v2 fields
        protocolVersion: undefined,
        stableText: undefined,
        unstableText: undefined,
        currentSegmentId: undefined,
        refinementHistory: undefined,
        // Clear segments with timestamps
        segments: [],
        hasUserEdits: false,
        originalDisplayText: undefined,
        // Clear language detection state
        detectedLanguage: undefined,
        languageConfidence: undefined,
        isAutoDetectEnabled: false,
      });
      lastPersistedStableText = '';
      lastPersistTimestamp = 0;
    },

    /**
     * Trigger manual refinement of the last recording
     * Uses second pass with higher beam size for better accuracy
     * If user has made corrections, passes them as hints to Whisper
     */
    async refine() {
      const {
        lastRecordingSessionId,
        hasRecording,
        isRefining,
        hasUserEdits,
        displayText,
        originalDisplayText,
      } = get();

      if (!hasRecording || !lastRecordingSessionId) {
        console.warn('Refine: No recording available');
        return;
      }

      if (isRefining) {
        console.warn('Refine: Already refining');
        return;
      }

      // If user has made edits, extract only the CHANGED words as hints
      // Passing the entire transcript as initial_prompt confuses Whisper and causes hallucinations
      // Instead, we pass just the corrected words to bias the model
      let hints: string | undefined;
      if (hasUserEdits && displayText && originalDisplayText) {
        const originalWords = originalDisplayText.split(/\s+/);
        const editedWords = displayText.split(/\s+/);
        const changedWords: string[] = [];

        // Find words that changed
        const maxLen = Math.max(originalWords.length, editedWords.length);
        for (let i = 0; i < maxLen; i++) {
          const original = originalWords[i] || '';
          const edited = editedWords[i] || '';
          if (original !== edited && edited.trim().length > 0) {
            changedWords.push(edited);
          }
        }

        // Only use hints if we found changed words
        if (changedWords.length > 0) {
          hints = changedWords.join(' ');
        }
      }

      console.log('Refine: Starting refinement for session:', lastRecordingSessionId, {
        hasUserEdits,
        usingHints: !!hints,
        hintsLength: hints?.length,
        hints: hints,
      });
      set({ isRefining: true });

      try {
        const result = await window.api.transcription.refine(lastRecordingSessionId, hints);

        if (result.success && result.text) {
          let finalText = result.text;

          // Post-process: If user made edits, re-apply their corrections to the refined text
          // Whisper's initial_prompt only hints at vocabulary, it can't force specific words
          // So we need to find-replace the original words with user's corrections
          if (hasUserEdits && originalDisplayText && displayText) {
            const originalWords = originalDisplayText.split(/\s+/);
            const editedWords = displayText.split(/\s+/);

            // Build a map of original -> corrected words
            const corrections: Array<{ original: string; corrected: string }> = [];
            const maxLen = Math.max(originalWords.length, editedWords.length);
            for (let i = 0; i < maxLen; i++) {
              const original = originalWords[i] || '';
              const edited = editedWords[i] || '';
              if (original !== edited && original.trim().length > 0 && edited.trim().length > 0) {
                corrections.push({ original, corrected: edited });
              }
            }

            // Apply corrections to refined text (case-insensitive replacement)
            for (const { original, corrected } of corrections) {
              // Create regex that matches the original word (case-insensitive, word boundary)
              const regex = new RegExp(
                `\\b${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
                'gi'
              );
              const beforeReplace = finalText;
              finalText = finalText.replace(regex, corrected);
              if (beforeReplace !== finalText) {
                console.log(`Refine: Applied user correction "${original}" -> "${corrected}"`);
              }
            }
          }

          console.log('Refine: Completed successfully', {
            textLength: result.text.length,
            finalTextLength: finalText.length,
            usedHints: result.usedHints,
            appliedCorrections: hasUserEdits,
          });
          set({
            isRefining: false,
            refinedText: finalText,
            displayText: finalText, // Update display with refined text (with corrections preserved)
            // Clear Protocol v2 fields to prevent duplication in UI
            stableText: '',
            unstableText: '',
            partialText: '',
            // Reset hasUserEdits since we've incorporated corrections into refinement
            hasUserEdits: false,
            originalDisplayText: undefined,
          });
        } else {
          console.error('Refine: Failed - no text returned');
          set({ isRefining: false });
        }
      } catch (error) {
        console.error('Refine: Error', error);
        set({ isRefining: false });
      }
    },

    // Historical transcription viewing actions
    async loadTranscriptionsForNote(noteId: string) {
      // Don't load if recording is active
      if (get().isRecording) {
        console.log('loadTranscriptionsForNote: Skipping - recording is active');
        return;
      }

      const currentViewingNoteId = get().viewingNoteId;
      const isSwitchingNotes = currentViewingNoteId !== noteId;

      // If switching to a different note, clear existing state first
      if (isSwitchingNotes) {
        console.log(
          'loadTranscriptionsForNote: Switching from',
          currentViewingNoteId,
          'to',
          noteId
        );
        set({
          displayText: '',
          historicalContent: undefined,
          selectedHistoricalId: undefined,
          historicalTranscriptions: [],
          hasUserEdits: false,
          originalDisplayText: undefined,
          // Clear partial/stable text as well
          partialText: '',
          stableText: '',
          unstableText: '',
          // Clear session references so sidebar doesn't show wrong transcription
          lastRecordingSessionId: undefined,
          hasRecording: false,
          // Clear segments array - TranscriptionViewerPlugin renders segments first
          segments: [],
        });
      }

      // Don't reload if same note and already have data
      if (!isSwitchingNotes && get().historicalTranscriptions.length > 0) {
        console.log('loadTranscriptionsForNote: Already loaded for this note');
        return;
      }

      console.log('loadTranscriptionsForNote: Loading for note', noteId);
      set({ isLoadingHistorical: true, viewingNoteId: noteId });

      try {
        const transcriptions = await window.api.transcription.listByNote(noteId);

        const historical: HistoricalTranscription[] = transcriptions.map((t) => ({
          id: t.id,
          noteId: noteId, // We know the noteId from the query
          binderId: '', // Not available from listByNote, but we have noteId
          status: t.status,
          startTime: t.start_time,
          endTime: t.end_time,
          durationMs: t.duration_ms,
          charCount: t.char_count,
          wordCount: t.word_count,
          createdAt: t.updated_at, // Use updated_at as proxy for created_at
        }));

        console.log('loadTranscriptionsForNote: Found', historical.length, 'transcriptions');

        if (historical.length === 0) {
          // No transcriptions for this note - clear display and session references
          console.log('loadTranscriptionsForNote: Clearing state for note with no transcriptions');
          set({
            historicalTranscriptions: [],
            isLoadingHistorical: false,
            displayText: '',
            historicalContent: undefined,
            selectedHistoricalId: undefined,
            // Clear lastRecordingSessionId so the sidebar doesn't show stale transcription
            lastRecordingSessionId: undefined,
            hasRecording: false,
            // Clear segments array - TranscriptionViewerPlugin renders segments first
            segments: [],
          });
          console.log(
            'loadTranscriptionsForNote: State cleared, lastRecordingSessionId is now:',
            get().lastRecordingSessionId
          );
          return;
        }

        set({
          historicalTranscriptions: historical,
          isLoadingHistorical: false,
        });

        // Auto-select the most recent transcription
        const mostRecent = historical.reduce((prev, curr) =>
          curr.createdAt > prev.createdAt ? curr : prev
        );
        await get().selectHistoricalTranscription(mostRecent.id);
      } catch (error) {
        console.error('loadTranscriptionsForNote: Error', error);
        set({
          historicalTranscriptions: [],
          isLoadingHistorical: false,
          displayText: '',
          historicalContent: undefined,
        });
      }
    },

    async selectHistoricalTranscription(sessionId: string) {
      console.log('selectHistoricalTranscription:', sessionId);
      set({ selectedHistoricalId: sessionId, isLoadingHistorical: true });

      try {
        const result = await window.api.transcription.get(sessionId);
        if (result && result.fullText) {
          console.log('selectHistoricalTranscription: Loaded content', {
            sessionId,
            textLength: result.fullText.length,
          });

          // Load segments with timecodes
          let loadedSegments: TranscriptionSegmentData[] = [];
          try {
            const segmentResult = await window.api.transcription.getSegments(sessionId);
            if (segmentResult && segmentResult.length > 0) {
              loadedSegments = segmentResult.map((seg) => ({
                segmentId: seg.segmentId,
                text: seg.text,
                startTime: seg.startTime,
                endTime: seg.endTime,
                userEdited: seg.userEdited,
                originalText: seg.originalText ?? undefined,
              }));
              console.log('selectHistoricalTranscription: Loaded segments', {
                count: loadedSegments.length,
              });
            }
          } catch (e) {
            console.warn('selectHistoricalTranscription: Failed to load segments', e);
          }

          set({
            historicalContent: result.fullText,
            displayText: result.fullText,
            segments: loadedSegments,
            isLoadingHistorical: false,
            // Also set these to allow refinement of historical transcription
            lastRecordingSessionId: sessionId,
            hasRecording: true, // Allow refine button if recording exists
          });

          // Check if recording exists for this session
          try {
            const recordingPath = await window.api.transcription.getRecordingPath(sessionId);
            set({ hasRecording: recordingPath.exists });
          } catch {
            set({ hasRecording: false });
          }
        } else {
          console.warn('selectHistoricalTranscription: No content found');
          set({
            historicalContent: '',
            isLoadingHistorical: false,
          });
        }
      } catch (error) {
        console.error('selectHistoricalTranscription: Error', error);
        set({
          historicalContent: undefined,
          isLoadingHistorical: false,
        });
      }
    },

    clearHistoricalView() {
      set({
        historicalTranscriptions: [],
        selectedHistoricalId: undefined,
        historicalContent: undefined,
        isLoadingHistorical: false,
        viewingNoteId: undefined,
      });
    },

    // Audio player actions
    async loadAudio(sessionId: string) {
      set({
        audioPlayer: {
          ...get().audioPlayer,
          isLoading: true,
          filePath: null,
        },
      });

      try {
        const result = await window.api.transcription.getRecordingWithMeta(sessionId);

        if (result.exists && result.filePath) {
          set({
            audioPlayer: {
              ...get().audioPlayer,
              filePath: result.filePath,
              durationMs: result.durationMs ?? 0,
              isLoading: false,
              currentTimeMs: 0,
              isPlaying: false,
            },
          });
        } else {
          set({
            audioPlayer: {
              ...get().audioPlayer,
              filePath: null,
              isLoading: false,
            },
          });
        }
      } catch (error) {
        console.error('Failed to load audio recording:', error);
        set({
          audioPlayer: {
            ...get().audioPlayer,
            filePath: null,
            isLoading: false,
          },
        });
      }
    },

    setAudioPlaying(playing: boolean) {
      set({
        audioPlayer: {
          ...get().audioPlayer,
          isPlaying: playing,
        },
      });
    },

    seekAudioTo(timeMs: number) {
      set({
        audioPlayer: {
          ...get().audioPlayer,
          currentTimeMs: timeMs,
        },
      });
    },

    setAudioVolume(volume: number) {
      set({
        audioPlayer: {
          ...get().audioPlayer,
          volume: Math.max(0, Math.min(1, volume)),
        },
      });
    },

    setAudioMuted(muted: boolean) {
      set({
        audioPlayer: {
          ...get().audioPlayer,
          isMuted: muted,
        },
      });
    },

    updateAudioCurrentTime(timeMs: number) {
      set({
        audioPlayer: {
          ...get().audioPlayer,
          currentTimeMs: timeMs,
        },
      });
    },

    resetAudioPlayer() {
      set({
        audioPlayer: {
          isPlaying: false,
          currentTimeMs: 0,
          durationMs: 0,
          volume: 1,
          isMuted: false,
          filePath: null,
          isLoading: false,
        },
      });
    },
  };
});

export function buildLexicalJsonFromTranscript(displayText: string, partialText: string): string {
  const combined = [displayText, partialText && partialText.trim().length > 0 ? partialText : '']
    .filter(Boolean)
    .join(' ');

  const json = {
    root: {
      children: [
        {
          type: 'paragraph',
          format: '',
          indent: 0,
          direction: 'ltr',
          version: 1,
          children: [
            {
              type: 'text',
              text: combined,
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              version: 1,
            },
          ],
        },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  } as const;
  return JSON.stringify(json);
}
