import * as fs from 'fs';
import * as path from 'path';

import { app, ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import { type IStorageService } from '../storage/index';

// Validation schemas
const StartTranscriptionSchema = z.object({
  binderId: z.string().min(1),
  noteId: z.string().optional(),
  language: z.string().min(1),
});
const AppendFinalTextSchema = z.object({
  sessionId: z.string().min(1),
  textChunk: z.string().min(1),
});
const ReplaceFullTextSchema = z.object({
  sessionId: z.string().min(1),
  fullText: z.string().min(1),
});
const CompleteTranscriptionSchema = z.object({
  sessionId: z.string().min(1),
  endTime: z.number().optional(),
});
const ListByNoteSchema = z.object({ noteId: z.string().min(1) });
const GetTranscriptionSchema = z.object({ sessionId: z.string().min(1) });
const ExportTranscriptionSchema = z.object({
  sessionId: z.string().min(1),
  targetPath: z.string().optional(),
});
const CreateDevTranscriptionSchema = z.object({
  binderId: z.string().min(1),
  noteId: z.string().min(1),
  text: z.string().min(1),
});
const ApplyRefinementSchema = z.object({
  sessionId: z.string().min(1),
  segmentId: z.string().min(1),
  originalText: z.string().min(1),
  refinedText: z.string().min(1),
  confidenceImprovement: z.number().optional(),
  timestamp: z.number(),
});
const SaveRecordingSchema = z.object({
  sessionId: z.string().min(1),
  wavData: z.string().min(1), // Base64 encoded WAV data
});
const RefineTranscriptionSchema = z.object({
  sessionId: z.string().min(1),
  hints: z.string().optional(), // User corrections to bias transcription
});
const SaveCorrectionSchema = z.object({
  sessionId: z.string().min(1),
  originalText: z.string(),
  correctedText: z.string().min(1),
});
const SaveSegmentsSchema = z.object({
  sessionId: z.string().min(1),
  segments: z.array(
    z.object({
      segmentId: z.string().min(1),
      text: z.string(),
      startTime: z.number(),
      endTime: z.number(),
      sequenceOrder: z.number(),
    })
  ),
});
const GetSegmentsSchema = z.object({
  sessionId: z.string().min(1),
});
const MarkSegmentEditedSchema = z.object({
  sessionId: z.string().min(1),
  segmentId: z.string().min(1),
  newText: z.string(),
});

export interface TranscriptionHandlersDependencies {
  storage: IStorageService;
  getActiveTranscriptionSessionId: () => string | null;
  setActiveTranscriptionSessionId: (sessionId: string | null) => void;
  restartTranscriptionServer?: () => Promise<void>;
  getTranscriptionServerPort?: () => number;
  refineTranscription?: (
    wavPath: string,
    hints?: string
  ) => Promise<{ text: string; used_hints?: boolean }>;
  /** Main window for sending events to renderer */
  mainWindow?: Electron.BrowserWindow | null;
}

/**
 * TranscriptionHandlers manages all IPC handlers related to transcription operations.
 * This includes starting/stopping transcription sessions, appending text, and managing
 * transcription data export functionality.
 */
export class TranscriptionHandlers {
  constructor(private deps: TranscriptionHandlersDependencies) {}

  /**
   * Notify renderer that data has changed (for UI refresh)
   */
  private notifyDataChanged(): void {
    if (this.deps.mainWindow) {
      this.deps.mainWindow.webContents.send('notes:changed');
    }
  }

  /**
   * Register all transcription-related IPC handlers
   */
  register(): void {
    logger.debug('TranscriptionHandlers: Registering IPC handlers');

    ipcMain.handle('transcription:startSession', this.handleStartSession.bind(this));
    ipcMain.handle('transcription:appendFinalText', this.handleAppendFinalText.bind(this));
    ipcMain.handle('transcription:replaceFullText', this.handleReplaceFullText.bind(this));
    ipcMain.handle('transcription:completeSession', this.handleCompleteSession.bind(this));
    ipcMain.handle('transcription:applyRefinement', this.handleApplyRefinement.bind(this));
    ipcMain.handle('transcription:listByNote', this.handleListByNote.bind(this));
    ipcMain.handle('transcription:get', this.handleGetTranscription.bind(this));
    ipcMain.handle('transcription:exportSession', this.handleExportSession.bind(this));
    ipcMain.handle('transcription:listModels', this.handleListModels.bind(this));
    ipcMain.handle('transcription:restartServer', this.handleRestartServer.bind(this));
    ipcMain.handle('transcription:getServerPort', this.handleGetServerPort.bind(this));
    ipcMain.handle('transcription:saveRecording', this.handleSaveRecording.bind(this));
    ipcMain.handle('transcription:refine', this.handleRefineTranscription.bind(this));
    ipcMain.handle('transcription:getRecordingPath', this.handleGetRecordingPath.bind(this));
    ipcMain.handle(
      'transcription:getRecordingWithMeta',
      this.handleGetRecordingWithMeta.bind(this)
    );
    ipcMain.handle('transcription:saveCorrection', this.handleSaveCorrection.bind(this));
    ipcMain.handle('transcription:saveSegments', this.handleSaveSegments.bind(this));
    ipcMain.handle('transcription:getSegments', this.handleGetSegments.bind(this));
    ipcMain.handle('transcription:markSegmentEdited', this.handleMarkSegmentEdited.bind(this));
    ipcMain.handle('transcription:listAllWithDetails', this.handleListAllWithDetails.bind(this));

    // Register dev-only handler for pasting transcriptions
    if (!app.isPackaged) {
      ipcMain.handle('transcription:createDevSession', this.handleCreateDevSession.bind(this));
      logger.info('TranscriptionHandlers: Dev-only handler registered (createDevSession)');
    }

    logger.debug('TranscriptionHandlers: All handlers registered successfully');
  }

  /**
   * Start a new transcription session
   */
  private async handleStartSession(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ sessionId: string; noteId: string }> {
    try {
      const { binderId, noteId: maybeNoteId, language } = StartTranscriptionSchema.parse(input);

      // Check if there's already an active session
      const activeSessionId = this.deps.getActiveTranscriptionSessionId();
      if (activeSessionId) {
        const error = 'A transcription session is already active';
        logger.warn('TranscriptionHandlers: Start session blocked', {
          activeSessionId,
          requestedBinderId: binderId,
        });
        throw new Error(error);
      }

      // Create note if not provided
      const noteId = maybeNoteId ?? (await this.deps.storage.notes.create(binderId));

      logger.info('TranscriptionHandlers: Starting transcription session', {
        binderId,
        noteId,
        language,
      });

      const sessionId = await this.deps.storage.transcriptions.createSession(
        binderId,
        noteId,
        language
      );

      // Set as active session
      this.deps.setActiveTranscriptionSessionId(sessionId);

      logger.info('TranscriptionHandlers: Transcription session started', {
        sessionId,
        noteId,
        binderId,
      });

      return { sessionId, noteId };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to start session', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Append final text to transcription session
   */
  private async handleAppendFinalText(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { sessionId, textChunk } = AppendFinalTextSchema.parse(input);

      const activeSessionId = this.deps.getActiveTranscriptionSessionId();
      if (!activeSessionId || activeSessionId !== sessionId) {
        const error = 'No active transcription session for append';
        logger.warn('TranscriptionHandlers: Append text failed - no active session', {
          sessionId,
          activeSessionId,
        });
        throw new Error(error);
      }

      logger.info('TranscriptionHandlers: Appending final text', {
        sessionId,
        textLength: textChunk.length,
        preview: textChunk.substring(0, 100),
      });

      await this.deps.storage.transcriptions.appendText(sessionId, textChunk);

      logger.info('TranscriptionHandlers: Final text appended successfully', { sessionId });
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to append final text', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Replace full text of transcription session (batch-mode final)
   */
  private async handleReplaceFullText(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { sessionId, fullText } = ReplaceFullTextSchema.parse(input);

      const activeSessionId = this.deps.getActiveTranscriptionSessionId();
      if (!activeSessionId || activeSessionId !== sessionId) {
        const error = 'No active transcription session for replaceFullText';
        logger.warn('TranscriptionHandlers: Replace full text failed - no active session', {
          sessionId,
          activeSessionId,
        });
        throw new Error(error);
      }

      logger.info('TranscriptionHandlers: Replacing full text (batch final)', {
        sessionId,
        textLength: fullText.length,
      });

      await this.deps.storage.transcriptions.replaceFullText(sessionId, fullText);

      logger.info('TranscriptionHandlers: Full text replaced successfully', { sessionId });
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to replace full text', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Complete transcription session
   */
  private async handleCompleteSession(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { sessionId, endTime } = CompleteTranscriptionSchema.parse(input);

      const activeSessionId = this.deps.getActiveTranscriptionSessionId();
      if (!activeSessionId || activeSessionId !== sessionId) {
        const error = 'No active transcription session to complete';
        logger.warn('TranscriptionHandlers: Complete session failed - no active session', {
          sessionId,
          activeSessionId,
        });
        throw new Error(error);
      }

      logger.info('TranscriptionHandlers: Completing transcription session', {
        sessionId,
        endTime,
      });

      await this.deps.storage.transcriptions.completeSession(sessionId, endTime);

      // Clear active session
      this.deps.setActiveTranscriptionSessionId(null);

      // Trigger sync to push transcription to server
      this.notifyDataChanged();

      logger.info('TranscriptionHandlers: Transcription session completed', { sessionId });
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to complete session', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Apply refinement to transcription session
   */
  private async handleApplyRefinement(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { sessionId, segmentId, originalText, refinedText, confidenceImprovement, timestamp } =
        ApplyRefinementSchema.parse(input);

      logger.info('TranscriptionHandlers: Applying refinement', {
        sessionId,
        segmentId,
        originalLength: originalText.length,
        refinedLength: refinedText.length,
        confidenceImprovement,
      });

      await this.deps.storage.transcriptions.applyRefinement({
        sessionId,
        segmentId,
        originalText,
        refinedText,
        confidenceImprovement,
        timestamp,
      });

      logger.info('TranscriptionHandlers: Refinement applied successfully', {
        sessionId,
        segmentId,
      });
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to apply refinement', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List transcription sessions by note
   */
  private async handleListByNote(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { noteId } = ListByNoteSchema.parse(input);
      logger.debug('TranscriptionHandlers: Listing transcriptions by note', { noteId });

      const sessions = await this.deps.storage.transcriptions.listByNote(noteId);

      logger.debug('TranscriptionHandlers: Transcription sessions retrieved', {
        noteId,
        sessionCount: sessions.length,
      });
      return sessions;
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to list transcriptions by note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Get transcription session by ID
   */
  private async handleGetTranscription(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { sessionId } = GetTranscriptionSchema.parse(input);
      logger.debug('TranscriptionHandlers: Getting transcription session', { sessionId });

      const session = await this.deps.storage.transcriptions.getSession(sessionId);

      logger.debug('TranscriptionHandlers: Transcription session retrieved', {
        sessionId,
        found: !!session,
      });
      return session;
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to get transcription session', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Export transcription session
   */
  private async handleExportSession(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { sessionId, targetPath } = ExportTranscriptionSchema.parse(input);
      logger.info('TranscriptionHandlers: Exporting transcription session', {
        sessionId,
        hasTargetPath: !!targetPath,
      });

      const result = await this.deps.storage.transcriptions.exportSession(sessionId, targetPath);

      logger.info('TranscriptionHandlers: Transcription session exported', {
        sessionId,
        exportPath: result,
      });
      return result;
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to export transcription session', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List available faster-whisper models
   * Models are downloaded from HuggingFace on-demand
   */
  private async handleListModels(): Promise<string[]> {
    try {
      // Return valid faster-whisper model names
      // These will be auto-downloaded from HuggingFace when selected
      const models = [
        'tiny.en',
        'tiny',
        'base.en',
        'base',
        'small.en',
        'small',
        'medium.en',
        'medium',
        'large-v1',
        'large-v2',
        'large-v3',
        'turbo',
      ];

      logger.info('TranscriptionHandlers: Listing faster-whisper models', {
        models: models.length,
        modelList: models,
      });

      return models;
    } catch (error) {
      logger.warn('TranscriptionHandlers: Failed to list models', {
        error: error instanceof Error ? error.message : error,
      });
      return [];
    }
  }

  /**
   * Restart the transcription server with updated settings
   */
  private async handleRestartServer(): Promise<{ success: boolean; message?: string }> {
    try {
      if (!this.deps.restartTranscriptionServer) {
        throw new Error('Transcription server restart not available');
      }

      logger.info('TranscriptionHandlers: Restarting transcription server');
      await this.deps.restartTranscriptionServer();
      logger.info('TranscriptionHandlers: Transcription server restarted successfully');

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('TranscriptionHandlers: Failed to restart transcription server', {
        error: message,
      });
      return { success: false, message };
    }
  }

  /**
   * Get the current transcription server port
   */
  private handleGetServerPort(): { port: number } {
    const port = this.deps.getTranscriptionServerPort?.() ?? 8181;
    logger.debug('TranscriptionHandlers: Getting server port', { port });
    return { port };
  }

  /**
   * Get the recordings directory path (creates if doesn't exist)
   * Directory is created with restrictive permissions (0700) for privacy
   */
  private getRecordingsDir(): string {
    const userDataPath = app.getPath('userData');
    const recordingsDir = path.join(userDataPath, 'recordings');

    // Ensure directory exists with secure permissions
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true, mode: 0o700 });
      logger.info('TranscriptionHandlers: Created recordings directory', { recordingsDir });
    } else {
      // Ensure permissions are correct even if directory already exists
      try {
        fs.chmodSync(recordingsDir, 0o700);
      } catch {
        // Ignore chmod errors (e.g., on Windows)
      }
    }

    return recordingsDir;
  }

  /**
   * Save a WAV recording to disk and track in database
   */
  private async handleSaveRecording(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ filePath: string; success: boolean; durationMs: number; recordingId: string }> {
    try {
      const { sessionId, wavData } = SaveRecordingSchema.parse(input);

      const recordingsDir = this.getRecordingsDir();
      const fileName = `${sessionId}.wav`;
      const filePath = path.join(recordingsDir, fileName);

      logger.info('TranscriptionHandlers: Saving WAV recording', {
        sessionId,
        filePath,
        dataLength: wavData.length,
      });

      // Decode base64 and write to file with secure permissions (0600)
      const buffer = Buffer.from(wavData, 'base64');
      await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });

      // Calculate duration from WAV data
      // WAV header is 44 bytes, audio is mono 16-bit 16kHz PCM
      // Note: If stereo (for speaker attribution), channels = 2
      const headerSize = 44;
      const channels = 1; // Mono recording (getRecordedWavData creates mono)
      const bytesPerSample = 2; // 16-bit
      const sampleRate = 16000;
      const audioDataSize = buffer.length - headerSize;
      const durationMs = Math.round(
        (audioDataSize / (channels * bytesPerSample) / sampleRate) * 1000
      );

      // Create database record
      const recordingId = crypto.randomUUID();
      await this.deps.storage.audioRecordings.create({
        id: recordingId,
        transcriptionId: sessionId,
        fileName,
        filePath,
        fileSizeBytes: buffer.length,
        durationMs,
        mimeType: 'audio/wav',
      });

      logger.info('TranscriptionHandlers: WAV recording saved successfully', {
        sessionId,
        filePath,
        fileSize: buffer.length,
        durationMs,
        recordingId,
      });

      return { filePath, success: true, durationMs, recordingId };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to save WAV recording', {
        error: error instanceof Error ? error.message : error,
        input:
          typeof input === 'object' && input !== null
            ? { sessionId: (input as { sessionId?: string }).sessionId }
            : undefined,
      });
      throw error;
    }
  }

  /**
   * Get the path to a saved recording
   */
  private handleGetRecordingPath(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): { filePath: string | null; exists: boolean } {
    try {
      const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(input);

      const recordingsDir = this.getRecordingsDir();
      const fileName = `${sessionId}.wav`;
      const filePath = path.join(recordingsDir, fileName);

      const exists = fs.existsSync(filePath);

      logger.debug('TranscriptionHandlers: Checking recording path', {
        sessionId,
        filePath,
        exists,
      });

      return { filePath: exists ? filePath : null, exists };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to get recording path', {
        error: error instanceof Error ? error.message : error,
      });
      return { filePath: null, exists: false };
    }
  }

  /**
   * Get recording metadata from database
   */
  private async handleGetRecordingWithMeta(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{
    id: string | null;
    filePath: string | null;
    durationMs: number | null;
    exists: boolean;
  }> {
    try {
      const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(input);

      // Get recording from database
      const recording = await this.deps.storage.audioRecordings.getByTranscriptionId(sessionId);

      if (!recording) {
        // Fallback: check if file exists on disk (for recordings saved before DB tracking)
        const recordingsDir = this.getRecordingsDir();
        const fileName = `${sessionId}.wav`;
        const filePath = path.join(recordingsDir, fileName);
        const exists = fs.existsSync(filePath);

        return {
          id: null,
          filePath: exists ? filePath : null,
          durationMs: null,
          exists,
        };
      }

      // Verify file still exists on disk
      const exists = fs.existsSync(recording.filePath);

      return {
        id: recording.id,
        filePath: exists ? recording.filePath : null,
        durationMs: recording.durationMs,
        exists,
      };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to get recording with meta', {
        error: error instanceof Error ? error.message : error,
      });
      return { id: null, filePath: null, durationMs: null, exists: false };
    }
  }

  /**
   * Refine transcription using second pass with higher beam size
   */
  private async handleRefineTranscription(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ text: string; success: boolean; usedHints?: boolean }> {
    try {
      const { sessionId, hints } = RefineTranscriptionSchema.parse(input);

      // Get recording path
      const recordingsDir = this.getRecordingsDir();
      const fileName = `${sessionId}.wav`;
      const wavPath = path.join(recordingsDir, fileName);

      if (!fs.existsSync(wavPath)) {
        throw new Error(`Recording not found: ${wavPath}`);
      }

      logger.info('TranscriptionHandlers: Starting refinement', {
        sessionId,
        wavPath,
        hasHints: !!hints,
        hintsLength: hints?.length,
      });

      if (!this.deps.refineTranscription) {
        throw new Error('Refinement not available - transcription server not configured');
      }

      const result = await this.deps.refineTranscription(wavPath, hints);

      logger.info('TranscriptionHandlers: Refinement completed', {
        sessionId,
        textLength: result.text.length,
        usedHints: result.used_hints,
      });

      return { text: result.text, success: true, usedHints: result.used_hints };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to refine transcription', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Save user correction to transcription text
   * This allows users to fix transcription errors (MS Teams-like experience)
   */
  private async handleSaveCorrection(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean }> {
    try {
      const { sessionId, originalText, correctedText } = SaveCorrectionSchema.parse(input);

      logger.info('TranscriptionHandlers: Saving user correction', {
        sessionId,
        originalLength: originalText.length,
        correctedLength: correctedText.length,
      });

      await this.deps.storage.transcriptions.saveCorrection(sessionId, originalText, correctedText);

      logger.info('TranscriptionHandlers: User correction saved successfully', { sessionId });

      return { success: true };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to save user correction', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Save transcription segments with timestamps
   */
  private async handleSaveSegments(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean; segmentCount: number }> {
    try {
      const { sessionId, segments } = SaveSegmentsSchema.parse(input);

      logger.info('TranscriptionHandlers: Saving transcription segments', {
        sessionId,
        segmentCount: segments.length,
      });

      await this.deps.storage.transcriptions.saveSegments(
        sessionId,
        segments as Array<{
          segmentId: string;
          text: string;
          startTime: number;
          endTime: number;
          sequenceOrder: number;
        }>
      );

      logger.info('TranscriptionHandlers: Segments saved successfully', {
        sessionId,
        segmentCount: segments.length,
      });

      return { success: true, segmentCount: segments.length };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to save segments', {
        error: error instanceof Error ? error.message : error,
        input:
          typeof input === 'object' && input !== null
            ? { sessionId: (input as { sessionId?: string }).sessionId }
            : undefined,
      });
      throw error;
    }
  }

  /**
   * Get transcription segments for a session
   */
  private async handleGetSegments(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<
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
    try {
      const { sessionId } = GetSegmentsSchema.parse(input);

      logger.debug('TranscriptionHandlers: Getting segments', { sessionId });

      const segments = await this.deps.storage.transcriptions.getSegments(sessionId);

      logger.debug('TranscriptionHandlers: Segments retrieved', {
        sessionId,
        segmentCount: segments.length,
      });

      return segments;
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to get segments', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Mark a segment as user-edited
   */
  private async handleMarkSegmentEdited(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ success: boolean }> {
    try {
      const { sessionId, segmentId, newText } = MarkSegmentEditedSchema.parse(input);

      logger.info('TranscriptionHandlers: Marking segment as edited', {
        sessionId,
        segmentId,
        newTextLength: newText.length,
      });

      await this.deps.storage.transcriptions.markSegmentEdited(sessionId, segmentId, newText);

      logger.info('TranscriptionHandlers: Segment marked as edited', { sessionId, segmentId });

      return { success: true };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to mark segment edited', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List all transcriptions with note titles and preview text
   */
  private async handleListAllWithDetails(): Promise<
    Array<{
      id: string;
      noteId: string;
      noteTitle: string;
      startTime: number;
      endTime: number | null;
      durationMs: number | null;
      wordCount: number;
      charCount: number;
      previewText: string;
    }>
  > {
    try {
      logger.debug('TranscriptionHandlers: Listing all transcriptions with details');

      const transcriptions = await this.deps.storage.transcriptions.listAllWithDetails();

      logger.debug('TranscriptionHandlers: Retrieved transcriptions', {
        count: transcriptions.length,
      });

      return transcriptions;
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to list all transcriptions', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get current active transcription session info
   */
  getActiveSessionInfo(): { sessionId: string | null } {
    return {
      sessionId: this.deps.getActiveTranscriptionSessionId(),
    };
  }

  /**
   * Cleanup and unregister handlers
   */
  cleanup(): void {
    logger.debug('TranscriptionHandlers: Cleaning up IPC handlers');

    const handlers = [
      'transcription:startSession',
      'transcription:appendFinalText',
      'transcription:replaceFullText',
      'transcription:completeSession',
      'transcription:applyRefinement',
      'transcription:listByNote',
      'transcription:get',
      'transcription:exportSession',
      'transcription:listModels',
      'transcription:restartServer',
      'transcription:getServerPort',
      'transcription:saveRecording',
      'transcription:refine',
      'transcription:getRecordingPath',
      'transcription:getRecordingWithMeta',
      'transcription:saveCorrection',
      'transcription:saveSegments',
      'transcription:getSegments',
      'transcription:markSegmentEdited',
      'transcription:listAllWithDetails',
    ];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeAllListeners(handler);
      } catch (error) {
        logger.warn('TranscriptionHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    // Clear active session on cleanup
    this.deps.setActiveTranscriptionSessionId(null);

    logger.debug('TranscriptionHandlers: Cleanup completed');
  }

  /**
   * DEV ONLY: Create a transcription session with pasted text
   * This bypasses the normal recording flow for testing purposes
   */
  private async handleCreateDevSession(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<{ sessionId: string; success: boolean }> {
    try {
      // Only allow in development
      if (app.isPackaged) {
        throw new Error('Dev session creation is only available in development mode');
      }

      const { binderId, noteId, text } = CreateDevTranscriptionSchema.parse(input);

      logger.info('TranscriptionHandlers: Creating dev transcription session', {
        binderId,
        noteId,
        textLength: text.length,
      });

      // Create the transcription session
      const sessionId = await this.deps.storage.transcriptions.createSession(
        binderId,
        noteId,
        'en' // Default to English for dev sessions
      );

      // Immediately append the full text
      await this.deps.storage.transcriptions.appendText(sessionId, text);

      // Complete the session
      const endTime = Date.now();
      await this.deps.storage.transcriptions.completeSession(sessionId, endTime);

      logger.info('TranscriptionHandlers: Dev transcription session created successfully', {
        sessionId,
        charCount: text.length,
        wordCount: text.split(/\s+/).length,
      });

      return { sessionId, success: true };
    } catch (error) {
      logger.error('TranscriptionHandlers: Failed to create dev session', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }
}
