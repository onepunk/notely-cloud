import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import { type IStorageService } from '../storage/index';
import { UNASSIGNED_BINDER_ID } from '../storage/migrations/seeds/defaultBinders';
import type { NoteSummary } from '../storage/types/entities';

// Validation schemas
const CreateNoteSchema = z.object({ binderId: z.string().min(1) });
const SaveNoteSchema = z.object({
  noteId: z.string().min(1),
  lexicalJson: z.string().min(1),
  plainText: z.string(),
  title: z.string().optional(),
});
const GetNoteSchema = z.object({ noteId: z.string().min(1) });
const ListNotesSchema = z.object({ binderId: z.string().min(1) });
const DeleteNoteSchema = z.object({ noteId: z.string().min(1) });
const MoveNoteSchema = z.object({
  noteId: z.string().min(1),
  binderId: z.string().min(1),
});
const SearchSchema = z.object({ q: z.string().min(1) });
const SetStarredSchema = z.object({
  noteId: z.string().min(1),
  starred: z.boolean(),
});
const SetArchivedSchema = z.object({
  noteId: z.string().min(1),
  archived: z.boolean(),
});
const ListNotesByDateRangeSchema = z
  .object({
    start: z.number(),
    end: z.number(),
  })
  .refine(({ start, end }) => end >= start, {
    message: 'End timestamp must be greater than or equal to start timestamp',
  });

const CreateBinderSchema = z.object({
  name: z.string().min(1),
  user_profile_id: z.string().optional().nullable(),
});
const RenameBinderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
const UpdateBinderSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  is_team_shared: z.number().optional(),
});
const DeleteBinderSchema = z.object({ id: z.string().min(1) });
const ReorderBindersSchema = z.object({
  order: z.array(z.string().min(1)).min(1),
});

// Conflict-related schemas (Phase 5)
const GetConflictsForNoteSchema = z.object({
  noteId: z.string().min(1),
});
const ResolveConflictSchema = z.object({
  conflictNoteId: z.string().min(1),
  canonicalNoteId: z.string().min(1),
});
const DeleteConflictSchema = z.object({
  conflictNoteId: z.string().min(1),
});

export interface StorageHandlersDependencies {
  storage: IStorageService;
  mainWindow: BrowserWindow | null;
  /** Callback to notify when local data changes (triggers debounced sync) */
  onLocalChange?: () => void;
}

/**
 * StorageHandlers manages all IPC handlers related to notes, binders, and search operations.
 * This includes CRUD operations for notes and binders, as well as search functionality.
 */
export class StorageHandlers {
  constructor(private deps: StorageHandlersDependencies) {}

  /**
   * Notify renderer and trigger debounced sync for local changes
   */
  private notifyDataChanged(): void {
    if (this.deps.mainWindow) {
      this.deps.mainWindow.webContents.send('notes:changed');
    }
    this.deps.onLocalChange?.();
  }

