/**
 * Transcription service interface - Transcription session management
 */

import type { TranscriptionSession } from '../types/entities';

export interface ITranscriptionService {
  /**
   * Create a new transcription session
   */
  createSession(binderId: string, noteId: string, language: string): Promise<string>;

  /**
   * Append text to an active transcription session
   */
  appendText(sessionId: string, textChunk: string): Promise<void>;

  /**
   * Replace the full text of an active transcription session (batch-mode final)
   */
  replaceFullText(sessionId: string, fullText: string): Promise<void>;

  /**
   * Complete a transcription session
   */
  completeSession(sessionId: string, endTime?: number): Promise<void>;

  /**
   * Get transcription session with full text
   */
  getSession(sessionId: string): Promise<{
    session: TranscriptionSession;
    fullText: string;
  }>;

  /**
   * List transcription sessions for a note
   */
  listByNote(noteId: string): Promise<TranscriptionSession[]>;

  /**
   * Export transcription session to file
   */
  exportSession(sessionId: string, targetPath?: string): Promise<string>;

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string): Promise<{
    charCount: number;
    wordCount: number;
    durationMs: number | null;
  }>;

  /**
   * Delete a transcription session
   */
  deleteSession(sessionId: string): Promise<void>;

  /**
   * Check if session exists and is accessible
   */
  sessionExists(sessionId: string): Promise<boolean>;

  /**
   * Get active recording sessions
   */
  getActiveRecordingSessions(): Promise<TranscriptionSession[]>;

  /**
   * List all completed transcription sessions for sync
   */
  listAll(): Promise<TranscriptionSession[]>;

  /**
   * Get all transcription sessions for sync operations
   * Used by Merkle tree sync to enumerate all transcription sessions for hash computation
   * Returns transcription session metadata for efficient hashing
   */
  getAllTranscriptionSessions(): Promise<import('../types/database').TranscriptionSessionRow[]>;

  /**
   * Apply a refinement to a transcription session
   * Replaces text by segment ID or by simple string replacement
   */
  applyRefinement(params: {
    sessionId: string;
    segmentId: string;
    originalText: string;
    refinedText: string;
    confidenceImprovement?: number;
    timestamp: number;
  }): Promise<void>;

  /**
   * Save user correction to transcription text
   * This replaces the entire text with the user's corrected version
   * Used for MS Teams-like editing experience where users can fix transcription errors
   */
  saveCorrection(sessionId: string, originalText: string, correctedText: string): Promise<void>;

  /**
   * Save transcription segments with timestamps
   * Stores individual segments for timestamp tracking and user edit history
   */
  saveSegments(
    sessionId: string,
    segments: Array<{
      segmentId: string;
      text: string;
      startTime: number;
      endTime: number;
      sequenceOrder: number;
    }>
  ): Promise<void>;

  /**
   * Get segments for a transcription session
   */
  getSegments(sessionId: string): Promise<
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
  >;

  /**
   * Mark a segment as user-edited and store the original text
   */
  markSegmentEdited(sessionId: string, segmentId: string, newText: string): Promise<void>;

  /**
   * List all transcriptions with note titles and preview text
   * Used for the Transcriptions page UI
   */
  listAllWithDetails(): Promise<
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
  >;
}
