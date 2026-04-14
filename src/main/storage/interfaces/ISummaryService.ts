/**
 * Summary service interface - AI summary management
 */

import type { Summary, CreateSummaryInput, UpdateSummaryInput } from '../types/entities';

export interface ISummaryService {
  /**
   * Create a new summary
   */
  create(input: CreateSummaryInput): Promise<void>;

  /**
   * Get summary by ID
   */
  get(summaryId: string): Promise<Summary | null>;

  /**
   * Get all summaries for a transcription
   */
  getByTranscriptionId(transcriptionId: string): Promise<Summary[]>;

  /**
   * Update an existing summary
   */
  update(input: UpdateSummaryInput): Promise<void>;

  /**
   * Soft delete a summary
   */
  delete(summaryId: string): Promise<void>;

  /**
   * Check if summary exists and is not deleted
   */
  exists(summaryId: string): Promise<boolean>;

  /**
   * Get all summaries for sync operations
   * Returns summary metadata for efficient hashing
   */
  getAllSummaries(): Promise<Summary[]>;

  /**
   * Get summaries by IDs
   */
  getByIds(ids: string[]): Promise<Summary[]>;

  /**
   * Get summary count for a transcription
   */
  getCountByTranscriptionId(transcriptionId: string): Promise<number>;

  /**
   * Check if a summary exists for a transcription and type
   */
  existsForTranscription(transcriptionId: string, summaryType: string): Promise<boolean>;

  /**
   * Update sync metadata for a summary
   */
  updateSyncMetadata(
    summaryId: string,
    syncVersion: number,
    checksum: string,
    serverUpdatedAt?: Date
  ): Promise<void>;
}
