import crypto from 'crypto';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { ISummaryService } from '../interfaces/ISummaryService';
import { SummaryRow } from '../types/database';
import { Summary, CreateSummaryInput, UpdateSummaryInput } from '../types/entities';

import type { SyncItemsService } from './SyncItemsService';

/**
 * SummaryService - AI summary management
 */
export class SummaryService implements ISummaryService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager,
    private syncItems?: SyncItemsService
  ) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Create a new summary
   * Uses INSERT OR REPLACE to handle sync scenarios where summary may already exist
   */
  async create(input: CreateSummaryInput): Promise<void> {
    await this.transactionManager.execute(() => {
      const now = Date.now();
      const checksum = crypto.createHash('sha256').update(input.summaryText).digest('hex');

      this.db
        .prepare(
          `
          INSERT OR REPLACE INTO summaries (
            id, transcription_id, summary_text, summary_type, processing_time_ms,
            model_used, backend_type, pipeline_used, sync_version, checksum,
            deleted, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        )
        .run(
          input.id,
          input.transcriptionId,
          input.summaryText,
          input.summaryType || 'full',
          input.processingTimeMs || null,
          input.modelUsed || null,
          input.backendType || null,
          input.pipelineUsed ? 1 : 0,
          1, // sync_version
          checksum,
          0, // deleted
          now,
          now
        );
    });

    this.syncItems?.markDirty('summaries', input.id);
  }

  /**
   * Get summary by ID
   */
  async get(summaryId: string): Promise<Summary | null> {
    const row = this.db
      .prepare(
        `
        SELECT * FROM summaries
        WHERE id = ? AND deleted = 0
      `
      )
      .get(summaryId) as SummaryRow | undefined;

    return row ? this.mapRowToSummary(row) : null;
  }

  /**
   * Get all summaries for a transcription
   */
  async getByTranscriptionId(transcriptionId: string): Promise<Summary[]> {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM summaries
        WHERE transcription_id = ? AND deleted = 0
        ORDER BY created_at DESC
      `
      )
      .all(transcriptionId) as SummaryRow[];

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Update an existing summary
   */
  async update(input: UpdateSummaryInput): Promise<void> {
    let didChange = false;

    await this.transactionManager.execute(() => {
      const current = this.db
        .prepare(
          `
          SELECT summary_text, summary_type, processing_time_ms, model_used, backend_type, pipeline_used
          FROM summaries
          WHERE id = ? AND deleted = 0
        `
        )
        .get(input.id) as
        | {
            summary_text: string | null;
            summary_type: string;
            processing_time_ms: number | null;
            model_used: string | null;
            backend_type: string | null;
            pipeline_used: number;
          }
        | undefined;

      if (!current) {
        return;
      }

      const now = Date.now();
      const updateFields: string[] = [];
      const values: unknown[] = [];

      if (input.summaryText !== undefined) {
        if (input.summaryText !== current.summary_text) {
          updateFields.push('summary_text = ?');
          values.push(input.summaryText);

          // Update checksum if text changed
          updateFields.push('checksum = ?');
          values.push(crypto.createHash('sha256').update(input.summaryText).digest('hex'));
        }
      }

      if (input.summaryType !== undefined) {
        if (input.summaryType !== current.summary_type) {
          updateFields.push('summary_type = ?');
          values.push(input.summaryType);
        }
      }

      if (input.processingTimeMs !== undefined) {
        if (input.processingTimeMs !== current.processing_time_ms) {
          updateFields.push('processing_time_ms = ?');
          values.push(input.processingTimeMs);
        }
      }

      if (input.modelUsed !== undefined) {
        if (input.modelUsed !== current.model_used) {
          updateFields.push('model_used = ?');
          values.push(input.modelUsed);
        }
      }

      if (input.backendType !== undefined) {
        if (input.backendType !== current.backend_type) {
          updateFields.push('backend_type = ?');
          values.push(input.backendType);
        }
      }

      if (input.pipelineUsed !== undefined) {
        const nextPipelineUsed = input.pipelineUsed ? 1 : 0;
        if (nextPipelineUsed !== current.pipeline_used) {
          updateFields.push('pipeline_used = ?');
          values.push(nextPipelineUsed);
        }
      }

      if (updateFields.length === 0) {
        return;
      }

      updateFields.push('updated_at = ?');
      values.push(now);
      values.push(input.id);

      this.db
        .prepare(`UPDATE summaries SET ${updateFields.join(', ')} WHERE id = ?`)
        .run(...values);

      didChange = true;
    });

    if (didChange) {
      this.syncItems?.markDirty('summaries', input.id);
    }
  }

  /**
   * Soft delete a summary
   */
  async delete(summaryId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      const current = this.db
        .prepare('SELECT deleted FROM summaries WHERE id = ?')
        .get(summaryId) as { deleted: number } | undefined;

      if (!current || current.deleted === 1) {
        return;
      }

      const now = Date.now();

      this.db
        .prepare(
          `
          UPDATE summaries
          SET deleted = 1, updated_at = ?
          WHERE id = ?
        `
        )
        .run(now, summaryId);
    });

    this.syncItems?.markDirty('summaries', summaryId);
  }

  /**
   * Check if summary exists and is not deleted
   */
  async exists(summaryId: string): Promise<boolean> {
    const result = this.db
      .prepare('SELECT 1 FROM summaries WHERE id = ? AND deleted = 0')
      .get(summaryId);

    return !!result;
  }

  /**
   * Get all summaries for sync operations
   */
  async getAllSummaries(): Promise<Summary[]> {
    const rows = this.db
      .prepare('SELECT * FROM summaries ORDER BY created_at DESC')
      .all() as SummaryRow[];

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Get summaries by IDs
   */
  async getByIds(ids: string[]): Promise<Summary[]> {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `
        SELECT * FROM summaries
        WHERE id IN (${placeholders}) AND deleted = 0
        ORDER BY created_at DESC
      `
      )
      .all(...ids) as SummaryRow[];

    return rows.map((row) => this.mapRowToSummary(row));
  }

  /**
   * Get summary count for a transcription
   */
  async getCountByTranscriptionId(transcriptionId: string): Promise<number> {
    const result = this.db
      .prepare(
        `
        SELECT COUNT(*) as count
        FROM summaries
        WHERE transcription_id = ? AND deleted = 0
      `
      )
      .get(transcriptionId) as { count: number };

    return result.count;
  }

  /**
   * Check if a summary exists for a transcription and type
   */
  async existsForTranscription(transcriptionId: string, summaryType: string): Promise<boolean> {
    const result = this.db
      .prepare(
        `
        SELECT 1 FROM summaries
        WHERE transcription_id = ? AND summary_type = ? AND deleted = 0
      `
      )
      .get(transcriptionId, summaryType);

    return !!result;
  }

  /**
   * Update sync metadata for a summary
   */
  async updateSyncMetadata(
    summaryId: string,
    syncVersion: number,
    checksum: string,
    serverUpdatedAt?: Date
  ): Promise<void> {
    await this.transactionManager.execute(() => {
      this.db
        .prepare(
          `
          UPDATE summaries
          SET sync_version = ?, checksum = ?, server_updated_at = ?, updated_at = ?
          WHERE id = ?
        `
        )
        .run(
          syncVersion,
          checksum,
          serverUpdatedAt ? serverUpdatedAt.getTime() : null,
          Date.now(),
          summaryId
        );
    });
  }

  /**
   * Map database row to Summary entity
   */
  private mapRowToSummary(row: SummaryRow): Summary {
    return {
      id: row.id,
      transcriptionId: row.transcription_id,
      summaryText: row.summary_text,
      summaryTextEncrypted: row.summary_text_encrypted,
      isSummaryEncrypted: !!row.is_summary_encrypted,
      summaryType: row.summary_type,
      processingTimeMs: row.processing_time_ms,
      modelUsed: row.model_used,
      backendType: row.backend_type,
      pipelineUsed: !!row.pipeline_used,
      syncVersion: row.sync_version,
      checksum: row.checksum,
      deleted: !!row.deleted,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      serverUpdatedAt: row.server_updated_at ? new Date(row.server_updated_at) : null,
    };
  }
}