  /**
   * Register all storage-related IPC handlers
   */
  register(): void {
    logger.debug('StorageHandlers: Registering IPC handlers');

    // Notes IPC handlers
    ipcMain.handle('storage:createNote', this.handleCreateNote.bind(this));
    ipcMain.handle('storage:saveNote', this.handleSaveNote.bind(this));
    ipcMain.handle('storage:getNote', this.handleGetNote.bind(this));
    ipcMain.handle('storage:listNotesByBinder', this.handleListNotesByBinder.bind(this));
    ipcMain.handle('storage:listUnassignedNotes', this.handleListUnassignedNotes.bind(this));
    ipcMain.handle('storage:listAllNotes', this.handleListAllNotes.bind(this));
    ipcMain.handle(
      'storage:listNotesByCreatedBetween',
      this.handleListNotesByCreatedBetween.bind(this)
    );
    ipcMain.handle('storage:listDeletedNotes', this.handleListDeletedNotes.bind(this));
    ipcMain.handle('storage:emptyTrash', this.handleEmptyTrash.bind(this));
    ipcMain.handle('storage:deleteNote', this.handleDeleteNote.bind(this));
    ipcMain.handle('storage:moveNote', this.handleMoveNote.bind(this));
    ipcMain.handle('storage:setStarred', this.handleSetStarred.bind(this));
    ipcMain.handle('storage:listStarredNotes', this.handleListStarredNotes.bind(this));
    ipcMain.handle('storage:setArchived', this.handleSetArchived.bind(this));
    ipcMain.handle('storage:listArchivedNotes', this.handleListArchivedNotes.bind(this));
    ipcMain.handle('storage:search', this.handleSearch.bind(this));

    // Binders IPC handlers
    ipcMain.handle('storage:listBinders', this.handleListBinders.bind(this));
    ipcMain.handle('storage:getDefaultBinderId', this.handleGetDefaultBinderId.bind(this));
    ipcMain.handle('storage:createBinder', this.handleCreateBinder.bind(this));
    ipcMain.handle('storage:renameBinder', this.handleRenameBinder.bind(this));
    ipcMain.handle('storage:updateBinder', this.handleUpdateBinder.bind(this));
    ipcMain.handle('storage:deleteBinder', this.handleDeleteBinder.bind(this));
    ipcMain.handle('storage:reorderBinders', this.handleReorderBinders.bind(this));

    // Conflict IPC handlers (Phase 5)
    ipcMain.handle('storage:listConflicts', this.handleListConflicts.bind(this));
    ipcMain.handle('storage:countConflicts', this.handleCountConflicts.bind(this));
    ipcMain.handle('storage:getConflictsForNote', this.handleGetConflictsForNote.bind(this));
    ipcMain.handle('storage:getNotesWithConflicts', this.handleGetNotesWithConflicts.bind(this));
    ipcMain.handle(
      'storage:getNoteWithConflictMeta',
      this.handleGetNoteWithConflictMeta.bind(this)
    );
    ipcMain.handle(
      'storage:resolveConflictUseConflictVersion',
      this.handleResolveConflictUseConflictVersion.bind(this)
    );
    ipcMain.handle(
      'storage:resolveConflictKeepCanonical',
      this.handleResolveConflictKeepCanonical.bind(this)
    );
    ipcMain.handle('storage:getConflictsBinder', this.handleGetConflictsBinder.bind(this));
    ipcMain.handle('storage:hasUnresolvedConflicts', this.handleHasUnresolvedConflicts.bind(this));
    ipcMain.handle(
      'storage:listBindersWithConflicts',
      this.handleListBindersWithConflicts.bind(this)
    );

    logger.debug('StorageHandlers: All handlers registered successfully');
  }

