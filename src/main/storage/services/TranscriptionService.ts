import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { logger } from '../../logger';
import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import type { ISearchService } from '../interfaces/ISearchService';
import { ITranscriptionService } from '../interfaces/ITranscriptionService';
import { TranscriptionSessionRow } from '../types/database';
import { TranscriptionSession } from '../types/entities';

import type { SyncItemsService } from './SyncItemsService';

/**
 * TranscriptionService - Transcription session management with encryption
 */
export class TranscriptionService implements ITranscriptionService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager,
    private searchService: ISearchService,
    private syncItems?: SyncItemsService
  ) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Create a new transcription session
   */
  async createSession(binderId: string, noteId: string, language: string): Promise<string> {
    const id = crypto.randomUUID();

    const sessionId = await this.transactionManager.execute(() => {
      const now = Date.now();

      // Insert transcription session with plain text storage
      this.db
        .prepare(
          `
        INSERT INTO transcription_sessions(
          id, binder_id, note_id, language, status, start_time,
          char_count, word_count, full_text, deleted,
          sync_version, sync_checksum, server_updated_at,
          created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `
        )
        .run(
          id,
          binderId,
          noteId,
          language,
          'recording',
          now,
          0, // char_count
          0, // word_count
          '', // Start with empty content
          0, // deleted
          1, // sync_version
          null, // sync_checksum
          null, // server_updated_at (null until synced)
          now, // created_at
          now // updated_at
        );

      // Initialize empty FTS entry
      // Initialize empty FTS entry via SearchService (non-fatal)
      this.searchService.indexTranscription(id, '').catch(() => {
        /* ignore */
      });

      return id;
    });

    // Note: DO NOT mark dirty here - transcriptions are only synced when finalized
    // See SYNC_JOPLIN.md#L69 - only finalized transcriptions should be sent

    return sessionId;
  }

  /**
   * Append text to an active transcription session
   */
  async appendText(sessionId: string, textChunk: string): Promise<void> {
    if (!textChunk || textChunk.trim().length === 0) {
      return;
    }

    // Get current content
    const row = this.db
      .prepare(
        `
      SELECT full_text as content
      FROM transcription_sessions 
      WHERE id=? AND status='recording'
    `
      )
      .get(sessionId) as { content: string } | undefined;

    if (!row) {
      throw new Error('Session not found or not recording');
    }

    const currentText = row.content || '';

    // Normalize and clean the text chunk
    let cleanTextChunk = textChunk.trim().replace(/\s+/g, ' ');

    // Backend safeguard: Check if producer sent accumulated text instead of delta
    if (cleanTextChunk.startsWith(currentText)) {
      // Producer sent the whole transcript again: keep only the delta
      cleanTextChunk = cleanTextChunk.slice(currentText.length).trim();
      if (!cleanTextChunk) {
        // Nothing new to add, exit early
        return;
      }
    }

    // Append new text and get counts
    const updatedText =
      currentText.length === 0 ? cleanTextChunk : currentText + ' ' + cleanTextChunk;
    const charCount = updatedText.length;
    const wordCount = updatedText.trim().length > 0 ? updatedText.trim().split(/\s+/).length : 0;

    // Now execute transaction with encrypted data
    await this.transactionManager.execute(() => {
      const now = Date.now();

      // Update transcription session
      this.db
        .prepare(
          `
        UPDATE transcription_sessions SET 
        full_text=?, char_count=?, word_count=?, updated_at=?
        WHERE id=?
      `
        )
        .run(updatedText, charCount, wordCount, now, sessionId);

      // Log the append operation for debugging
      logger.debug('TranscriptionService: Text appended', {
        sessionId,
        originalChunk: textChunk.length > 50 ? textChunk.substring(0, 50) + '...' : textChunk,
        cleanChunk:
          cleanTextChunk.length > 50 ? cleanTextChunk.substring(0, 50) + '...' : cleanTextChunk,
        newLength: updatedText.length,
        wordCount,
      });

      // Update FTS index
      // Update FTS index via SearchService (non-fatal)
      this.searchService.indexTranscription(sessionId, updatedText).catch(() => {
        /* ignore */
      });
    });

    // Note: DO NOT mark dirty here - transcriptions are only synced when finalized
    // appendText happens during recording which is local-only
  }

  /**
   * Replace the full text of an active transcription session (batch-mode final)
   */
  async replaceFullText(sessionId: string, fullText: string): Promise<void> {
    const charCount = fullText.length;
    const wordCount = fullText.trim().length > 0 ? fullText.trim().split(/\s+/).length : 0;

    await this.transactionManager.execute(() => {
      const now = Date.now();

      this.db
        .prepare(
          `
        UPDATE transcription_sessions SET
        full_text=?, char_count=?, word_count=?, updated_at=?
        WHERE id=? AND status='recording'
      `
        )
        .run(fullText, charCount, wordCount, now, sessionId);

      logger.debug('TranscriptionService: Full text replaced (batch final)', {
        sessionId,
        charCount,
        wordCount,
      });

      this.searchService.indexTranscription(sessionId, fullText).catch(() => {
        /* ignore */
      });
    });
  }

  /**
   * Complete a transcription session
   */
  async completeSession(sessionId: string, endTime?: number): Promise<void> {
    // Get session info first
    const row = this.db
      .prepare(
        `
      SELECT start_time FROM transcription_sessions 
      WHERE id=? AND status='recording'
    `
      )
      .get(sessionId) as { start_time: number } | undefined;

    if (!row) {
      throw new Error('Session not found or not recording');
    }

    const actualEndTime = endTime || Date.now();
    const durationMs = actualEndTime - row.start_time;

    // Complete session in transaction
    await this.transactionManager.execute(() => {
      // Update session status
      this.db
        .prepare(
          `
        UPDATE transcription_sessions SET
        status=?, end_time=?, duration_ms=?, updated_at=?
        WHERE id=?
      `
        )
        .run('completed', actualEndTime, durationMs, Date.now(), sessionId);
    });

    this.syncItems?.markDirty('transcriptions', sessionId);
  }

  /**
   * Get transcription session with full text
   */
  async getSession(sessionId: string): Promise<{
    session: TranscriptionSession;
    fullText: string;
  }> {
    // Ensure we read the latest committed data (matching listAll() behavior)
    // WAL mode readers may not see recently committed data until checkpoint
    this.db.pragma('wal_checkpoint(PASSIVE)');

    const row = this.db
      .prepare(
        `
      SELECT id, note_id, binder_id, language, status, start_time, end_time, duration_ms,
             char_count, word_count, created_at, updated_at, deleted, full_text,
             sync_version, sync_checksum, server_updated_at, original_text, user_edited
      FROM transcription_sessions
      WHERE id=?
    `
      )
      .get(sessionId) as
      | (TranscriptionSessionRow & {
          full_text: string;
          original_text: string | null;
          user_edited: number;
        })
      | undefined;

    if (!row) {
      throw new Error(`Transcription session with ID ${sessionId} not found`);
    }

    // Get the appropriate text based on edit state:
    // - If user_edited=1, use full_text (contains user's edits)
    // - Otherwise, use original_text (canonical from sync)
    // - Fall back to reconstructing from segments if both empty
    let fullText: string;
    if (row.user_edited === 1 && row.full_text) {
      fullText = row.full_text;
    } else if (row.original_text) {
      fullText = row.original_text;
    } else if (row.full_text) {
      fullText = row.full_text;
    } else {
      // Reconstruct from segments as last resort
      const segments = this.db
        .prepare(
          `SELECT text FROM transcription_segments
           WHERE session_id = ? AND deleted = 0
           ORDER BY sequence_order ASC`
        )
        .all(sessionId) as Array<{ text: string }>;

      fullText = segments.length > 0 ? segments.map((s) => s.text).join(' ') : '';
    }

    // Diagnostic logging for debugging summary generation issues
    logger.debug('TranscriptionService.getSession: Retrieved session', {
      sessionId,
      hasRow: true,
      fullTextLength: fullText.length,
      status: row.status,
      charCount: row.char_count,
      wordCount: row.word_count,
    });

    const session: TranscriptionSession = {
      id: row.id,
      binderId: row.binder_id,
      noteId: row.note_id,
      language: row.language,
      status: row.status as 'recording' | 'completing' | 'completed',
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : null,
      durationMs: row.duration_ms,
      charCount: row.char_count,
      wordCount: row.word_count,
      deleted: row.deleted ?? 0,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };

    return { session, fullText };
  }

  /**
   * List transcription sessions for a note
   */
  async listByNote(noteId: string): Promise<TranscriptionSession[]> {
    const rows = this.db
      .prepare(
        `
      SELECT id, binder_id, note_id, language, status, start_time, end_time, duration_ms,
             char_count, word_count, created_at, updated_at, deleted
      FROM transcription_sessions 
      WHERE note_id=? 
      ORDER BY start_time DESC
    `
      )
      .all(noteId) as TranscriptionSessionRow[];

    return rows.map((row) => ({
      id: row.id,
      binderId: row.binder_id,
      noteId: row.note_id,
      language: row.language,
      status: row.status as 'recording' | 'completing' | 'completed',
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : null,
      durationMs: row.duration_ms,
      charCount: row.char_count,
      wordCount: row.word_count,
      deleted: row.deleted ?? 0,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }

  /**
   * Export transcription session to file
   */
  async exportSession(sessionId: string, targetPath?: string): Promise<string> {
    const { session, fullText } = await this.getSession(sessionId);

    // Generate filename if not provided
    const fileName = `${session.noteId}-${sessionId}.txt`;
    let filePath: string;

    if (targetPath) {
      if (path.extname(targetPath) === '') {
        // targetPath is a directory
        filePath = path.join(targetPath, fileName);
      } else {
        // targetPath is a file
        filePath = targetPath;
      }
    } else {
      // Use default location (user's documents or temp directory)
      const os = await import('os');
      const documentsPath = path.join(os.homedir(), 'Documents');
      filePath = path.join(documentsPath, fileName);
    }

    // Create export content with session metadata
    const exportContent = [
      `Transcription Session Export`,
      `==========================`,
      ``,
      `Session ID: ${session.id}`,
      `Language: ${session.language}`,
      `Status: ${session.status}`,
      `Start Time: ${session.startTime.toISOString()}`,
      `End Time: ${session.endTime?.toISOString() || 'N/A'}`,
      `Duration: ${session.durationMs ? `${Math.round(session.durationMs / 1000)}s` : 'N/A'}`,
      `Characters: ${session.charCount}`,
      `Words: ${session.wordCount}`,
      ``,
      `Transcript:`,
      `-----------`,
      fullText,
    ].join('\n');

    // Write file
    await fs.writeFile(filePath, exportContent, 'utf8');

    return filePath;
  }

  /**
   * Get session statistics
   */
  async getSessionStats(sessionId: string): Promise<{
    charCount: number;
    wordCount: number;
    durationMs: number | null;
  }> {
    const row = this.db
      .prepare(
        `
      SELECT char_count, word_count, duration_ms
      FROM transcription_sessions 
      WHERE id=?
    `
      )
      .get(sessionId) as
      | {
          char_count: number;
          word_count: number;
          duration_ms: number | null;
        }
      | undefined;

    if (!row) {
      throw new Error(`Transcription session with ID ${sessionId} not found`);
    }

    return {
      charCount: row.char_count,
      wordCount: row.word_count,
      durationMs: row.duration_ms,
    };
  }

  /**
   * Delete a transcription session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      // Soft delete the transcription session
      const now = Date.now();
      const result = this.db
        .prepare('UPDATE transcription_sessions SET deleted=1, updated_at=? WHERE id=?')
        .run(now, sessionId);

      if (result.changes === 0) {
        throw new Error(`Transcription session with ID ${sessionId} not found`);
      }

      // Remove from FTS index
      // Remove from FTS index via SearchService (non-fatal)
      this.searchService.removeTranscriptionFromIndex(sessionId).catch(() => {
        /* ignore */
      });
    });

    this.syncItems?.markDirty('transcriptions', sessionId);
  }

  /**
   * Check if session exists and is accessible
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    const row = this.db
      .prepare('SELECT 1 FROM transcription_sessions WHERE id=? LIMIT 1')
      .get(sessionId);
    return row !== undefined;
  }

  /**
   * Get active recording sessions
   */
  async getActiveRecordingSessions(): Promise<TranscriptionSession[]> {
    const rows = this.db
      .prepare(
        `
      SELECT id, binder_id, note_id, language, status, start_time, end_time, duration_ms,
             char_count, word_count, created_at, updated_at, deleted
      FROM transcription_sessions 
      WHERE status IN ('recording', 'completing')
      ORDER BY start_time DESC
    `
      )
      .all() as TranscriptionSessionRow[];

    return rows.map((row) => ({
      id: row.id,
      binderId: row.binder_id,
      noteId: row.note_id,
      language: row.language,
      status: row.status as 'recording' | 'completing' | 'completed',
      startTime: new Date(row.start_time),
      endTime: row.end_time ? new Date(row.end_time) : null,
      durationMs: row.duration_ms,
      charCount: row.char_count,
      wordCount: row.word_count,
      deleted: row.deleted ?? 0,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  }

  /**
   * List all transcription sessions for sync
   */
  async listAll(): Promise<TranscriptionSession[]> {
    try {
      // Force WAL checkpoint to ensure we see all committed data
      this.db.pragma('wal_checkpoint(FULL)');

      const rows = this.db
        .prepare(
          `
        SELECT id, binder_id, note_id, language, status, start_time, end_time, duration_ms,
               char_count, word_count, created_at, updated_at, deleted
        FROM transcription_sessions 
        WHERE status = 'completed'
        ORDER BY created_at DESC
      `
        )
        .all() as TranscriptionSessionRow[];

      logger.debug('TranscriptionService.listAll: Query complete', {
        count: rows.length,
      });

      return rows.map((row) => ({
        id: row.id,
        binderId: row.binder_id,
        noteId: row.note_id,
        language: row.language,
        status: row.status as 'recording' | 'completing' | 'completed',
        startTime: new Date(row.start_time),
        endTime: row.end_time ? new Date(row.end_time) : null,
        durationMs: row.duration_ms,
        charCount: row.char_count,
        wordCount: row.word_count,
        deleted: row.deleted ?? 0,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));
    } catch (error) {
      logger.error('TranscriptionService.listAll: Query failed', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get all transcription sessions for sync operations
   * Used by Merkle tree sync to enumerate all transcription sessions for hash computation
   * Returns transcription session metadata for efficient hashing
   */
  async getAllTranscriptionSessions(): Promise<TranscriptionSessionRow[]> {
    const stmt = this.db.prepare(
      'SELECT * FROM transcription_sessions WHERE deleted=0 ORDER BY id'
    );
    return stmt.all() as TranscriptionSessionRow[];
  }

  /**
   * List all transcriptions with note titles and preview text
   * Used for the Transcriptions page UI
   */
  async listAllWithDetails(): Promise<
    Array<{
      id: string;
      noteId: string;
      binderId: string;
      noteTitle: string;
      startTime: number;
      endTime: number | null;
      durationMs: number | null;
      wordCount: number;
      charCount: number;
      previewText: string;
    }>
  > {
    const rows = this.db
      .prepare(
        `
        SELECT
          ts.id,
          ts.note_id,
          ts.binder_id,
          ts.start_time,
          ts.end_time,
          ts.duration_ms,
          ts.word_count,
          ts.char_count,
          SUBSTR(
            CASE
              WHEN ts.user_edited = 1 AND ts.full_text IS NOT NULL AND ts.full_text != '' THEN ts.full_text
              WHEN ts.original_text IS NOT NULL AND ts.original_text != '' THEN ts.original_text
              ELSE COALESCE(ts.full_text, '')
            END,
            1, 100
          ) as preview_text,
          CASE
            WHEN n.title IS NULL OR n.title = '' THEN 'Untitled Note'
            ELSE n.title
          END as note_title
        FROM transcription_sessions ts
        LEFT JOIN notes n ON ts.note_id = n.id
        WHERE ts.status = 'completed' AND ts.deleted = 0
        ORDER BY ts.start_time DESC
      `
      )
      .all() as Array<{
      id: string;
      note_id: string;
      binder_id: string;
      start_time: number;
      end_time: number | null;
      duration_ms: number | null;
      word_count: number;
      char_count: number;
      preview_text: string;
      note_title: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      binderId: row.binder_id,
      noteTitle: row.note_title,
      startTime: row.start_time,
      endTime: row.end_time,
      durationMs: row.duration_ms,
      wordCount: row.word_count,
      charCount: row.char_count,
      previewText: row.preview_text || '',
    }));
  }

  /**
   * Apply a refinement to a transcription session
   * Replaces text by segment ID or by simple string replacement
   */
  async applyRefinement(params: {
    sessionId: string;
    segmentId: string;
    originalText: string;
    refinedText: string;
    confidenceImprovement?: number;
    timestamp: number;
  }): Promise<void> {
    const { sessionId, segmentId, originalText, refinedText, confidenceImprovement, timestamp } =
      params;

    // Get current content
    const row = this.db
      .prepare(
        `
      SELECT full_text as content
      FROM transcription_sessions
      WHERE id=?
    `
      )
      .get(sessionId) as { content: string } | undefined;

    if (!row) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const currentText = row.content || '';

    // Apply refinement by replacing the original text with refined text
    // Use simple string replacement for now (segmentId-based replacement could be added later)
    const updatedText = currentText.replace(originalText, refinedText);

    if (updatedText === currentText) {
      logger.warn('TranscriptionService: Refinement did not change text', {
        sessionId,
        segmentId,
        originalText: originalText.substring(0, 50),
        refinedText: refinedText.substring(0, 50),
      });
      // Don't throw - this might be expected if refinement was already applied
      return;
    }

    // Recalculate counts
    const charCount = updatedText.length;
    const wordCount = updatedText.trim().length > 0 ? updatedText.trim().split(/\s+/).length : 0;

    // Apply in transaction
    await this.transactionManager.execute(() => {
      const now = Date.now();

      // Update transcription session
      this.db
        .prepare(
          `
        UPDATE transcription_sessions SET
        full_text=?, char_count=?, word_count=?, updated_at=?
        WHERE id=?
      `
        )
        .run(updatedText, charCount, wordCount, now, sessionId);

      logger.info('TranscriptionService: Refinement applied', {
        sessionId,
        segmentId,
        originalLength: originalText.length,
        refinedLength: refinedText.length,
        confidenceImprovement,
        timestamp,
      });

      // Update FTS index
      this.searchService.indexTranscription(sessionId, updatedText).catch(() => {
        /* ignore */
      });
    });
  }

  /**
   * Save user correction to transcription text
   * This replaces the entire text with the user's corrected version
   * Used for MS Teams-like editing experience where users can fix transcription errors
   */
  async saveCorrection(
    sessionId: string,
    originalText: string,
    correctedText: string
  ): Promise<void> {
    // Get current content to verify
    const row = this.db
      .prepare(
        `
      SELECT full_text as content
      FROM transcription_sessions
      WHERE id=?
    `
      )
      .get(sessionId) as { content: string } | undefined;

    if (!row) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (correctedText === (row.content ?? '')) {
      return;
    }

    // Recalculate counts for the corrected text
    const charCount = correctedText.length;
    const wordCount =
      correctedText.trim().length > 0 ? correctedText.trim().split(/\s+/).length : 0;

    // Apply correction in transaction
    await this.transactionManager.execute(() => {
      const now = Date.now();

      // Update transcription session with corrected text
      this.db
        .prepare(
          `
        UPDATE transcription_sessions SET
        full_text=?, char_count=?, word_count=?, updated_at=?
        WHERE id=?
      `
        )
        .run(correctedText, charCount, wordCount, now, sessionId);

      logger.info('TranscriptionService: User correction saved', {
        sessionId,
        originalLength: originalText.length,
        correctedLength: correctedText.length,
        charCount,
        wordCount,
      });

      // Update FTS index with corrected text
      this.searchService.indexTranscription(sessionId, correctedText).catch(() => {
        /* ignore */
      });
    });
  }

  /**
   * Save transcription segments with timestamps
   * Stores individual segments for timestamp tracking and user edit history
   */
  async saveSegments(
    sessionId: string,
    segments: Array<{
      segmentId: string;
      text: string;
      startTime: number;
      endTime: number;
      sequenceOrder: number;
    }>
  ): Promise<void> {
    if (!segments || segments.length === 0) {
      return;
    }

    // Verify session exists
    const session = this.db
      .prepare('SELECT id FROM transcription_sessions WHERE id=?')
      .get(sessionId) as { id: string } | undefined;

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    await this.transactionManager.execute(() => {
      const now = Date.now();

      const insertStmt = this.db.prepare(`
        INSERT OR REPLACE INTO transcription_segments(
          id, session_id, segment_id, text, start_time_seconds, end_time_seconds,
          sequence_order, user_edited, original_text, created_at, updated_at,
          deleted, sync_version, sync_checksum, server_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const segment of segments) {
        const id = crypto.randomUUID();
        insertStmt.run(
          id,
          sessionId,
          segment.segmentId,
          segment.text,
          segment.startTime,
          segment.endTime,
          segment.sequenceOrder,
          0, // user_edited
          null, // original_text
          now, // created_at
          now, // updated_at
          0, // deleted
          1, // sync_version
          null, // sync_checksum
          null // server_updated_at
        );
      }

      logger.info('TranscriptionService: Segments saved', {
        sessionId,
        segmentCount: segments.length,
      });
    });
  }

  /**
   * Get segments for a transcription session
   */
  async getSegments(sessionId: string): Promise<
    Array<{
      id: string;
      segmentId: string;
      text: string;
      startTime: number;
      endTime: number;
      sequenceOrder: number;
      userEdited: boolean;
      originalText: string | null;
    }>
  > {
    const rows = this.db
      .prepare(
        `
        SELECT id, segment_id, text, start_time_seconds, end_time_seconds,
               sequence_order, user_edited, original_text
        FROM transcription_segments
        WHERE session_id = ? AND deleted = 0
        ORDER BY sequence_order ASC
      `
      )
      .all(sessionId) as Array<{
      id: string;
      segment_id: string;
      text: string;
      start_time_seconds: number;
      end_time_seconds: number;
      sequence_order: number;
      user_edited: number;
      original_text: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      segmentId: row.segment_id,
      text: row.text,
      startTime: row.start_time_seconds,
      endTime: row.end_time_seconds,
      sequenceOrder: row.sequence_order,
      userEdited: row.user_edited === 1,
      originalText: row.original_text,
    }));
  }

  /**
   * Mark a segment as user-edited and store the original text
   */
  async markSegmentEdited(sessionId: string, segmentId: string, newText: string): Promise<void> {
    const now = Date.now();

    // Get current segment to preserve original text
    const current = this.db
      .prepare(
        `
        SELECT text, original_text, user_edited
        FROM transcription_segments
        WHERE session_id = ? AND segment_id = ? AND deleted = 0
      `
      )
      .get(sessionId, segmentId) as
      | { text: string; original_text: string | null; user_edited: number }
      | undefined;

    if (!current) {
      logger.warn('TranscriptionService: Segment not found for edit', {
        sessionId,
        segmentId,
      });
      return;
    }

    // Only store original text on first edit
    const originalText = current.user_edited === 1 ? current.original_text : current.text;

    this.db
      .prepare(
        `
        UPDATE transcription_segments SET
        text = ?, original_text = ?, user_edited = 1, updated_at = ?
        WHERE session_id = ? AND segment_id = ? AND deleted = 0
      `
      )
      .run(newText, originalText, now, sessionId, segmentId);

    logger.info('TranscriptionService: Segment marked as edited', {
      sessionId,
      segmentId,
      originalTextLength: originalText?.length,
      newTextLength: newText.length,
    });
  }
}
