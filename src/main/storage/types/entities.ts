/**
 * Domain entity types - Business logic representations
 */

export type Binder = {
  id: string;
  userId: string | null;
  name: string;
  sortIndex: number;
  color: string | null;
  icon: string | null;
  isTeamShared: boolean;
  remoteId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
};

export type NoteSummary = {
  id: string;
  binder_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  pinned: number;
  starred?: number; // Optional for backward compatibility
  archived?: number; // Optional for backward compatibility
  updatedAt: Date; // Keep for backward compatibility
};

export type NoteMeta = {
  id: string;
  binderId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: boolean;
  pinned: boolean;
  starred: boolean; // Required field (not optional)
  archived: boolean; // Required field for archive status
};

export type NoteContent = {
  lexicalJson: string;
  plainText: string;
};

export type NoteFull = {
  meta: NoteMeta;
  content: NoteContent;
};

export type NoteRevision = {
  revisionId: number;
  noteId: string;
  lexicalJson: string;
  plainText: string;
  hash: string;
  createdAt: Date;
};

// UserProfile is now defined in interfaces/IUserService.ts
// Re-export for backward compatibility
export type { UserProfile } from '../interfaces/IUserService';

export type TranscriptionSession = {
  id: string;
  binderId: string;
  noteId: string;
  language: string;
  status: 'recording' | 'completing' | 'completed';
  startTime: Date;
  endTime: Date | null;
  durationMs: number | null;
  charCount: number;
  wordCount: number;
  deleted: number; // Integer: 0 = not deleted, 1 = deleted (matches database)
  createdAt: Date;
  updatedAt: Date;
};

export type SearchResult = {
  type: 'note' | 'transcription' | 'tag';
  id: string;
  noteId: string | null; // For notes, same as id. For transcriptions, the associated note's id. For tags, null.
  binderId: string | null; // For tags, null.
  title: string;
  snippet: string;
  updatedAt: Date;
  // Tag-specific fields
  tagColor?: string | null;
  tagNoteCount?: number;
};

export type Setting = {
  key: string;
  value: string;
};

// Input types for operations
export type CreateNoteInput = {
  binderId: string;
};

export type SaveNoteInput = {
  noteId: string;
  lexicalJson: string;
  plainText: string;
  title?: string;
};

export type UpdateBinderInput = {
  id: string;
  name?: string;
  color?: string | null;
  icon?: string | null;
  isTeamShared?: boolean;
};

export type UpdateUserProfileInput = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  avatarPath?: string | null;
};

export type Summary = {
  id: string;
  transcriptionId: string;
  summaryText: string | null;
  summaryTextEncrypted: string | null;
  isSummaryEncrypted: boolean;
  summaryType: string;
  processingTimeMs: number | null;
  modelUsed: string | null;
  backendType: string | null;
  pipelineUsed: boolean;
  syncVersion: number;
  checksum: string | null;
  deleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  serverUpdatedAt: Date | null;
};

export type CreateSummaryInput = {
  id: string;
  transcriptionId: string;
  summaryText: string;
  summaryType?: string;
  processingTimeMs?: number;
  modelUsed?: string;
  backendType?: string;
  pipelineUsed?: boolean;
};

export type UpdateSummaryInput = {
  id: string;
  summaryText?: string;
  summaryType?: string;
  processingTimeMs?: number;
  modelUsed?: string;
  backendType?: string;
  pipelineUsed?: boolean;
};

// Audio recording entity (local-only, not synced)
export type AudioRecording = {
  id: string;
  transcriptionId: string;
  fileName: string;
  filePath: string;
  fileSizeBytes: number | null;
  durationMs: number | null;
  mimeType: string;
  createdAt: Date;
  deleted: boolean;
};

export type CreateAudioRecordingInput = {
  id: string;
  transcriptionId: string;
  fileName: string;
  filePath: string;
  fileSizeBytes?: number;
  durationMs?: number;
  mimeType?: string;
};
