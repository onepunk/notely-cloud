import { buildTranscriptionConfig, getTranscriptionServerWsUrl } from '../../../../common/config';
import type { TranscriptionConfig } from '../../../../common/config';
import { AudioMixer } from '../services/AudioMixer';
import { SpeakerAttributor, SegmentWithSpeaker, Speaker } from '../services/SpeakerAttributor';

// Re-export speaker types for consumers
export type { SegmentWithSpeaker, Speaker } from '../services/SpeakerAttributor';

// Protocol v2 partial update structure
type PartialUpdate = {
  stable: { text: string; tokenCount?: number; sequence?: number; prefixLength?: number };
  unstable: { text: string; tokenCount?: number; sequence?: number; prefixLength?: number };
};

export type RefinementData = {
  segmentId: string;
  originalText: string;
  refinedText: string;
  confidenceImprovement?: number;
  timestamp: number;
};

// Language detection result from server
export type LanguageDetectionData = {
  language: string;
  confidence: number;
};

// Segment with timestamps from Whisper
export type TranscriptionSegmentData = {
  segmentId: string;
  text: string;
  startTime: number; // Start time in seconds
  endTime: number; // End time in seconds
  userEdited?: boolean;
  originalText?: string; // Original text before user edit
  speaker?: Speaker; // Speaker attribution: 'user' | 'participant' | 'both' | 'unknown'
  speakerConfidence?: number; // 0-1, confidence in speaker attribution
};

type Callbacks = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (err: Error | Event) => void;
  onPartial?: (text: string | PartialUpdate) => void;
  onFinal?: (text: string) => void;
  onFinalWithSegments?: (data: {
    fullText: string;
    segments: TranscriptionSegmentData[];
    batchFinal?: boolean;
  }) => void;
  onFinalWithSpeakers?: (data: { fullText: string; segments: SegmentWithSpeaker[] }) => void;
  onHello?: (data: {
    version: number;
    engine?: string;
    model?: string;
    device?: string;
    sessionId?: string;
  }) => void;
  onRefinement?: (data: RefinementData) => void;
  onLanguageDetected?: (data: LanguageDetectionData) => void;
};

export type TranscriptionMetadata = {
  sessionId?: string;
  binderId?: string;
  binderName?: string;
  noteId?: string;
  noteTitle?: string;
  notePreview?: string;
  language?: string;
};

type TranscriptionStreamConfig = {
  frameDurationMs: number;
  initialBufferMs: number;
};

const DEFAULT_STREAM_CONFIG: TranscriptionStreamConfig = {
  frameDurationMs: 200,
  initialBufferMs: 800,
};

type Options = {
  serverUrl?: string;
  deviceId?: string;
  metadata?: TranscriptionMetadata;
  streamConfig?: Partial<TranscriptionStreamConfig>;
  systemAudioEnabled?: boolean;
  configOverrides?: Partial<TranscriptionConfig>;
} & Callbacks;

export class TranscriptionClient {
  private ws?: WebSocket;
  private mediaStream?: MediaStream;
  private audioContext?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private workletNode?: AudioWorkletNode;
  private gainNode?: GainNode;
  private processorNode?: ScriptProcessorNode;
  private pendingSamples: number[] = [];
  private metadataSent = false;
  private configSent = false;
  private isStopping = false;
  private initialBufferReleased = false;
  private awaitingFinal?: Promise<void>;
  private resolveAwaitingFinal?: () => void;

  // WAV recording - accumulate all PCM16 data for second-pass refinement
  private recordedPcmChunks: ArrayBuffer[] = [];
  private recordingSessionId?: string;
  private recordingStartTime?: number;

  // System audio capture
  private audioMixer?: AudioMixer;
  private systemAudioStream?: MediaStream;

  // Stereo recording for speaker attribution
  private stereoRecordingChunks: Float32Array[] = [];
  private stereoAudioContext?: AudioContext;
  private stereoProcessor?: ScriptProcessorNode;

  // Audio diagnostics
  private audioLevelSamples: number[] = [];
  private lastAudioLevelLog = 0;
  private readonly audioLevelLogIntervalMs = 5000; // Log every 5 seconds
  private totalBytesSent = 0;
  private lastDataFlowLog = 0;
  private readonly dataFlowLogIntervalMs = 10000; // Log every 10 seconds
  private bytesAtLastLog = 0;

  private readonly options: Options;
  private readonly targetSampleRate = 16000;
  private readonly streamConfig: TranscriptionStreamConfig;
  private readonly frameSamples: number;
  private readonly initialBufferSamples: number;
  private currentStable: string = '';

  constructor(options: Options) {
    this.options = options;
    this.streamConfig = this.buildStreamConfig(options.streamConfig);
    this.frameSamples = this.calculateSamplesFromMs(this.streamConfig.frameDurationMs);
    this.initialBufferSamples = Math.max(
      this.frameSamples,
      this.calculateSamplesFromMs(this.streamConfig.initialBufferMs)
    );
  }

  private getUrl(): string {
    return this.options.serverUrl || getTranscriptionServerWsUrl();
  }

