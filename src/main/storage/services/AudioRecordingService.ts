import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { AudioRecordingRow } from '../types/database';
import { AudioRecording, CreateAudioRecordingInput } from '../types/entities';

/**
 * AudioRecordingService - Local audio recording file tracking
 *
 * Note: Audio recordings are LOCAL-ONLY and NOT synced to the server.
 * They are stored on disk and tracked in the database for playback purposes.
 */
export class AudioRecordingService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager
  ) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Create a new audio recording record
   */
  async create(input: CreateAudioRecordingInput): Promise<AudioRecording> {
    const now = Date.now();
    const id = input.id || crypto.randomUUID();

    await this.transactionManager.execute(() => {
      this.db
        .prepare(
          `
          INSERT INTO audio_recordings (
            id, transcription_id, file_name, file_path, file_size_bytes,
            duration_ms, mime_type, created_at, deleted
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          id,
          input.transcriptionId,
          input.fileName,
          input.filePath,
          input.fileSizeBytes ?? null,
          input.durationMs ?? null,
          input.mimeType ?? 'audio/wav',
          now,
          0 // deleted
        );
    });

    return {
      id,
      transcriptionId: input.transcriptionId,
      fileName: input.fileName,
      filePath: input.filePath,
      fileSizeBytes: input.fileSizeBytes ?? null,
      durationMs: input.durationMs ?? null,
      mimeType: input.mimeType ?? 'audio/wav',
      createdAt: new Date(now),
      deleted: false,
    };
  }

  /**
   * Get audio recording by ID
   */
  async get(recordingId: string): Promise<AudioRecording | null> {
    const row = this.db
      .prepare(
        `
        SELECT * FROM audio_recordings
        WHERE id = ? AND deleted = 0
      `
      )
      .get(recordingId) as AudioRecordingRow | undefined;

    return row ? this.mapRowToEntity(row) : null;
  }

  /**
   * Get audio recording by transcription ID
   */
  async getByTranscriptionId(transcriptionId: string): Promise<AudioRecording | null> {
    const row = this.db
      .prepare(
        `
        SELECT * FROM audio_recordings
        WHERE transcription_id = ? AND deleted = 0
        ORDER BY created_at DESC
        LIMIT 1
      `
      )
      .get(transcriptionId) as AudioRecordingRow | undefined;

    return row ? this.mapRowToEntity(row) : null;
  }

  /**
   * Check if a recording exists for a transcription
   */
  async existsForTranscription(transcriptionId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `
        SELECT 1 FROM audio_recordings
        WHERE transcription_id = ? AND deleted = 0
      `
      )
      .get(transcriptionId);

    return !!result;
  }

  /**
   * Soft delete an audio recording
   */
  async delete(recordingId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      this.db
        .prepare(
          `
          UPDATE audio_recordings
          SET deleted = 1
          WHERE id = ?
        `
        )
        .run(recordingId);
    });
  }

  /**
   * Soft delete all recordings for a transcription
   */
  async deleteByTranscriptionId(transcriptionId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      this.db
        .prepare(
          `
          UPDATE audio_recordings
          SET deleted = 1
          WHERE transcription_id = ?
        `
        )
        .run(transcriptionId);
    });
  }

  /**
   * Map database row to entity
   */
  private mapRowToEntity(row: AudioRecordingRow): AudioRecording {
    return {
      id: row.id,
      transcriptionId: row.transcription_id,
      fileName: row.file_name,
      filePath: row.file_path,
      fileSizeBytes: row.file_size_bytes,
      durationMs: row.duration_ms,
      mimeType: row.mime_type,
      createdAt: new Date(row.created_at),
      deleted: !!row.deleted,
    };
  }
}