  /**
   * Create a new note in the specified binder
   */
  private async handleCreateNote(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<string> {
    try {
      const { binderId } = CreateNoteSchema.parse(input);
      logger.debug('StorageHandlers: Creating note', { binderId });

      const noteId = await this.deps.storage.notes.create(binderId);

      // Notify renderer and trigger debounced sync
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Note created successfully', { noteId, binderId });
      return noteId;
    } catch (error) {
      logger.error('StorageHandlers: Failed to create note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Save note content and metadata
   */
  private async handleSaveNote(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<void> {
    try {
      const { noteId, lexicalJson, plainText, title } = SaveNoteSchema.parse(input);
      logger.debug('StorageHandlers: Saving note', {
        noteId,
        titleLength: title?.length || 0,
        contentLength: plainText.length,
      });

      const didChange = await this.deps.storage.notes.save({
        noteId,
        lexicalJson,
        plainText,
        title,
      });

      // Trigger debounced sync only when the save actually changed anything
      // (saves can be called for selection-only/editor no-ops)
      if (didChange) {
        this.deps.onLocalChange?.();
      }

      logger.debug('StorageHandlers: Note saved successfully', { noteId, didChange });
    } catch (error) {
      logger.error('StorageHandlers: Failed to save note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Get note by ID
   */
  private async handleGetNote(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { noteId } = GetNoteSchema.parse(input);
      logger.debug('StorageHandlers: Getting note', { noteId });

      const note = await this.deps.storage.notes.get(noteId);

      logger.debug('StorageHandlers: Note retrieved', {
        noteId,
        found: !!note,
      });
      return note;
    } catch (error) {
      logger.error('StorageHandlers: Failed to get note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List notes by binder ID
   */
  private async handleListNotesByBinder(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { binderId } = ListNotesSchema.parse(input);
      logger.debug('StorageHandlers: Listing notes by binder', { binderId });

      const notes = await this.deps.storage.notes.listByBinder(binderId);

      logger.debug('StorageHandlers: Notes retrieved', {
        binderId,
        count: notes.length,
      });
      return this.adaptNoteSummaries(notes);
    } catch (error) {
      logger.error('StorageHandlers: Failed to list notes by binder', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List unassigned notes (notes in the system Unassigned binder)
   * This is used by the Home view to show notes without explicit binder assignment
   */
  private async handleListUnassignedNotes(_event: Electron.IpcMainInvokeEvent) {
    try {
      logger.debug('StorageHandlers: Listing unassigned notes');

      const notes = await this.deps.storage.notes.listByBinder(UNASSIGNED_BINDER_ID);

      logger.debug('StorageHandlers: Unassigned notes retrieved', {
        count: notes.length,
      });
      return this.adaptNoteSummaries(notes);
    } catch (error) {
      logger.error('StorageHandlers: Failed to list unassigned notes', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * List all non-deleted notes
   */
  private async handleListAllNotes() {
    try {
      logger.debug('StorageHandlers: Listing all notes');

      const notes = await this.deps.storage.notes.listAll();

      logger.debug('StorageHandlers: All notes retrieved', { count: notes.length });

      return this.adaptNoteSummaries(notes);
    } catch (error) {
      logger.error('StorageHandlers: Failed to list all notes', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * List notes created within a specific range
   */
  private async handleListNotesByCreatedBetween(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ) {
    try {
      const { start, end } = ListNotesByDateRangeSchema.parse(input);
      logger.debug('StorageHandlers: Listing notes created between timestamps', { start, end });

      const notes = await this.deps.storage.notes.listByCreatedBetween(start, end);

      logger.debug('StorageHandlers: Notes retrieved for date range', {
        start,
        end,
        count: notes.length,
      });

      return this.adaptNoteSummaries(notes);
    } catch (error) {
      logger.error('StorageHandlers: Failed to list notes by created range', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List deleted notes (trash)
   */
  private async handleListDeletedNotes() {
    try {
      logger.debug('StorageHandlers: Listing deleted notes');

      const notes = await this.deps.storage.notes.listDeleted();

      logger.debug('StorageHandlers: Deleted notes retrieved', { count: notes.length });

      return this.adaptNoteSummaries(notes);
    } catch (error) {
      logger.error('StorageHandlers: Failed to list deleted notes', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Empty trash (permanently delete soft-deleted notes)
   */
  private async handleEmptyTrash(): Promise<{ removed: number }> {
    try {
      logger.debug('StorageHandlers: Emptying trash');

      const removed = await this.deps.storage.notes.emptyTrash();

      if (removed > 0) {
        this.notifyDataChanged();
      }

      logger.debug('StorageHandlers: Trash emptied', { removed });
      return { removed };
    } catch (error) {
      logger.error('StorageHandlers: Failed to empty trash', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Delete note by ID
   * Also cascades deletion to associated transcriptions and summaries
   */
  private async handleDeleteNote(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { noteId } = DeleteNoteSchema.parse(input);
      logger.debug('StorageHandlers: Deleting note', { noteId });

      // Get all transcriptions for this note before deleting
      const transcriptions = await this.deps.storage.transcriptions.listByNote(noteId);

      // Cascade delete: delete summaries and transcriptions associated with this note
      for (const transcription of transcriptions) {
        // Skip already deleted transcriptions
        if (transcription.deleted) {
          continue;
        }

        // Delete all summaries for this transcription
        const summaries = await this.deps.storage.summaries.getByTranscriptionId(transcription.id);
        for (const summary of summaries) {
          await this.deps.storage.summaries.delete(summary.id);
          logger.debug('StorageHandlers: Deleted summary for note', {
            summaryId: summary.id,
            transcriptionId: transcription.id,
            noteId,
          });
        }

        // Delete the transcription
        await this.deps.storage.transcriptions.deleteSession(transcription.id);
        logger.debug('StorageHandlers: Deleted transcription for note', {
          transcriptionId: transcription.id,
          noteId,
        });
      }

      // Now delete the note itself
      await this.deps.storage.notes.delete(noteId);

      // Notify renderer and trigger debounced sync
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Note deleted with cascade', {
        noteId,
        transcriptionsDeleted: transcriptions.filter((t) => !t.deleted).length,
      });
    } catch (error) {
      logger.error('StorageHandlers: Failed to delete note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Move note to different binder
   */
  private async handleMoveNote(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<void> {
    try {
      const { noteId, binderId } = MoveNoteSchema.parse(input);
      logger.debug('StorageHandlers: Moving note to binder', { noteId, binderId });

      await this.deps.storage.notes.move(noteId, binderId);

      // Notify renderer and trigger debounced sync
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Note moved successfully', { noteId, binderId });
    } catch (error) {
      logger.error('StorageHandlers: Failed to move note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Star or unstar a note
   */
  private async handleSetStarred(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { noteId, starred } = SetStarredSchema.parse(input);
      logger.debug('StorageHandlers: Setting note starred status', { noteId, starred });

      await this.deps.storage.notes.setStarred(noteId, starred);

      // Notify renderer and trigger debounced sync
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Note starred status updated', { noteId, starred });
    } catch (error) {
      logger.error('StorageHandlers: Failed to set note starred status', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List all starred notes
   */
  private async handleListStarredNotes(
    _event: Electron.IpcMainInvokeEvent
  ): Promise<NoteSummary[]> {
    try {
      logger.debug('StorageHandlers: Listing starred notes');
      const notes = await this.deps.storage.notes.listStarred();
      logger.debug('StorageHandlers: Retrieved starred notes', { count: notes.length });
      return notes;
    } catch (error) {
      logger.error('StorageHandlers: Failed to list starred notes', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Archive or unarchive a note
   */
  private async handleSetArchived(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { noteId, archived } = SetArchivedSchema.parse(input);
      logger.debug('StorageHandlers: Setting note archived status', { noteId, archived });

      await this.deps.storage.notes.setArchived(noteId, archived);

      // Notify renderer and trigger debounced sync
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Note archived status updated', { noteId, archived });
    } catch (error) {
      logger.error('StorageHandlers: Failed to set note archived status', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List all archived notes
   */
  private async handleListArchivedNotes(
    _event: Electron.IpcMainInvokeEvent
  ): Promise<NoteSummary[]> {
    try {
      logger.debug('StorageHandlers: Listing archived notes');
      const notes = await this.deps.storage.notes.listArchived();
      logger.debug('StorageHandlers: Retrieved archived notes', { count: notes.length });
      return notes;
    } catch (error) {
      logger.error('StorageHandlers: Failed to list archived notes', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Search notes by query
   */
  private async handleSearch(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { q } = SearchSchema.parse(input);
      logger.debug('StorageHandlers: Searching notes', { query: q });

      const results = await this.deps.storage.search.search(q);

      logger.debug('StorageHandlers: Search completed', {
        query: q,
        resultCount: results.length,
      });
      return results;
    } catch (error) {
      logger.error('StorageHandlers: Failed to search notes', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * List user-created binders (excludes system Unassigned binder)
   */
  private async handleListBinders() {
    try {
      logger.debug('StorageHandlers: Listing user binders');

      const binders = await this.deps.storage.binders.listUserBinders();

      logger.debug('StorageHandlers: User binders retrieved', { count: binders.length });
      return binders;
    } catch (error) {
      logger.error('StorageHandlers: Failed to list binders', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get default binder ID by name
   */
  private async handleGetDefaultBinderId(
    _event: Electron.IpcMainInvokeEvent,
    binderName: unknown
  ): Promise<string> {
    try {
      logger.debug('StorageHandlers: Getting default binder ID', { binderName });

      const binderId = await this.deps.storage.binders.getDefaultBinderId(binderName as string);

      logger.debug('StorageHandlers: Default binder ID retrieved', {
        binderName,
        binderId,
      });
      return binderId;
    } catch (error) {
      logger.error('StorageHandlers: Failed to get default binder ID', {
        error: error instanceof Error ? error.message : error,
        binderName,
      });
      throw error;
    }
  }

  /**
   * Create new binder
   */
  private async handleCreateBinder(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<string> {
    try {
      const { name, user_profile_id } = CreateBinderSchema.parse(input);
      logger.debug('StorageHandlers: Creating binder', { name, user_profile_id });

      const userId = user_profile_id ?? (await this.deps.storage.users.getCurrentUserId());
      const binderId = await this.deps.storage.binders.create(name, userId);

      // Trigger debounced sync to push changes to server
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Binder created successfully', { binderId, name });
      return binderId;
    } catch (error) {
      logger.error('StorageHandlers: Failed to create binder', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Rename binder
   */
  private async handleRenameBinder(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { id, name } = RenameBinderSchema.parse(input);
      logger.debug('StorageHandlers: Renaming binder', { id, name });

      await this.deps.storage.binders.update({ id, name });

      // Trigger debounced sync to push changes to server
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Binder renamed successfully', { id, name });
    } catch (error) {
      logger.error('StorageHandlers: Failed to rename binder', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Update binder properties
   */
  private async handleUpdateBinder(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const rawData = UpdateBinderSchema.parse(input);
      logger.debug('StorageHandlers: Updating binder', rawData);

      // Transform field names to match service interface
      const updateData = {
        id: rawData.id,
        name: rawData.name,
        color: rawData.color,
        icon: rawData.icon,
        isTeamShared: rawData.is_team_shared === 1,
      };

      await this.deps.storage.binders.update(updateData);

      // Trigger debounced sync to push changes to server
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Binder updated successfully', { id: updateData.id });
    } catch (error) {
      logger.error('StorageHandlers: Failed to update binder', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Delete binder
   */
  private async handleDeleteBinder(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { id } = DeleteBinderSchema.parse(input);
      logger.debug('StorageHandlers: Deleting binder', { id });

      await this.deps.storage.binders.delete(id);

      // Trigger debounced sync to push changes to server
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Binder deleted', { id });
    } catch (error) {
      logger.error('StorageHandlers: Failed to delete binder', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Reorder binders
   */
  private async handleReorderBinders(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { order } = ReorderBindersSchema.parse(input);
      logger.debug('StorageHandlers: Reordering binders', { orderLength: order.length });

      await this.deps.storage.binders.reorder(order);

      // Trigger debounced sync to push changes to server
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Binders reordered successfully');
    } catch (error) {
      logger.error('StorageHandlers: Failed to reorder binders', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  // ============================================
  // Conflict Handlers (Phase 5)
  // ============================================

  /**
   * List all conflict copy notes
   */
  private async handleListConflicts(): Promise<NoteSummary[]> {
    try {
      logger.debug('StorageHandlers: Listing conflict notes');
      const conflicts = await this.deps.storage.notes.listConflicts();
      logger.debug('StorageHandlers: Conflict notes retrieved', { count: conflicts.length });
      return conflicts;
    } catch (error) {
      logger.error('StorageHandlers: Failed to list conflicts', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Count total conflict copies
   */
  private async handleCountConflicts(): Promise<{ count: number }> {
    try {
      logger.debug('StorageHandlers: Counting conflicts');
      const count = await this.deps.storage.notes.countConflicts();
      logger.debug('StorageHandlers: Conflicts counted', { count });
      return { count };
    } catch (error) {
      logger.error('StorageHandlers: Failed to count conflicts', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get conflict copies for a specific canonical note
   */
  private async handleGetConflictsForNote(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<NoteSummary[]> {
    try {
      const { noteId } = GetConflictsForNoteSchema.parse(input);
      logger.debug('StorageHandlers: Getting conflicts for note', { noteId });
      const conflicts = await this.deps.storage.notes.getConflictsForNote(noteId);
      logger.debug('StorageHandlers: Conflicts for note retrieved', {
        noteId,
        count: conflicts.length,
      });
      return conflicts;
    } catch (error) {
      logger.error('StorageHandlers: Failed to get conflicts for note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Get canonical note IDs that have conflicts
   */
  private async handleGetNotesWithConflicts(): Promise<string[]> {
    try {
      logger.debug('StorageHandlers: Getting notes with conflicts');
      const noteIds = await this.deps.storage.notes.getNotesWithConflicts();
      logger.debug('StorageHandlers: Notes with conflicts retrieved', { count: noteIds.length });
      return noteIds;
    } catch (error) {
      logger.error('StorageHandlers: Failed to get notes with conflicts', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get note with conflict metadata
   */
  private async handleGetNoteWithConflictMeta(_event: Electron.IpcMainInvokeEvent, input: unknown) {
    try {
      const { noteId } = GetNoteSchema.parse(input);
      logger.debug('StorageHandlers: Getting note with conflict meta', { noteId });
      const result = await this.deps.storage.notes.getWithConflictMeta(noteId);
      logger.debug('StorageHandlers: Note with conflict meta retrieved', {
        noteId,
        hasConflicts: result.conflictCopies.length > 0,
      });
      return result;
    } catch (error) {
      logger.error('StorageHandlers: Failed to get note with conflict meta', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Resolve conflict by using the conflict version
   */
  private async handleResolveConflictUseConflictVersion(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { conflictNoteId, canonicalNoteId } = ResolveConflictSchema.parse(input);
      logger.debug('StorageHandlers: Resolving conflict (use conflict version)', {
        conflictNoteId,
        canonicalNoteId,
      });
      await this.deps.storage.notes.resolveConflictUseConflictVersion(
        conflictNoteId,
        canonicalNoteId
      );

      // Notify renderer and trigger sync
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Conflict resolved (use conflict version)', {
        conflictNoteId,
        canonicalNoteId,
      });
    } catch (error) {
      logger.error('StorageHandlers: Failed to resolve conflict (use conflict version)', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Resolve conflict by keeping canonical (delete conflict copy)
   */
  private async handleResolveConflictKeepCanonical(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { conflictNoteId } = DeleteConflictSchema.parse(input);
      logger.debug('StorageHandlers: Resolving conflict (keep canonical)', { conflictNoteId });
      await this.deps.storage.notes.resolveConflictKeepCanonical(conflictNoteId);

      // Notify renderer and trigger sync
      this.notifyDataChanged();

      logger.debug('StorageHandlers: Conflict resolved (keep canonical)', { conflictNoteId });
    } catch (error) {
      logger.error('StorageHandlers: Failed to resolve conflict (keep canonical)', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  /**
   * Get the Conflicts binder
   */
  private async handleGetConflictsBinder() {
    try {
      logger.debug('StorageHandlers: Getting conflicts binder');
      const binder = await this.deps.storage.binders.getConflictsBinder();
      logger.debug('StorageHandlers: Conflicts binder retrieved', { found: !!binder });
      return binder;
    } catch (error) {
      logger.error('StorageHandlers: Failed to get conflicts binder', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Check if there are unresolved conflicts
   */
  private async handleHasUnresolvedConflicts(): Promise<{ hasConflicts: boolean }> {
    try {
      logger.debug('StorageHandlers: Checking for unresolved conflicts');
      const hasConflicts = await this.deps.storage.binders.hasUnresolvedConflicts();
      logger.debug('StorageHandlers: Unresolved conflicts check', { hasConflicts });
      return { hasConflicts };
    } catch (error) {
      logger.error('StorageHandlers: Failed to check for unresolved conflicts', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * List binders including Conflicts binder if it has content
   */
  private async handleListBindersWithConflicts() {
    try {
      logger.debug('StorageHandlers: Listing binders with conflicts');
      const binders = await this.deps.storage.binders.listWithConflicts();
      logger.debug('StorageHandlers: Binders with conflicts retrieved', { count: binders.length });
      return binders;
    } catch (error) {
      logger.error('StorageHandlers: Failed to list binders with conflicts', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Cleanup and unregister handlers
   */
  cleanup(): void {
    logger.debug('StorageHandlers: Cleaning up IPC handlers');

    const handlers = [
      'storage:createNote',
      'storage:saveNote',
      'storage:getNote',
      'storage:listNotesByBinder',
      'storage:listUnassignedNotes',
      'storage:listAllNotes',
      'storage:listNotesByCreatedBetween',
      'storage:listDeletedNotes',
      'storage:emptyTrash',
      'storage:deleteNote',
      'storage:moveNote',
      'storage:setStarred',
      'storage:listStarredNotes',
      'storage:setArchived',
      'storage:listArchivedNotes',
      'storage:search',
      'storage:listBinders',
      'storage:getDefaultBinderId',
      'storage:createBinder',
      'storage:renameBinder',
      'storage:updateBinder',
      'storage:deleteBinder',
      'storage:reorderBinders',
      // Conflict handlers (Phase 5)
      'storage:listConflicts',
      'storage:countConflicts',
      'storage:getConflictsForNote',
      'storage:getNotesWithConflicts',
      'storage:getNoteWithConflictMeta',
      'storage:resolveConflictUseConflictVersion',
      'storage:resolveConflictKeepCanonical',
      'storage:getConflictsBinder',
      'storage:hasUnresolvedConflicts',
      'storage:listBindersWithConflicts',
    ];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeAllListeners(handler);
      } catch (error) {
        logger.warn('StorageHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    logger.debug('StorageHandlers: Cleanup completed');
  }

  private adaptNoteSummaries(notes: NoteSummary[]) {
    return notes.map((note) => this.adaptNoteSummary(note));
  }

  private adaptNoteSummary(note: NoteSummary) {
    return {
      id: note.id,
      title: note.title,
      binder_id: note.binder_id,
      created_at: note.created_at,
      updated_at: note.updated_at,
      deleted: note.deleted,
      pinned: note.pinned,
      starred: note.starred,
      archived: note.archived,
    };
  }
}