  async start(): Promise<void> {
    this.isStopping = false;
    this.metadataSent = false;
    this.configSent = false;
    this.pendingSamples = [];
    this.initialBufferReleased = false;
    this.awaitingFinal = undefined;
    this.resolveAwaitingFinal = undefined;

    // Reset audio diagnostics
    this.audioLevelSamples = [];
    this.lastAudioLevelLog = Date.now();
    this.totalBytesSent = 0;
    this.lastDataFlowLog = Date.now();
    this.bytesAtLastLog = 0;

    // Initialize WAV recording
    this.recordedPcmChunks = [];
    this.recordingSessionId = this.options.metadata?.sessionId;
    this.recordingStartTime = Date.now();

    // Initialize stereo recording for speaker attribution
    this.stereoRecordingChunks = [];

    console.log('TranscriptionClient: Starting transcription session');
    console.log('TranscriptionClient: stream config', this.streamConfig, {
      frameSamples: this.frameSamples,
      initialBufferSamples: this.initialBufferSamples,
    });

    await this.initWebSocket();
    if (this.isStopping) return;

    await this.captureMicrophone();
    if (this.isStopping) return;

    // Capture and mix system audio if enabled
    if (this.options.systemAudioEnabled) {
      await this.captureAndMixSystemAudio();
      if (this.isStopping) return;
    }

    await this.setupAudioGraph();
    console.log('TranscriptionClient: Session started successfully');
  }

  /**
   * Capture system audio and mix it with the microphone stream.
   * This enables transcription of meeting participants when the user has headphones on.
   */
  private async captureAndMixSystemAudio(): Promise<void> {
    console.log('TranscriptionClient: Attempting to capture system audio');

    try {
      // Check if system audio is supported
      const supported = await window.api.systemAudio.isSupported();
      if (!supported) {
        const error = await window.api.systemAudio.getInitError();
        console.warn('TranscriptionClient: System audio not supported', { error });
        return;
      }

      // Get the system audio stream
      this.systemAudioStream = await window.api.systemAudio.getLoopbackStream();
      console.log('TranscriptionClient: System audio stream acquired', {
        trackCount: this.systemAudioStream.getAudioTracks().length,
        trackLabel: this.systemAudioStream.getAudioTracks()[0]?.label,
      });

      // Create audio mixer and combine streams
      if (this.mediaStream) {
        this.audioMixer = new AudioMixer(this.targetSampleRate);
        this.audioMixer.setMicrophoneStream(this.mediaStream);
        this.audioMixer.setSystemAudioStream(this.systemAudioStream);

        // Replace the media stream with the mixed stream
        this.mediaStream = this.audioMixer.getMixedStream();
        console.log('TranscriptionClient: Audio streams mixed successfully');

        // Set up stereo recording for speaker attribution
        this.setupStereoRecording();
      }
    } catch (error) {
      console.error('TranscriptionClient: Failed to capture system audio', {
        error: error instanceof Error ? error.message : error,
      });
      // Continue with microphone-only transcription
    }
  }

