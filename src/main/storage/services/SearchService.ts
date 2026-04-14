import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { logger } from '../../logger';
import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { ISearchService } from '../interfaces/ISearchService';
import { ISettingsService } from '../interfaces/ISettingsService';
import { SearchResult } from '../types/entities';

/**
 * SearchService - Full-text search operations
 */
export class SearchService implements ISearchService {
  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager,
    private settingsService: ISettingsService
  ) {
    // Database will be accessed lazily when needed
  }

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Perform full-text search across notes, transcriptions, and tags
   */
  async search(query: string, limit: number = 50): Promise<SearchResult[]> {
    // Sanitize the search term to prevent FTS injection
    const sanitizedQuery = query.replace(/["']/g, ' ').trim();

    if (!sanitizedQuery) {
      return [];
    }

    const results: SearchResult[] = [];

    // Search notes and transcriptions via FTS
    try {
      const ftsStmt = this.db.prepare(`
        SELECT 'note' AS type, f.note_id AS id,
               f.note_id AS noteId,
               n.binder_id AS binderId,
               n.title AS title,
               snippet(notes_fts, 2, '<b>', '</b>', '…', 10) AS snippet,
               n.updated_at AS updatedAt,
               NULL AS tagColor,
               NULL AS tagNoteCount
        FROM notes_fts f
        JOIN notes n ON n.id = f.note_id
        WHERE notes_fts MATCH ? AND n.deleted = 0
        UNION ALL
        SELECT 'transcription' AS type, s.id AS id,
               s.note_id AS noteId,
               s.binder_id AS binderId,
               COALESCE(NULLIF(n.title, ''), 'Untitled') AS title,
               snippet(transcriptions_fts, 1, '<b>', '</b>', '…', 10) AS snippet,
               s.updated_at AS updatedAt,
               NULL AS tagColor,
               NULL AS tagNoteCount
        FROM transcriptions_fts f2
        JOIN transcription_sessions s ON s.id = f2.session_id
        JOIN notes n ON n.id = s.note_id
        WHERE transcriptions_fts MATCH ? AND s.status = 'completed' AND n.deleted = 0
        ORDER BY updatedAt DESC
        LIMIT ?
      `);

      const ftsRows = ftsStmt.all(sanitizedQuery, sanitizedQuery, limit) as Array<{
        type: 'note' | 'transcription';
        id: string;
        noteId: string;
        binderId: string;
        title: string;
        snippet: string;
        updatedAt: number;
        tagColor: string | null;
        tagNoteCount: number | null;
      }>;

      for (const row of ftsRows) {
        results.push({
          type: row.type,
          id: row.id,
          noteId: row.noteId,
          binderId: row.binderId,
          title: row.title,
          snippet: row.snippet,
          updatedAt: new Date(row.updatedAt),
        });
      }
    } catch (error) {
      // If FTS is not available or there's an error, log but continue with tag search
      logger.warn(
        'FTS search failed, continuing with tag search: %s',
        error instanceof Error ? error.message : String(error)
      );
    }

    // Search tags by name (case-insensitive LIKE)
    try {
      const tagStmt = this.db.prepare(`
        SELECT t.id, t.name, t.color, t.updated_at AS updatedAt,
               (SELECT COUNT(*) FROM note_tags nt WHERE nt.tag_id = t.id AND nt.deleted = 0) AS noteCount
        FROM tags t
        WHERE t.name LIKE ? AND t.deleted = 0
        ORDER BY t.name ASC
        LIMIT ?
      `);

      const tagRows = tagStmt.all(
        `%${sanitizedQuery}%`,
        Math.max(10, Math.floor(limit / 5))
      ) as Array<{
        id: string;
        name: string;
        color: string | null;
        updatedAt: number;
        noteCount: number;
      }>;

      for (const row of tagRows) {
        results.push({
          type: 'tag',
          id: row.id,
          noteId: null,
          binderId: null,
          title: row.name,
          snippet: `${row.noteCount} note${row.noteCount === 1 ? '' : 's'}`,
          updatedAt: new Date(row.updatedAt),
          tagColor: row.color,
          tagNoteCount: row.noteCount,
        });
      }
    } catch (error) {
      logger.warn('Tag search failed: %s', error instanceof Error ? error.message : String(error));
    }

    // Sort combined results by updatedAt descending, but keep tags at the end
    results.sort((a, b) => {
      // Tags go after notes/transcriptions
      if (a.type === 'tag' && b.type !== 'tag') return 1;
      if (a.type !== 'tag' && b.type === 'tag') return -1;
      // Within same category, sort by updatedAt descending
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    });

    return results.slice(0, limit);
  }

  /**
   * Index a note for full-text search
   */
  async indexNote(noteId: string, title: string, content: string): Promise<void> {
    await this.transactionManager.execute(() => {
      try {
        // Remove existing entry
        this.db.prepare('DELETE FROM notes_fts WHERE note_id=?').run(noteId);

        // Insert new entry
        this.db
          .prepare('INSERT INTO notes_fts(note_id,title,content) VALUES (?,?,?)')
          .run(noteId, title, content);
      } catch (error) {
        // Ignore FTS errors if table doesn't exist
        logger.warn(
          'Failed to index note for search: %s',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  /**
   * Remove note from search index
   */
  async removeNoteFromIndex(noteId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      try {
        this.db.prepare('DELETE FROM notes_fts WHERE note_id=?').run(noteId);
      } catch (error) {
        // Ignore FTS errors if table doesn't exist
        logger.warn(
          'Failed to remove note from search index: %s',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  /**
   * Index a transcription for full-text search
   */
  async indexTranscription(sessionId: string, content: string): Promise<void> {
    await this.transactionManager.execute(() => {
      try {
        // Remove existing entry
        this.db.prepare('DELETE FROM transcriptions_fts WHERE session_id=?').run(sessionId);

        // Insert new entry
        this.db
          .prepare('INSERT INTO transcriptions_fts(session_id,content) VALUES (?,?)')
          .run(sessionId, content);
      } catch (error) {
        // Ignore FTS errors if table doesn't exist
        logger.warn(
          'Failed to index transcription for search: %s',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  /**
   * Remove transcription from search index
   */
  async removeTranscriptionFromIndex(sessionId: string): Promise<void> {
    await this.transactionManager.execute(() => {
      try {
        this.db.prepare('DELETE FROM transcriptions_fts WHERE session_id=?').run(sessionId);
      } catch (error) {
        // Ignore FTS errors if table doesn't exist
        logger.warn(
          'Failed to remove transcription from search index: %s',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  /**
   * Rebuild the full-text search index
   */
  async rebuildIndex(): Promise<{ notes: number; transcriptions: number }> {
    return await this.transactionManager.execute(() => {
      let notesCount = 0;
      let transcriptionsCount = 0;

      try {
        // Clear existing FTS entries
        this.db.prepare('DELETE FROM notes_fts').run();

        // Rebuild notes index
        const notesStmt = this.db.prepare(`
          SELECT n.id, n.title, r.plaintext
          FROM notes n
          JOIN note_content_head h ON h.note_id = n.id
          JOIN note_revisions r ON r.revision_id = h.revision_id
          WHERE n.deleted = 0
        `);

        const notes = notesStmt.all() as Array<{
          id: string;
          title: string;
          plaintext: string;
        }>;

        const insertNoteStmt = this.db.prepare(
          'INSERT INTO notes_fts(note_id,title,content) VALUES (?,?,?)'
        );

        for (const note of notes) {
          insertNoteStmt.run(note.id, note.title, note.plaintext);
          notesCount++;
        }
      } catch (error) {
        logger.warn(
          'Failed to rebuild notes FTS index: %s',
          error instanceof Error ? error.message : String(error)
        );
      }

      try {
        // Skip transcription FTS rebuild - individual session indexing handles this
        // Don't clear existing entries as they are properly maintained via appendText
        logger.info(
          'Transcription index rebuild skipped - existing entries preserved, relies on individual session indexing'
        );

        // Count existing transcription entries
        const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM transcriptions_fts');
        const countResult = countStmt.get() as { count: number };
        transcriptionsCount = countResult.count;
      } catch (error) {
        logger.warn(
          'Failed to rebuild transcriptions FTS index: %s',
          error instanceof Error ? error.message : String(error)
        );
      }

      // Record rebuild timestamp
      const now = new Date().toISOString();
      this.settingsService.set('search.last_rebuild_at', now).catch((error) => {
        logger.warn(
          'Failed to update last_rebuild_at setting: %s',
          error instanceof Error ? error.message : String(error)
        );
      });

      return { notes: notesCount, transcriptions: transcriptionsCount };
    });
  }

  /**
   * Get search index statistics
   */
  async getIndexStats(): Promise<{
    totalNotes: number;
    totalTranscriptions: number;
    lastRebuildAt: Date | null;
  }> {
    let totalNotes = 0;
    let totalTranscriptions = 0;

    try {
      const notesRow = this.db.prepare('SELECT COUNT(*) as count FROM notes_fts').get() as {
        count: number;
      };
      totalNotes = notesRow.count;
    } catch (error) {
      logger.warn(
        'Failed to get notes FTS count: %s',
        error instanceof Error ? error.message : String(error)
      );
    }

    try {
      const transcriptionsRow = this.db
        .prepare('SELECT COUNT(*) as count FROM transcriptions_fts')
        .get() as { count: number };
      totalTranscriptions = transcriptionsRow.count;
    } catch (error) {
      logger.warn(
        'Failed to get transcriptions FTS count: %s',
        error instanceof Error ? error.message : String(error)
      );
    }

    const lastRebuildStr = await this.settingsService.get('search.last_rebuild_at');
    const lastRebuildAt = lastRebuildStr ? new Date(lastRebuildStr) : null;

    return {
      totalNotes,
      totalTranscriptions,
      lastRebuildAt,
    };
  }

  /**
   * Optimize the search index for performance
   */
  async optimizeIndex(): Promise<void> {
    await this.transactionManager.execute(() => {
      try {
        // Optimize notes FTS index
        this.db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('optimize')").run();
      } catch (error) {
        logger.warn(
          'Failed to optimize notes FTS index: %s',
          error instanceof Error ? error.message : String(error)
        );
      }

      try {
        // Optimize transcriptions FTS index
        this.db
          .prepare("INSERT INTO transcriptions_fts(transcriptions_fts) VALUES('optimize')")
          .run();
      } catch (error) {
        logger.warn(
          'Failed to optimize transcriptions FTS index: %s',
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  /**
   * Validate search index integrity
   */
  async validateIndex(): Promise<{
    valid: boolean;
    missingEntries: number;
    orphanedEntries: number;
  }> {
    let missingEntries = 0;
    let orphanedEntries = 0;

    try {
      // Check for notes that should be indexed but aren't
      const missingNotesStmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM notes n
        LEFT JOIN notes_fts f ON f.note_id = n.id
        WHERE n.deleted = 0 AND f.note_id IS NULL
      `);
      const missingNotesRow = missingNotesStmt.get() as { count: number };
      missingEntries += missingNotesRow.count;

      // Check for orphaned FTS entries (notes that no longer exist)
      const orphanedNotesStmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM notes_fts f
        LEFT JOIN notes n ON n.id = f.note_id
        WHERE n.id IS NULL OR n.deleted = 1
      `);
      const orphanedNotesRow = orphanedNotesStmt.get() as { count: number };
      orphanedEntries += orphanedNotesRow.count;

      // Check for transcriptions that should be indexed but aren't
      const missingTranscriptionsStmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM transcription_sessions s
        LEFT JOIN transcriptions_fts f ON f.session_id = s.id
        WHERE s.status = 'completed' AND f.session_id IS NULL
      `);
      const missingTranscriptionsRow = missingTranscriptionsStmt.get() as { count: number };
      missingEntries += missingTranscriptionsRow.count;

      // Check for orphaned transcription FTS entries
      const orphanedTranscriptionsStmt = this.db.prepare(`
        SELECT COUNT(*) as count
        FROM transcriptions_fts f
        LEFT JOIN transcription_sessions s ON s.id = f.session_id
        WHERE s.id IS NULL OR s.status != 'completed'
      `);
      const orphanedTranscriptionsRow = orphanedTranscriptionsStmt.get() as { count: number };
      orphanedEntries += orphanedTranscriptionsRow.count;
    } catch (error) {
      logger.warn(
        'Failed to validate search index: %s',
        error instanceof Error ? error.message : String(error)
      );
      return { valid: false, missingEntries: 0, orphanedEntries: 0 };
    }

    return {
      valid: missingEntries === 0 && orphanedEntries === 0,
      missingEntries,
      orphanedEntries,
    };
  }
}
