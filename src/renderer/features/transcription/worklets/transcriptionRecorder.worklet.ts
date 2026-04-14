/// <reference lib="webworker" />
/* eslint-disable no-restricted-globals */

const TARGET_SAMPLE_RATE = 16000;
const DEFAULT_BUFFER_SAMPLES = 1920; // ~120ms at 16kHz after downsampling

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;

declare const sampleRate: number;

type TypedMessagePort = MessagePort & {
  postMessage(message: ArrayBuffer, transfer?: Transferable[]): void;
};

class TranscriptionRecorderProcessor extends AudioWorkletProcessor {
  private readonly portRef: TypedMessagePort;
  private readonly inputSampleRate: number;
  private readonly ratio: number;
  private readonly buffer: Float32Array;
  private bufferedSamples = 0;

  constructor() {
    super();
    this.portRef = this.port as TypedMessagePort;
    this.inputSampleRate = sampleRate || TARGET_SAMPLE_RATE;
    this.ratio = Math.max(1, this.inputSampleRate / TARGET_SAMPLE_RATE);
    // Maintain a rolling buffer large enough to hold several frames before flush
    const capacity = Math.ceil(DEFAULT_BUFFER_SAMPLES * this.ratio * 2);
    this.buffer = new Float32Array(capacity);
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelData = input[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    // Append incoming samples to our rolling buffer
    this.appendToBuffer(channelData);

    // Downsample and flush while we have enough data
    while (this.bufferedSamples >= this.ratio) {
      const frameLength = Math.min(
        DEFAULT_BUFFER_SAMPLES,
        Math.floor(this.bufferedSamples / this.ratio)
      );
      if (frameLength <= 0) break;

      const downsampled = new Float32Array(frameLength);
      for (let i = 0; i < frameLength; i += 1) {
        const sampleIndex = i * this.ratio;
        const lowIndex = Math.floor(sampleIndex);
        const highIndex = Math.min(this.bufferedSamples - 1, lowIndex + 1);
        const frac = sampleIndex - lowIndex;
        const sample =
          this.buffer[lowIndex] + (this.buffer[highIndex] - this.buffer[lowIndex]) * frac;
        downsampled[i] = sample;
      }

      this.portRef.postMessage(downsampled.buffer, [downsampled.buffer]);
      this.consumeFromBuffer(Math.ceil(frameLength * this.ratio));
    }

    return true;
  }

  private appendToBuffer(data: Float32Array): void {
    const available = this.buffer.length - this.bufferedSamples;
    if (available < data.length) {
      // Shift existing data to make room
      const shift = data.length - available;
      if (shift < this.bufferedSamples) {
        this.buffer.copyWithin(0, shift, this.bufferedSamples);
        this.bufferedSamples -= shift;
      } else {
        this.bufferedSamples = 0;
      }
    }
    this.buffer.set(data, this.bufferedSamples);
    this.bufferedSamples += data.length;
  }

  private consumeFromBuffer(count: number): void {
    if (count <= 0) {
      return;
    }
    if (count >= this.bufferedSamples) {
      this.bufferedSamples = 0;
      return;
    }
    this.buffer.copyWithin(0, count, this.bufferedSamples);
    this.bufferedSamples -= count;
  }
}

registerProcessor('transcription-recorder', TranscriptionRecorderProcessor);

export {};
