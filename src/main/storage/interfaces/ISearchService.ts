/**
 * Search service interface - Full-text search operations
 */

import type { SearchResult } from '../types/entities';

export interface ISearchService {
  /**
   * Perform full-text search across notes and transcriptions
   */
  search(query: string, limit?: number): Promise<SearchResult[]>;
  
  /**
   * Index a note for full-text search
   */
  indexNote(noteId: string, title: string, content: string): Promise<void>;
  
  /**
   * Remove note from search index
   */
  removeNoteFromIndex(noteId: string): Promise<void>;
  
  /**
   * Index a transcription for full-text search
   */
  indexTranscription(sessionId: string, content: string): Promise<void>;
  
  /**
   * Remove transcription from search index
   */
  removeTranscriptionFromIndex(sessionId: string): Promise<void>;
  
  /**
   * Rebuild the full-text search index
   */
  rebuildIndex(): Promise<{ notes: number; transcriptions: number }>;
  
  /**
   * Get search index statistics
   */
  getIndexStats(): Promise<{
    totalNotes: number;
    totalTranscriptions: number;
    lastRebuildAt: Date | null;
  }>;
  
  /**
   * Optimize the search index for performance
   */
  optimizeIndex(): Promise<void>;
  
  /**
   * Validate search index integrity
   */
  validateIndex(): Promise<{
    valid: boolean;
    missingEntries: number;
    orphanedEntries: number;
  }>;
}