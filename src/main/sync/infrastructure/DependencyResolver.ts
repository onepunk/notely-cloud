import { logger } from '../../logger';
import type { IStorageService } from '../../storage/interfaces';
import type { BinderRow } from '../../storage/types/database';

interface SyncChange {
  id: string;
  [key: string]: unknown;
}

interface BinderSyncData extends SyncChange {
  name: string;
  sort_index: number;
  color: string | null;
  icon: string | null;
  is_team_shared: boolean;
}

interface NoteSyncData extends SyncChange {
  binder_id: string;
  title: string;
  content: string | null;
  plaintext: string | null;
  pinned: boolean;
}

interface TranscriptionSyncData extends SyncChange {
  note_id: string;
  transcription_text: string;
}

export interface LocalChanges {
  binders: BinderSyncData[];
  notes: NoteSyncData[];
  transcriptions: TranscriptionSyncData[];
}

/**
 * DependencyResolver - Ensures all entity dependencies are included in sync payload
 * to prevent foreign key constraint violations on the server
 */
export class DependencyResolver {
  constructor(private storage: IStorageService) {}

  /**
   * Resolve all dependencies for a set of changes
   * Ensures that all referenced entities are included in the sync payload
   */
  async resolveDependencies(changes: LocalChanges): Promise<LocalChanges> {
    logger.debug('DependencyResolver: Starting dependency resolution', {
      bindersCount: changes.binders.length,
      notesCount: changes.notes.length,
      transcriptionsCount: changes.transcriptions.length,
    });

    // Collect all required entity IDs from the changes
    const requiredBinderIds = new Set<string>();
    const requiredNoteIds = new Set<string>();

    // Collect binder dependencies from notes
    for (const note of changes.notes) {
      if (note.binder_id) {
        requiredBinderIds.add(note.binder_id);
      }
    }

    // Collect note dependencies from transcriptions
    for (const transcription of changes.transcriptions) {
      if (transcription.note_id) {
        requiredNoteIds.add(transcription.note_id);
      }
    }

    logger.debug('DependencyResolver: Found dependencies', {
      requiredBinders: requiredBinderIds.size,
      requiredNotes: requiredNoteIds.size,
    });

    // Get missing binders that aren't already in the changeset
    const existingBinderIds = new Set(changes.binders.map((b) => b.id));
    const missingBinderIds = [...requiredBinderIds].filter((id) => !existingBinderIds.has(id));

    const additionalBinders = await this.getRequiredBinders(missingBinderIds);
    logger.info('DependencyResolver: Adding missing binders', {
      count: additionalBinders.length,
      ids: missingBinderIds,
    });

    // Get missing notes that aren't already in the changeset
    const existingNoteIds = new Set(changes.notes.map((n) => n.id));
    const missingNoteIds = [...requiredNoteIds].filter((id) => !existingNoteIds.has(id));

    const additionalNotes = await this.getRequiredNotes(missingNoteIds);
    logger.info('DependencyResolver: Adding missing notes', {
      count: additionalNotes.length,
      ids: missingNoteIds,
    });

    // Return changes with all dependencies included
    const resolvedChanges = {
      binders: [...changes.binders, ...additionalBinders],
      notes: [...changes.notes, ...additionalNotes],
      transcriptions: changes.transcriptions,
    };

    logger.info('DependencyResolver: Dependency resolution complete', {
      totalBinders: resolvedChanges.binders.length,
      totalNotes: resolvedChanges.notes.length,
      totalTranscriptions: resolvedChanges.transcriptions.length,
      addedBinders: additionalBinders.length,
      addedNotes: additionalNotes.length,
    });

    return resolvedChanges;
  }

  /**
   * Get required binders by their IDs
   */
  private async getRequiredBinders(binderIds: string[]): Promise<BinderSyncData[]> {
    if (binderIds.length === 0) {
      return [];
    }

    // Use efficient batch fetch
    const binderRows = await this.storage.binders.getByIds(binderIds);

    if (binderRows.length !== binderIds.length) {
      const foundIds = new Set(binderRows.map((b) => b.id));
      const missingIds = binderIds.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        logger.warn('DependencyResolver: Some binders not found', { missingIds });
      }
    }

    return binderRows.map((binder) => this.convertBinderToSyncData(binder));
  }

  /**
   * Get required notes by their IDs
   */
  private async getRequiredNotes(noteIds: string[]): Promise<NoteSyncData[]> {
    if (noteIds.length === 0) {
      return [];
    }

    // Get note summaries first (efficient batch fetch)
    const noteSummaries = await this.storage.notes.getByIds(noteIds);

    if (noteSummaries.length !== noteIds.length) {
      const foundIds = new Set(noteSummaries.map((n) => n.id));
      const missingIds = noteIds.filter((id) => !foundIds.has(id));
      if (missingIds.length > 0) {
        logger.warn('DependencyResolver: Some notes not found', { missingIds });
      }
    }

    const notes: NoteSyncData[] = [];

    // Fetch full content for each note
    for (const summary of noteSummaries) {
      try {
        const fullNote = await this.storage.notes.get(summary.id);

        const noteSyncData: NoteSyncData = {
          id: fullNote.meta.id,
          binder_id: fullNote.meta.binderId,
          title: fullNote.meta.title,
          content: fullNote.content.lexicalJson,
          plaintext: fullNote.content.plainText,
          pinned: fullNote.meta.pinned,
          desktop_user_uuid: '', // Will be filled by SyncEngine
          created_at: fullNote.meta.createdAt.getTime(),
          updated_at: fullNote.meta.updatedAt.getTime(),
          deleted: false,
          sync_version: 1,
          checksum: '', // Will be calculated by SyncEngine
        };

        notes.push(noteSyncData);
      } catch (error) {
        logger.warn('DependencyResolver: Error fetching note content', {
          noteId: summary.id,
          error: error instanceof Error ? error.message : error,
        });
      }
    }

    return notes;
  }

  /**
   * Convert a BinderRow to BinderSyncData
   */
  private convertBinderToSyncData(binder: BinderRow): BinderSyncData {
    return {
      id: binder.id,
      desktop_user_uuid: '', // Will be filled by SyncEngine
      name: binder.name,
      sort_index: binder.sort_index,
      color: binder.color,
      icon: binder.icon,
      is_team_shared: binder.is_team_shared === 1,
      created_at: binder.created_at,
      updated_at: binder.updated_at,
      deleted: binder.deleted === 1,
      sync_version: 1,
      checksum: '', // Will be calculated by SyncEngine
    };
  }
}
