/**
 * SpeakerAttributor - Analyzes stereo audio to attribute speech segments to speakers.
 *
 * Uses channel energy analysis to determine who is speaking:
 * - Left channel (0): Microphone audio (user)
 * - Right channel (1): System audio (meeting participants)
 *
 * This is a lightweight approach that doesn't require ML models or GPU.
 */

export type Speaker = 'user' | 'participant' | 'both' | 'unknown';

export type SegmentWithSpeaker = {
  segmentId: string;
  text: string;
  startTime: number;
  endTime: number;
  speaker: Speaker;
  speakerConfidence: number; // 0-1, how confident we are in the speaker attribution
};

export class SpeakerAttributor {
  private stereoData: Float32Array | null = null;
  private sampleRate: number;

  // Thresholds for attribution
  private readonly dominanceThreshold = 0.65; // One channel must be >65% of energy
  private readonly bothThreshold = 0.35; // If both channels are >35%, it's "both"
  private readonly silenceThreshold = 0.001; // RMS below this is considered silence

  constructor(sampleRate: number = 16000) {
    this.sampleRate = sampleRate;
  }

  /**
   * Load stereo PCM data for analysis.
   * Data should be interleaved stereo: [L0, R0, L1, R1, ...]
   */
  loadStereoData(data: Float32Array): void {
    this.stereoData = data;
    console.log('SpeakerAttributor: Loaded stereo data', {
      samples: data.length / 2,
      durationSec: data.length / 2 / this.sampleRate,
    });
  }

  /**
   * Attribute a speaker to a segment based on channel energy.
   */
  attributeSegment(startTime: number, endTime: number): { speaker: Speaker; confidence: number } {
    if (!this.stereoData) {
      return { speaker: 'unknown', confidence: 0 };
    }

    // Convert time to sample indices (multiply by 2 for interleaved stereo)
    const startSample = Math.floor(startTime * this.sampleRate) * 2;
    const endSample = Math.floor(endTime * this.sampleRate) * 2;

    // Bounds check
    const clampedStart = Math.max(0, startSample);
    const clampedEnd = Math.min(this.stereoData.length, endSample);

    if (clampedEnd <= clampedStart) {
      return { speaker: 'unknown', confidence: 0 };
    }

    let leftEnergy = 0;
    let rightEnergy = 0;
    let sampleCount = 0;

    // Calculate RMS energy for each channel
    for (let i = clampedStart; i < clampedEnd - 1; i += 2) {
      const left = this.stereoData[i];
      const right = this.stereoData[i + 1];
      leftEnergy += left * left;
      rightEnergy += right * right;
      sampleCount++;
    }

    if (sampleCount === 0) {
      return { speaker: 'unknown', confidence: 0 };
    }

    const leftRMS = Math.sqrt(leftEnergy / sampleCount);
    const rightRMS = Math.sqrt(rightEnergy / sampleCount);

    // Check for silence
    const totalEnergy = leftRMS + rightRMS;
    if (totalEnergy < this.silenceThreshold) {
      return { speaker: 'unknown', confidence: 0 };
    }

    // Calculate ratios
    const leftRatio = leftRMS / totalEnergy;
    const rightRatio = rightRMS / totalEnergy;

    // Determine speaker based on relative energy
    if (leftRatio > this.dominanceThreshold) {
      return { speaker: 'user', confidence: leftRatio };
    } else if (rightRatio > this.dominanceThreshold) {
      return { speaker: 'participant', confidence: rightRatio };
    } else if (leftRatio > this.bothThreshold && rightRatio > this.bothThreshold) {
      // Both speakers are active (crosstalk)
      return { speaker: 'both', confidence: Math.min(leftRatio, rightRatio) };
    }

    // Energy is present but no clear dominance
    return { speaker: 'unknown', confidence: 0.5 };
  }

  /**
   * Process all segments and add speaker attribution.
   */
  attributeAllSegments(
    segments: Array<{
      segmentId: string;
      text: string;
      startTime: number;
      endTime: number;
    }>
  ): SegmentWithSpeaker[] {
    console.log('SpeakerAttributor: Processing', segments.length, 'segments');

    const results = segments.map((segment) => {
      const { speaker, confidence } = this.attributeSegment(segment.startTime, segment.endTime);
      return {
        ...segment,
        speaker,
        speakerConfidence: confidence,
      };
    });

    // Log attribution summary
    const summary = {
      user: results.filter((s) => s.speaker === 'user').length,
      participant: results.filter((s) => s.speaker === 'participant').length,
      both: results.filter((s) => s.speaker === 'both').length,
      unknown: results.filter((s) => s.speaker === 'unknown').length,
    };
    console.log('SpeakerAttributor: Attribution summary', summary);

    return results;
  }

  /**
   * Get detailed energy analysis for debugging/visualization.
   */
  analyzeSegmentEnergy(
    startTime: number,
    endTime: number
  ): {
    leftRMS: number;
    rightRMS: number;
    leftRatio: number;
    rightRatio: number;
  } | null {
    if (!this.stereoData) return null;

    const startSample = Math.floor(startTime * this.sampleRate) * 2;
    const endSample = Math.floor(endTime * this.sampleRate) * 2;

    const clampedStart = Math.max(0, startSample);
    const clampedEnd = Math.min(this.stereoData.length, endSample);

    if (clampedEnd <= clampedStart) return null;

    let leftEnergy = 0;
    let rightEnergy = 0;
    let sampleCount = 0;

    for (let i = clampedStart; i < clampedEnd - 1; i += 2) {
      leftEnergy += this.stereoData[i] * this.stereoData[i];
      rightEnergy += this.stereoData[i + 1] * this.stereoData[i + 1];
      sampleCount++;
    }

    if (sampleCount === 0) return null;

    const leftRMS = Math.sqrt(leftEnergy / sampleCount);
    const rightRMS = Math.sqrt(rightEnergy / sampleCount);
    const total = leftRMS + rightRMS;

    return {
      leftRMS,
      rightRMS,
      leftRatio: total > 0 ? leftRMS / total : 0,
      rightRatio: total > 0 ? rightRMS / total : 0,
    };
  }

  /**
   * Dispose of loaded data to free memory.
   */
  dispose(): void {
    this.stereoData = null;
    console.log('SpeakerAttributor: Disposed');
  }
}
