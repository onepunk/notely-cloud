/**
 * AudioMixer - Mixes microphone and system audio streams using Web Audio API.
 *
 * This service takes two MediaStreams (microphone and system audio) and combines
 * them into a single output stream at the specified sample rate. The output is
 * suitable for transcription processing with Whisper (16kHz mono).
 *
 * Additionally provides a stereo output stream for speaker attribution:
 * - Left channel (0): Microphone audio (user)
 * - Right channel (1): System audio (meeting participants)
 */
export class AudioMixer {
  private audioContext: AudioContext;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private systemSource: MediaStreamAudioSourceNode | null = null;
  private destination: MediaStreamAudioDestinationNode;
  private micGain: GainNode;
  private systemGain: GainNode;
  private disposed = false;

  // Stereo output for speaker attribution
  private stereoDestination: MediaStreamAudioDestinationNode;
  private channelMerger: ChannelMergerNode;

  /**
   * Create a new AudioMixer instance.
   * @param sampleRate - Target sample rate for output (default: 16000 for Whisper)
   */
  constructor(sampleRate: number = 16000) {
    this.audioContext = new AudioContext({ sampleRate });
    this.destination = this.audioContext.createMediaStreamDestination();

    // Create gain nodes for volume control
    this.micGain = this.audioContext.createGain();
    this.systemGain = this.audioContext.createGain();

    // Default gain values
    this.micGain.gain.value = 1.0;
    this.systemGain.gain.value = 0.8; // Slightly lower to prevent clipping when mixed

    // Connect gain nodes to destination (mono mixed output)
    this.micGain.connect(this.destination);
    this.systemGain.connect(this.destination);

    // Create stereo output for speaker attribution
    // Left channel = mic (user), Right channel = system (participants)
    this.stereoDestination = this.audioContext.createMediaStreamDestination();
    this.stereoDestination.channelCount = 2;
    this.channelMerger = this.audioContext.createChannelMerger(2);
    this.channelMerger.connect(this.stereoDestination);

    console.log('AudioMixer: Created with sample rate', sampleRate);
  }

  /**
   * Set the microphone stream to mix.
   * @param stream - MediaStream from getUserMedia
   */
  setMicrophoneStream(stream: MediaStream): void {
    if (this.disposed) {
      console.warn('AudioMixer: Cannot set microphone stream on disposed mixer');
      return;
    }

    // Disconnect existing source if any
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }

    this.micSource = this.audioContext.createMediaStreamSource(stream);
    this.micSource.connect(this.micGain);

    // Also connect to left channel (0) of stereo output for speaker attribution
    this.micSource.connect(this.channelMerger, 0, 0);

    console.log('AudioMixer: Microphone stream connected', {
      trackCount: stream.getAudioTracks().length,
      trackLabel: stream.getAudioTracks()[0]?.label,
    });
  }

  /**
   * Set the system audio stream to mix.
   * @param stream - MediaStream from electron-audio-loopback
   */
  setSystemAudioStream(stream: MediaStream): void {
    if (this.disposed) {
      console.warn('AudioMixer: Cannot set system audio stream on disposed mixer');
      return;
    }

    // Disconnect existing source if any
    if (this.systemSource) {
      this.systemSource.disconnect();
      this.systemSource = null;
    }

    this.systemSource = this.audioContext.createMediaStreamSource(stream);
    this.systemSource.connect(this.systemGain);

    // Also connect to right channel (1) of stereo output for speaker attribution
    this.systemSource.connect(this.channelMerger, 0, 1);

    console.log('AudioMixer: System audio stream connected', {
      trackCount: stream.getAudioTracks().length,
      trackLabel: stream.getAudioTracks()[0]?.label,
    });
  }

  /**
   * Get the mixed output stream (mono).
   * @returns MediaStream containing the mixed audio for transcription
   */
  getMixedStream(): MediaStream {
    return this.destination.stream;
  }

  /**
   * Get the stereo output stream for speaker attribution.
   * Left channel = microphone (user), Right channel = system audio (participants)
   * @returns MediaStream containing stereo audio
   */
  getStereoStream(): MediaStream {
    return this.stereoDestination.stream;
  }

  /**
   * Set the microphone volume.
   * @param value - Gain value (0.0 to 2.0, where 1.0 is unity gain)
   */
  setMicrophoneVolume(value: number): void {
    this.micGain.gain.value = Math.max(0, Math.min(2, value));
    console.log('AudioMixer: Microphone volume set to', this.micGain.gain.value);
  }

  /**
   * Set the system audio volume.
   * @param value - Gain value (0.0 to 2.0, where 1.0 is unity gain)
   */
  setSystemAudioVolume(value: number): void {
    this.systemGain.gain.value = Math.max(0, Math.min(2, value));
    console.log('AudioMixer: System audio volume set to', this.systemGain.gain.value);
  }

  /**
   * Get the current microphone volume.
   */
  getMicrophoneVolume(): number {
    return this.micGain.gain.value;
  }

  /**
   * Get the current system audio volume.
   */
  getSystemAudioVolume(): number {
    return this.systemGain.gain.value;
  }

  /**
   * Check if the mixer is active (has at least one input).
   */
  isActive(): boolean {
    return !this.disposed && (this.micSource !== null || this.systemSource !== null);
  }

  /**
   * Check if the mixer has been disposed.
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Dispose of the mixer and release all resources.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    console.log('AudioMixer: Disposing...');

    // Disconnect all nodes
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.systemSource) {
      this.systemSource.disconnect();
      this.systemSource = null;
    }

    this.micGain.disconnect();
    this.systemGain.disconnect();
    this.channelMerger.disconnect();

    // Close the audio context
    this.audioContext.close().catch((error) => {
      console.warn('AudioMixer: Error closing AudioContext', error);
    });

    this.disposed = true;
    console.log('AudioMixer: Disposed');
  }
}