  /**
   * Set up stereo recording from the audio mixer for speaker attribution.
   * Records interleaved stereo data: [L0, R0, L1, R1, ...]
   * Left channel = mic (user), Right channel = system (participants)
   */
  private setupStereoRecording(): void {
    if (!this.audioMixer) {
      console.warn('TranscriptionClient: Cannot setup stereo recording without audio mixer');
      return;
    }

    try {
      const stereoStream = this.audioMixer.getStereoStream();
      this.stereoAudioContext = new AudioContext({ sampleRate: this.targetSampleRate });
      const stereoSource = this.stereoAudioContext.createMediaStreamSource(stereoStream);

      // Use ScriptProcessorNode for recording (deprecated but widely supported)
      // Buffer size of 4096 for efficient processing
      this.stereoProcessor = this.stereoAudioContext.createScriptProcessor(4096, 2, 2);

      this.stereoProcessor.onaudioprocess = (event) => {
        const left = event.inputBuffer.getChannelData(0);
        const right = event.inputBuffer.getChannelData(1);

        // Interleave stereo data: [L0, R0, L1, R1, ...]
        const interleaved = new Float32Array(left.length * 2);
        for (let i = 0; i < left.length; i++) {
          interleaved[i * 2] = left[i];
          interleaved[i * 2 + 1] = right[i];
        }
        this.stereoRecordingChunks.push(interleaved);
      };

      stereoSource.connect(this.stereoProcessor);
      // Connect to destination to keep processing active (muted via gain=0)
      const muteGain = this.stereoAudioContext.createGain();
      muteGain.gain.value = 0;
      this.stereoProcessor.connect(muteGain);
      muteGain.connect(this.stereoAudioContext.destination);

      console.log('TranscriptionClient: Stereo recording setup complete');
    } catch (error) {
      console.error('TranscriptionClient: Failed to setup stereo recording', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  private async initWebSocket(): Promise<void> {
    const url = this.getUrl();
    console.log('TranscriptionClient: Attempting to connect to', url);

    await new Promise<void>((resolve, reject) => {
      try {
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          console.log('TranscriptionClient: WebSocket connected');
          // Protocol v2: Send config message FIRST (before any audio)
          this.sendConfig();
          // Backward compatibility: Still send metadata if provided
          this.sendMetadata();
          this.options.onOpen?.();
          resolve();
        };

        ws.onerror = (e) => {
          console.error('TranscriptionClient: WebSocket error:', e);
          this.options.onError?.(e);
          reject(new Error('WebSocket connection failed'));
        };

        ws.onmessage = (evt) => {
          try {
            const payload =
              typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data);
            const data = JSON.parse(payload);

            // Protocol v2: Check for message type
            if (data?.type) {
              switch (data.type) {
                case 'hello':
                  console.log('TranscriptionClient: Received hello message (Protocol v2)', data);
                  this.options.onHello?.({
                    version: data.version ?? 2,
                    engine: data.engine,
                    model: data.model,
                    device: data.device,
                    sessionId: data.sessionId,
                  });
                  break;

                case 'partial':
                  // Protocol v2 partial message with optional delta fields
                  if (data.text !== undefined) {
                    const prefixLength = data.prefixLength ?? 0;
                    const tail = data.text ?? '';
                    const sequence = data.sequence;
                    const mergedStable =
                      prefixLength > 0
                        ? (this.currentStable.slice(0, prefixLength) + tail).trim()
                        : (tail || this.currentStable).trim();
                    this.currentStable = mergedStable;

                    console.log('TranscriptionClient: Received partial text (delta)', {
                      segmentId: data.segmentId,
                      prefixLength,
                      tailLength: tail.length,
                      mergedLength: mergedStable.length,
                      sequence,
                    });

                    // Split at committedLength: committed text is stable, remainder is speculative
                    const committedLength = data.committedLength ?? mergedStable.length;
                    const stableText = mergedStable.slice(0, committedLength).trim();
                    const unstableText = mergedStable.slice(committedLength).trim();

                    const partialUpdate: PartialUpdate = {
                      stable: { text: stableText, tokenCount: 0, sequence, prefixLength },
                      unstable: { text: unstableText, tokenCount: 0, sequence, prefixLength },
                    };
                    this.options.onPartial?.(partialUpdate);
                  } else if (data.stable || data.unstable) {
                    // Legacy format (stable/unstable full text)
                    const partialUpdate: PartialUpdate = {
                      stable: data.stable ?? { text: '', tokenCount: 0 },
                      unstable: data.unstable ?? { text: '', tokenCount: 0 },
                    };
                    this.currentStable = partialUpdate.stable.text ?? this.currentStable;
                    this.options.onPartial?.(partialUpdate);
                  }
                  break;

                case 'final': {
                  // Protocol v2 final message (single segment)
                  const finalText = data.text ?? '';
                  console.log(
                    'TranscriptionClient: Received final text',
                    JSON.stringify(
                      {
                        segmentId: data.segmentId,
                        text: finalText,
                        textLength: finalText.length,
                        confidence: data.confidence,
                        prefixLength: data.prefixLength,
                        sequence: data.sequence,
                      },
                      null,
                      2
                    )
                  );

                  console.log(
                    '[FINAL RECEIVED] Text:',
                    finalText?.substring(0, 100) + '...',
                    'Length:',
                    finalText.length
                  );

                  if (finalText) {
                    // Apply prefixLength delta if provided
                    const prefixLength = data.prefixLength ?? 0;
                    const mergedFinal =
                      prefixLength > 0
                        ? (this.currentStable.slice(0, prefixLength) + finalText).trim()
                        : finalText.trim();
                    this.currentStable = '';
                    this.options.onFinal?.(mergedFinal);
                  }
                  this.resolveFinalAwaiter();
                  break;
                }

                case 'final_batch': {
                  // Protocol v2 batched final message (multiple segments with timestamps)
                  const segments = data.segments ?? [];
                  const totalSegments = data.totalSegments ?? segments.length;
                  const fullText = data.fullText ?? '';
                  const batchFinal = data.batchFinal === true;

                  console.log(
                    'TranscriptionClient: Received final_batch',
                    JSON.stringify(
                      {
                        totalSegments: totalSegments,
                        segmentsReceived: segments.length,
                        hasFullText: !!fullText,
                        fullTextLength: fullText.length,
                      },
                      null,
                      2
                    )
                  );

                  // Build segments with timestamps
                  const segmentsWithTimestamps: TranscriptionSegmentData[] = [];
                  for (const segment of segments) {
                    const segmentText = segment.text ?? '';
                    if (segmentText) {
                      console.log(
                        'TranscriptionClient: Processing batched segment',
                        JSON.stringify(
                          {
                            segmentId: segment.segmentId,
                            text: segmentText.substring(0, 50),
                            textLength: segmentText.length,
                            startTime: segment.startTime,
                            endTime: segment.endTime,
                          },
                          null,
                          2
                        )
                      );

                      segmentsWithTimestamps.push({
                        segmentId: segment.segmentId ?? '',
                        text: segmentText,
                        startTime: segment.startTime ?? 0,
                        endTime: segment.endTime ?? 0,
                        userEdited: false,
                      });
                    }
                  }

                  // Use fullText if provided, otherwise join segment texts
                  const finalText = fullText || segmentsWithTimestamps.map((s) => s.text).join(' ');

                  console.log(
                    '[FINAL RECEIVED] Full text:',
                    finalText?.substring(0, 100) + '...',
                    'Length:',
                    finalText.length,
                    'Segments:',
                    segmentsWithTimestamps.length
                  );

                  this.currentStable = '';

                  // Apply speaker attribution if system audio is enabled and we have stereo data
                  if (
                    this.options.systemAudioEnabled &&
                    this.stereoRecordingChunks.length > 0 &&
                    segmentsWithTimestamps.length > 0
                  ) {
                    try {
                      const speakerAttributor = new SpeakerAttributor(this.targetSampleRate);
                      const stereoData = this.concatenateStereoChunks();
                      speakerAttributor.loadStereoData(stereoData);

                      const segmentsWithSpeakers =
                        speakerAttributor.attributeAllSegments(segmentsWithTimestamps);

                      // Update segments with speaker info
                      for (let i = 0; i < segmentsWithTimestamps.length; i++) {
                        segmentsWithTimestamps[i].speaker = segmentsWithSpeakers[i].speaker;
                        segmentsWithTimestamps[i].speakerConfidence =
                          segmentsWithSpeakers[i].speakerConfidence;
                      }

                      // Call onFinalWithSpeakers if provided
                      if (this.options.onFinalWithSpeakers) {
                        this.options.onFinalWithSpeakers({
                          fullText: finalText,
                          segments: segmentsWithSpeakers,
                        });
                      }

                      speakerAttributor.dispose();
                      console.log('TranscriptionClient: Speaker attribution applied');
                    } catch (error) {
                      console.error('TranscriptionClient: Speaker attribution failed', {
                        error: error instanceof Error ? error.message : error,
                      });
                    }
                  }

                  // Call callback with segments (may have speaker data attached)
                  if (this.options.onFinalWithSegments) {
                    this.options.onFinalWithSegments({
                      fullText: finalText,
                      segments: segmentsWithTimestamps,
                      batchFinal,
                    });
                  } else {
                    // Fallback to old callback for backward compatibility
                    this.options.onFinal?.(finalText);
                  }

                  console.log(
                    'TranscriptionClient: All batched segments processed, resolving awaiter'
                  );
                  this.resolveFinalAwaiter();
                  break;
                }

                case 'refinement': {
                  const refinementData: RefinementData = {
                    segmentId: data.segmentId ?? '',
                    originalText: data.originalText ?? '',
                    refinedText: data.refinedText ?? '',
                    confidenceImprovement: data.confidenceImprovement,
                    timestamp: data.timestamp ?? Date.now(),
                  };
                  console.log('TranscriptionClient: Received refinement', {
                    segmentId: refinementData.segmentId,
                    originalText: refinementData.originalText,
                    refinedText: refinementData.refinedText,
                    confidenceImprovement: refinementData.confidenceImprovement,
                  });
                  this.options.onRefinement?.(refinementData);
                  break;
                }

                case 'languageDetected': {
                  const languageData: LanguageDetectionData = {
                    language: data.language ?? 'en',
                    confidence: data.confidence ?? 0,
                  };
                  console.log('TranscriptionClient: Received language detection', {
                    language: languageData.language,
                    confidence: languageData.confidence,
                  });
                  this.options.onLanguageDetected?.(languageData);
                  break;
                }

                default:
                  console.warn('TranscriptionClient: Unknown Protocol v2 message type:', data.type);
              }
            } else {
              // Protocol v1: Legacy format
              const isPartial = !!data?.is_partial;
              const text = data?.data?.text ?? '';
              if (!text) return;
              console.log('TranscriptionClient: Received Protocol v1 message', {
                isPartial,
                text,
                textLength: text.length,
              });
              if (isPartial) this.options.onPartial?.(text);
              else {
                this.options.onFinal?.(text);
                this.resolveFinalAwaiter();
              }
            }
          } catch (err) {
            console.warn('TranscriptionClient: Failed to parse message', err);
          }
        };
        ws.onclose = (e) => {
          console.log('TranscriptionClient: WebSocket closed:', e.code, e.reason);
          this.options.onClose?.();
          this.resolveFinalAwaiter();
        };
      } catch (err) {
        console.error('TranscriptionClient: Error creating WebSocket:', err);
        reject(err);
      }
    });
  }

  private async captureMicrophone(): Promise<void> {
    const constraints: MediaStreamConstraints = {
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true,
        ...(this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : {}),
      },
      video: false,
    };

    console.log('TranscriptionClient: Requesting microphone access with constraints:', constraints);

    try {
      // Check if getUserMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const error = new Error('getUserMedia is not supported in this browser');
        console.error('TranscriptionClient: getUserMedia not available', {
          mediaDevices: !!navigator.mediaDevices,
          getUserMedia: !!navigator.mediaDevices?.getUserMedia,
        });
        throw error;
      }

      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (firstAttemptError) {
        const err = firstAttemptError as Error;
        // If a specific device was requested and it failed, retry with the system default
        if (
          this.options.deviceId &&
          (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')
        ) {
          console.warn(
            'TranscriptionClient: Device "%s" unavailable (%s), falling back to default microphone',
            this.options.deviceId,
            err.name
          );
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              channelCount: 1,
              noiseSuppression: true,
              echoCancellation: true,
              autoGainControl: true,
            },
            video: false,
          });
        } else {
          throw firstAttemptError;
        }
      }

      // Log successful stream acquisition
      const audioTracks = this.mediaStream.getAudioTracks();
      console.log('TranscriptionClient: Microphone access granted successfully', {
        trackCount: audioTracks.length,
        tracks: audioTracks.map((track) => ({
          id: track.id,
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
          settings: track.getSettings(),
        })),
      });
    } catch (err) {
      // Enhanced error logging with detailed diagnostics
      const error = err as Error;
      console.error('TranscriptionClient: Failed to capture microphone', {
        errorName: error.name,
        errorMessage: error.message,
        errorType: error.constructor.name,
        requestedDeviceId: this.options.deviceId,
        constraints: constraints,
      });

      // Log specific error types with helpful messages
      if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
        console.error(
          'TranscriptionClient: Microphone permission was denied by the user or browser settings'
        );
      } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        console.error(
          'TranscriptionClient: No microphone device found or requested device ID does not exist'
        );
      } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        console.error(
          'TranscriptionClient: Microphone is already in use by another application or hardware error'
        );
      } else if (error.name === 'OverconstrainedError') {
        console.error('TranscriptionClient: Microphone constraints cannot be satisfied', {
          constraint: (error as OverconstrainedError).constraint,
        });
      } else if (error.name === 'SecurityError') {
        console.error(
          'TranscriptionClient: Security error - feature may be blocked by permissions policy'
        );
      } else {
        console.error('TranscriptionClient: Unknown error during microphone capture');
      }

      this.options.onError?.(error);
      throw error;
    }
  }

  private async setupAudioGraph(): Promise<void> {
    if (!this.mediaStream) {
      throw new Error('TranscriptionClient: Media stream not available');
    }

    console.log('TranscriptionClient: Setting up audio graph');

    // Do NOT force a specific sampleRate — let Chrome use the hardware's native
    // rate (usually 44100 or 48000).  Forcing 16 kHz causes Chromium to
    // resample at the MediaStreamSource level, which can stall the audio
    // rendering thread in some Electron / Chromium builds.  The AudioWorklet
    // already handles downsampling to 16 kHz internally.
    this.audioContext = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )();

    console.log('TranscriptionClient: AudioContext created', {
      sampleRate: this.audioContext.sampleRate,
      state: this.audioContext.state,
      baseLatency: this.audioContext.baseLatency,
      outputLatency: (this.audioContext as AudioContext & { outputLatency?: number }).outputLatency,
    });

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    console.log('TranscriptionClient: MediaStreamSource created', {
      numberOfInputs: this.sourceNode.numberOfInputs,
      numberOfOutputs: this.sourceNode.numberOfOutputs,
      channelCount: this.sourceNode.channelCount,
      channelCountMode: this.sourceNode.channelCountMode,
    });

    try {
      const workletLoaded = await this.setupWorkletGraph();
      if (workletLoaded) {
        console.log('TranscriptionClient: AudioWorklet successfully initialized');
        return;
      }

      console.warn('TranscriptionClient: AudioWorklet unavailable, using ScriptProcessor fallback');
    } catch (error) {
      console.warn('TranscriptionClient: Failed to initialise AudioWorklet, using fallback', error);
    }

    this.setupScriptProcessorFallback();
  }

  private async setupWorkletGraph(): Promise<boolean> {
    if (!this.audioContext || !this.sourceNode) return false;
    if (!this.audioContext.audioWorklet) return false;

    // Load the pre-compiled worklet from the public/ directory.
    // Using a relative URL ensures it resolves correctly for both:
    // - file:// protocol (built files) → file:///path/to/dist/renderer/transcriptionRecorder.worklet.js
    // - http:// protocol (Vite dev server) → http://localhost:5173/transcriptionRecorder.worklet.js
    const workletUrl = new URL('transcriptionRecorder.worklet.js', document.baseURI).href;
    await this.audioContext.audioWorklet.addModule(workletUrl);

    this.workletNode = new AudioWorkletNode(this.audioContext, 'transcription-recorder');
    this.workletNode.port.onmessage = this.handleWorkletMessage;

    this.gainNode = this.audioContext.createGain();
    // Use a near-zero but non-zero gain to prevent Chromium from optimising
    // away the audio rendering thread when it detects silence at the output.
    this.gainNode.gain.value = 1e-6;

    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);
    return true;
  }

  private setupScriptProcessorFallback(): void {
    if (!this.audioContext || !this.sourceNode) return;
    const bufferSize = 2048;
    const inputSampleRate = this.audioContext.sampleRate;
    if (Math.abs(inputSampleRate - this.targetSampleRate) > 1) {
      console.warn(
        'TranscriptionClient: Fallback sample rate mismatch',
        inputSampleRate,
        'expected',
        this.targetSampleRate
      );
    }
    this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    this.processorNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const floatChunk = new Float32Array(input);
      const normalized = this.resampleChunk(floatChunk, inputSampleRate);
      this.enqueueSamples(normalized);
    };
    this.sourceNode.connect(this.processorNode);

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 1e-6;
    this.processorNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);
  }

  private handleWorkletMessage = (
    event: MessageEvent<ArrayBuffer | Float32Array | Record<string, unknown>>
  ): void => {
    // Handle diagnostic messages from the worklet
    if (
      event.data &&
      typeof event.data === 'object' &&
      'type' in event.data &&
      (event.data as Record<string, unknown>).type === 'diag'
    ) {
      // Worklet diagnostics are high-frequency (~every 2s); suppress from console
      return;
    }
    const data =
      event.data instanceof ArrayBuffer
        ? new Float32Array(event.data)
        : (event.data as Float32Array).slice();
    this.enqueueSamples(data);
  };

  private enqueueSamples(chunk: Float32Array): void {
    if (!chunk || chunk.length === 0) return;

    // Calculate and track audio levels
    this.trackAudioLevel(chunk);

    for (let i = 0; i < chunk.length; i += 1) {
      this.pendingSamples.push(chunk[i]);
    }

    if (!this.initialBufferReleased) {
      if (this.pendingSamples.length < this.initialBufferSamples) {
        return;
      }
      console.log('TranscriptionClient: Releasing initial audio buffer', {
        samples: this.initialBufferSamples,
        durationMs: (this.initialBufferSamples / this.targetSampleRate) * 1000,
      });
      const initialSegment = this.pendingSamples.splice(0, this.initialBufferSamples);
      const initialBuffer = this.convertToPCM16(new Float32Array(initialSegment));
      this.sendPcmBuffer(initialBuffer);
      this.initialBufferReleased = true;
    }

    while (this.pendingSamples.length >= this.frameSamples) {
      const segment = this.pendingSamples.splice(0, this.frameSamples);
      const pcmBuffer = this.convertToPCM16(new Float32Array(segment));
      this.sendPcmBuffer(pcmBuffer);
    }
  }

  private resampleChunk(input: Float32Array, inputSampleRate: number): Float32Array {
    if (inputSampleRate <= this.targetSampleRate || inputSampleRate === 0) {
      return input.slice();
    }
    const sampleRateRatio = inputSampleRate / this.targetSampleRate;
    const newLength = Math.floor(input.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i += 1) {
        accum += input[i];
        count += 1;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult += 1;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  private convertToPCM16(data: Float32Array): ArrayBuffer {
    const pcm16 = new Int16Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, data[i]));
      pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return pcm16.buffer;
  }

  private sendPcmBuffer(buffer: ArrayBuffer): void {
    // Always accumulate for WAV recording, even if WebSocket isn't open
    this.recordedPcmChunks.push(buffer.slice(0));

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('TranscriptionClient: Cannot send audio - WebSocket not open', {
        wsExists: !!this.ws,
        readyState: this.ws?.readyState,
      });
      return;
    }

    // Don't send audio until config is sent (Protocol v2 requirement)
    if (!this.configSent) {
      console.warn('TranscriptionClient: Cannot send audio - config not sent yet');
      return;
    }

    try {
      // Protocol v2: Send audio as base64-encoded JSON message
      // Convert ArrayBuffer to base64
      const uint8Array = new Uint8Array(buffer);
      const binaryString = Array.from(uint8Array)
        .map((byte) => String.fromCharCode(byte))
        .join('');
      const base64Audio = btoa(binaryString);

      const payload = {
        type: 'audio',
        bytes: base64Audio,
      };

      this.ws.send(JSON.stringify(payload));

      // Track data flow metrics
      this.totalBytesSent += buffer.byteLength;
      this.logDataFlowMetrics();
    } catch (error) {
      console.error('TranscriptionClient: Failed to send audio buffer', {
        bufferSize: buffer.byteLength,
        error: error,
      });
      this.options.onError?.(error as Error);
    }
  }

  private sendConfig(): void {
    if (this.configSent) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      // Protocol v2: Send config message with merged overrides
      const config = buildTranscriptionConfig(this.options.configOverrides ?? {});
      // Normalize language: 'auto' → null for server compatibility.
      // faster-whisper accepts null for auto-detection but rejects the string 'auto'.
      const serverConfig = {
        ...config,
        language: config.language === 'auto' ? null : config.language,
      };
      const payload = {
        type: 'config',
        config: serverConfig,
      };
      console.log('TranscriptionClient: Sending config (Protocol v2)', payload);
      this.ws.send(JSON.stringify(payload));
      this.configSent = true;
    } catch (error) {
      console.error('TranscriptionClient: Failed to send config', error);
      this.options.onError?.(error as Error);
    }
  }

  private sendMetadata(): void {
    if (this.metadataSent) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.options.metadata) return;

    try {
      const payload = {
        type: 'metadata',
        data: {
          ...this.options.metadata,
          sentAt: new Date().toISOString(),
          sampleRate: this.targetSampleRate,
        },
      };
      this.ws.send(JSON.stringify(payload));
      this.metadataSent = true;
    } catch (error) {
      console.warn('TranscriptionClient: Failed to send metadata', error);
    }
  }

  private flushPendingSamples(force = false): void {
    if (!force || this.pendingSamples.length === 0) return;
    const segment = new Float32Array(this.pendingSamples.splice(0));
    const buffer = this.convertToPCM16(segment);
    this.sendPcmBuffer(buffer);
  }

  async stop(): Promise<void> {
    console.log('TranscriptionClient: Stopping transcription session', {
      totalBytesSent: this.totalBytesSent,
      pendingSamples: this.pendingSamples.length,
    });

    this.isStopping = true;
    this.flushPendingSamples(true);

    let finalAwait: Promise<void> | undefined;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      finalAwait = this.createFinalAwaiter();
      try {
        // Protocol v2: Send stop message
        const payload = { type: 'stop' };
        console.log('TranscriptionClient: Sending stop message (Protocol v2)');
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        console.warn('TranscriptionClient: Failed to send stop message', error);
        finalAwait = undefined;
      }
    }

    try {
      if (this.workletNode) {
        this.workletNode.port.onmessage = null;
      }
      this.workletNode?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.processorNode?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.gainNode?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* noop */
    }
    try {
      await this.audioContext?.close();
    } catch {
      /* noop */
    }
    try {
      this.mediaStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    // Clean up system audio resources
    try {
      this.systemAudioStream?.getTracks().forEach((t) => t.stop());
    } catch {
      /* noop */
    }
    try {
      this.audioMixer?.dispose();
    } catch {
      /* noop */
    }
    // Clean up stereo recording resources
    try {
      this.stereoProcessor?.disconnect();
    } catch {
      /* noop */
    }
    try {
      await this.stereoAudioContext?.close();
    } catch {
      /* noop */
    }

    if (finalAwait) {
      try {
        // Give the server time to run the final transcription pass.
        // The server must: (1) finish any in-flight streaming transcription (~2-3s),
        // then (2) re-transcribe ALL audio in batch mode (RTF ~0.07x on Apple Silicon).
        // Scale timeout based on audio sent: at least 15s, plus ~0.15x the recording
        // duration to cover batch processing with headroom.
        const estimatedDurationSec = this.totalBytesSent / 32000; // 16kHz mono PCM16
        const timeoutMs = Math.max(15000, Math.ceil(estimatedDurationSec * 150));
        await Promise.race([finalAwait, this.delay(timeoutMs)]);
      } catch {
        /* noop */
      }
    }
    this.resolveFinalAwaiter();
    try {
      if (this.ws) {
        this.ws.close(1000, 'client stop');
      }
    } catch {
      /* noop */
    }

    this.mediaStream = undefined;
    this.audioContext = undefined;
    this.sourceNode = undefined;
    this.workletNode = undefined;
    this.gainNode = undefined;
    this.processorNode = undefined;
    this.ws = undefined;
    this.pendingSamples = [];
    this.metadataSent = false;
    this.configSent = false;
    this.initialBufferReleased = false;
    this.awaitingFinal = undefined;
    this.resolveAwaitingFinal = undefined;
    this.systemAudioStream = undefined;
    this.audioMixer = undefined;
    this.stereoRecordingChunks = [];
    this.stereoAudioContext = undefined;
    this.stereoProcessor = undefined;
  }

  private createFinalAwaiter(): Promise<void> {
    if (!this.awaitingFinal) {
      this.awaitingFinal = new Promise<void>((resolve) => {
        this.resolveAwaitingFinal = resolve;
      });
    }
    return this.awaitingFinal;
  }

  private resolveFinalAwaiter(): void {
    if (this.resolveAwaitingFinal) {
      this.resolveAwaitingFinal();
    }
    this.awaitingFinal = undefined;
    this.resolveAwaitingFinal = undefined;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (ms <= 0) resolve();
      else setTimeout(resolve, ms);
    });
  }

  /**
   * Concatenate all stereo recording chunks into a single Float32Array.
   * Used for speaker attribution analysis.
   */
  private concatenateStereoChunks(): Float32Array {
    const totalLength = this.stereoRecordingChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.stereoRecordingChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    console.log('TranscriptionClient: Concatenated stereo chunks', {
      chunks: this.stereoRecordingChunks.length,
      totalSamples: totalLength / 2, // Divide by 2 for interleaved stereo
      durationSec: totalLength / 2 / this.targetSampleRate,
    });
    return result;
  }

  private buildStreamConfig(input?: Partial<TranscriptionStreamConfig>): TranscriptionStreamConfig {
    const merged = {
      ...DEFAULT_STREAM_CONFIG,
      ...(input ?? {}),
    };

    const frameDurationMs = this.clampNumber(merged.frameDurationMs, 80, 1000);
    const initialBufferMs = this.clampNumber(merged.initialBufferMs, frameDurationMs, 4000);

    return {
      frameDurationMs,
      initialBufferMs,
    };
  }

  private calculateSamplesFromMs(durationMs: number): number {
    const samples = Math.round((this.targetSampleRate * durationMs) / 1000);
    return Math.max(1, samples);
  }

  private clampNumber(value: number, min: number, max: number): number {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return min;
    }
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Calculate RMS (root mean square) audio level from samples
   */
  private calculateRMS(samples: Float32Array): number {
    if (samples.length === 0) return 0;

    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSquares += samples[i] * samples[i];
    }

    return Math.sqrt(sumSquares / samples.length);
  }

  /**
   * Track audio level and periodically log diagnostics
   */
  private trackAudioLevel(chunk: Float32Array): void {
    const rms = this.calculateRMS(chunk);
    this.audioLevelSamples.push(rms);

    const now = Date.now();
    if (now - this.lastAudioLevelLog >= this.audioLevelLogIntervalMs) {
      this.logAudioLevelMetrics();
      this.lastAudioLevelLog = now;
      this.audioLevelSamples = []; // Reset for next interval
    }
  }

  /**
   * Log audio level metrics including RMS, peak, and silence detection
   */
  private logAudioLevelMetrics(): void {
    if (this.audioLevelSamples.length === 0) return;

    const avgRMS =
      this.audioLevelSamples.reduce((sum, val) => sum + val, 0) / this.audioLevelSamples.length;
    const maxRMS = Math.max(...this.audioLevelSamples);
    const minRMS = Math.min(...this.audioLevelSamples);

    // Convert to dB (20 * log10(rms))
    const avgDB = avgRMS > 0 ? 20 * Math.log10(avgRMS) : -Infinity;
    const maxDB = maxRMS > 0 ? 20 * Math.log10(maxRMS) : -Infinity;

    // Detect silence (very low audio levels)
    const silenceThreshold = 0.01; // RMS threshold for silence
    const silentSamples = this.audioLevelSamples.filter((rms) => rms < silenceThreshold).length;
    const silencePercent = (silentSamples / this.audioLevelSamples.length) * 100;

    console.log('TranscriptionClient: Audio level metrics', {
      avgRMS: avgRMS.toFixed(4),
      maxRMS: maxRMS.toFixed(4),
      minRMS: minRMS.toFixed(4),
      avgDB: avgDB.toFixed(2) + ' dB',
      maxDB: maxDB.toFixed(2) + ' dB',
      silencePercent: silencePercent.toFixed(1) + '%',
      sampleCount: this.audioLevelSamples.length,
    });

    // Warn if audio is consistently silent or very low
    if (silencePercent > 90) {
      console.warn('TranscriptionClient: Audio levels are very low or silent (>90% silence)', {
        silencePercent: silencePercent.toFixed(1) + '%',
        avgRMS: avgRMS.toFixed(4),
      });
    }
  }

  /**
   * Log data flow metrics including bytes sent and send rate
   */
  private logDataFlowMetrics(): void {
    const now = Date.now();
    if (now - this.lastDataFlowLog >= this.dataFlowLogIntervalMs) {
      const timeDeltaSeconds = (now - this.lastDataFlowLog) / 1000;
      const bytesDelta = this.totalBytesSent - this.bytesAtLastLog;
      const sendRateKBps = bytesDelta / 1024 / timeDeltaSeconds;

      console.log('TranscriptionClient: Data flow metrics', {
        totalBytesSent: this.totalBytesSent,
        sendRateKBps: sendRateKBps.toFixed(2) + ' KB/s',
        intervalSeconds: timeDeltaSeconds.toFixed(1),
      });

      this.lastDataFlowLog = now;
      this.bytesAtLastLog = this.totalBytesSent;
    }
  }

  /**
   * Get the recorded audio as a WAV file ArrayBuffer
   * PCM16 mono at 16kHz sample rate
   */
  getRecordedWavData(): ArrayBuffer | null {
    if (this.recordedPcmChunks.length === 0) {
      console.warn('TranscriptionClient: No recorded audio chunks');
      return null;
    }

    // Calculate total PCM data size
    const totalPcmBytes = this.recordedPcmChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

    if (totalPcmBytes === 0) {
      console.warn('TranscriptionClient: Recorded audio is empty');
      return null;
    }

    console.log('TranscriptionClient: Creating WAV from recorded audio', {
      chunks: this.recordedPcmChunks.length,
      totalPcmBytes,
      durationMs: (totalPcmBytes / 2 / this.targetSampleRate) * 1000,
    });

    // WAV header is 44 bytes
    const wavBuffer = new ArrayBuffer(44 + totalPcmBytes);
    const view = new DataView(wavBuffer);

    // WAV header parameters
    const numChannels = 1;
    const sampleRate = this.targetSampleRate;
    const bitsPerSample = 16;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);

    // Write WAV header
    // "RIFF" chunk descriptor
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + totalPcmBytes, true); // File size - 8
    this.writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // "data" sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, totalPcmBytes, true);

    // Copy PCM data after header
    const wavUint8 = new Uint8Array(wavBuffer);
    let offset = 44;
    for (const chunk of this.recordedPcmChunks) {
      wavUint8.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }

    return wavBuffer;
  }

  /**
   * Helper to write a string to DataView
   */
  private writeString(view: DataView, offset: number, str: string): void {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /**
   * Get the recording session ID
   */
  getRecordingSessionId(): string | undefined {
    return this.recordingSessionId;
  }

  /**
   * Get recording duration in milliseconds
   */
  getRecordingDurationMs(): number {
    if (!this.recordingStartTime) return 0;
    const totalPcmBytes = this.recordedPcmChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    // PCM16 at 16kHz: 2 bytes per sample, 16000 samples per second
    return (totalPcmBytes / 2 / this.targetSampleRate) * 1000;
  }

  /**
   * Check if recording has any audio data
   */
  hasRecordedAudio(): boolean {
    return (
      this.recordedPcmChunks.length > 0 &&
      this.recordedPcmChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) > 0
    );
  }
}
