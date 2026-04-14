/**
 * Audio recording service interface
 * Note: Audio recordings are LOCAL-ONLY and NOT synced to the server
 */

import type { AudioRecording, CreateAudioRecordingInput } from '../types/entities';

export interface IAudioRecordingService {
  /**
   * Create a new audio recording record
   */
  create(input: CreateAudioRecordingInput): Promise<AudioRecording>;

  /**
   * Get audio recording by ID
   */
  get(recordingId: string): Promise<AudioRecording | null>;

  /**
   * Get audio recording by transcription ID
   */
  getByTranscriptionId(transcriptionId: string): Promise<AudioRecording | null>;

  /**
   * Check if a recording exists for a transcription
   */
  existsForTranscription(transcriptionId: string): Promise<boolean>;

  /**
   * Soft delete an audio recording
   */
  delete(recordingId: string): Promise<void>;

  /**
   * Soft delete all recordings for a transcription
   */
  deleteByTranscriptionId(transcriptionId: string): Promise<void>;
}
