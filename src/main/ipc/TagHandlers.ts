import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import { type IStorageService } from '../storage/index';

// Validation Schemas
const CreateTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
});

const UpdateTagSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(50).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .optional(),
});

const TagIdSchema = z.object({
  id: z.string().min(1),
});

const ReorderTagsSchema = z.object({
  ids: z.array(z.string().min(1)),
});

const NoteTagSchema = z.object({
  noteId: z.string().min(1),
  tagId: z.string().min(1),
});

const SetNoteTagsSchema = z.object({
  noteId: z.string().min(1),
  tagIds: z.array(z.string().min(1)),
});

const NoteIdSchema = z.object({
  noteId: z.string().min(1),
});

const TagIdParamSchema = z.object({
  tagId: z.string().min(1),
});

export interface TagHandlersDependencies {
  storage: IStorageService;
  mainWindow: BrowserWindow | null;
  onLocalChange?: () => void;
}

/**
 * TagHandlers manages all IPC handlers related to tags and note-tag associations.
 * This includes CRUD operations for tags and associating tags with notes.
 */
export class TagHandlers {
  constructor(private deps: TagHandlersDependencies) {}

  /**
   * Broadcast an event to the renderer
   */
  private broadcast(channel: string): void {
    if (!this.deps.mainWindow) {
      return;
    }
    try {
      this.deps.mainWindow.webContents.send(channel);
    } catch (error) {
      logger.warn('TagHandlers: Failed to broadcast event', {
        channel,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Notify renderer that data has changed (for UI refresh)
   */
  private notifyDataChanged(): void {
    this.broadcast('tags:changed');
  }

  /**
   * Register all tag-related IPC handlers
   */
  register(): void {
    logger.debug('TagHandlers: Registering IPC handlers');

    // CRUD handlers
    ipcMain.handle('tags:create', this.handleCreate.bind(this));
    ipcMain.handle('tags:list', this.handleList.bind(this));
    ipcMain.handle('tags:get', this.handleGet.bind(this));
    ipcMain.handle('tags:update', this.handleUpdate.bind(this));
    ipcMain.handle('tags:delete', this.handleDelete.bind(this));
    ipcMain.handle('tags:reorder', this.handleReorder.bind(this));

    // Note-Tag association handlers
    ipcMain.handle('tags:addToNote', this.handleAddToNote.bind(this));
    ipcMain.handle('tags:removeFromNote', this.handleRemoveFromNote.bind(this));
    ipcMain.handle('tags:setNoteTags', this.handleSetNoteTags.bind(this));
    ipcMain.handle('tags:getByNote', this.handleGetByNote.bind(this));
    ipcMain.handle('tags:getNotesByTag', this.handleGetNotesByTag.bind(this));

    logger.debug('TagHandlers: All handlers registered successfully');
  }

  // ============================================
  // CRUD Handlers
  // ============================================

  private async handleCreate(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<string> {
    try {
      const { name, color } = CreateTagSchema.parse(input);
      logger.debug('TagHandlers: Creating tag', { name });

      const tagId = await this.deps.storage.tags.create({ name, color });

      this.notifyDataChanged();
      logger.debug('TagHandlers: Tag created', { tagId });
      return tagId;
    } catch (error) {
      logger.error('TagHandlers: Failed to create tag', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleList(): Promise<unknown[]> {
    try {
      logger.debug('TagHandlers: Listing tags');
      const tags = await this.deps.storage.tags.list();
      return tags;
    } catch (error) {
      logger.error('TagHandlers: Failed to list tags', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  private async handleGet(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<unknown> {
    try {
      const { id } = TagIdSchema.parse(input);
      logger.debug('TagHandlers: Getting tag', { id });
      return await this.deps.storage.tags.get(id);
    } catch (error) {
      logger.error('TagHandlers: Failed to get tag', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleUpdate(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<void> {
    try {
      const data = UpdateTagSchema.parse(input);
      logger.debug('TagHandlers: Updating tag', { id: data.id });

      await this.deps.storage.tags.update(
        data as { id: string; name?: string; color?: string | null }
      );

      this.notifyDataChanged();
      logger.debug('TagHandlers: Tag updated', { id: data.id });
    } catch (error) {
      logger.error('TagHandlers: Failed to update tag', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleDelete(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<void> {
    try {
      const { id } = TagIdSchema.parse(input);
      logger.debug('TagHandlers: Deleting tag', { id });

      await this.deps.storage.tags.delete(id);

      this.notifyDataChanged();
      this.broadcast('note-tags:changed');
      logger.debug('TagHandlers: Tag deleted', { id });
    } catch (error) {
      logger.error('TagHandlers: Failed to delete tag', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleReorder(_event: Electron.IpcMainInvokeEvent, input: unknown): Promise<void> {
    try {
      const { ids } = ReorderTagsSchema.parse(input);
      logger.debug('TagHandlers: Reordering tags', { count: ids.length });

      await this.deps.storage.tags.reorder(ids);

      this.notifyDataChanged();
      logger.debug('TagHandlers: Tags reordered');
    } catch (error) {
      logger.error('TagHandlers: Failed to reorder tags', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  // ============================================
  // Note-Tag Association Handlers
  // ============================================

  private async handleAddToNote(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<string> {
    try {
      const { noteId, tagId } = NoteTagSchema.parse(input);
      logger.debug('TagHandlers: Adding tag to note', { noteId, tagId });

      const noteTagId = await this.deps.storage.tags.addToNote(noteId, tagId);

      this.broadcast('note-tags:changed');
      this.deps.onLocalChange?.();
      logger.debug('TagHandlers: Tag added to note', { noteTagId });
      return noteTagId;
    } catch (error) {
      logger.error('TagHandlers: Failed to add tag to note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleRemoveFromNote(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { noteId, tagId } = NoteTagSchema.parse(input);
      logger.debug('TagHandlers: Removing tag from note', { noteId, tagId });

      await this.deps.storage.tags.removeFromNote(noteId, tagId);

      this.broadcast('note-tags:changed');
      this.deps.onLocalChange?.();
      logger.debug('TagHandlers: Tag removed from note');
    } catch (error) {
      logger.error('TagHandlers: Failed to remove tag from note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleSetNoteTags(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> {
    try {
      const { noteId, tagIds } = SetNoteTagsSchema.parse(input);
      logger.debug('TagHandlers: Setting note tags', { noteId, count: tagIds.length });

      await this.deps.storage.tags.setNoteTags(noteId, tagIds);

      this.broadcast('note-tags:changed');
      this.deps.onLocalChange?.();
      logger.debug('TagHandlers: Note tags set');
    } catch (error) {
      logger.error('TagHandlers: Failed to set note tags', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleGetByNote(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<unknown[]> {
    try {
      const { noteId } = NoteIdSchema.parse(input);
      logger.debug('TagHandlers: Getting tags by note', { noteId });
      return await this.deps.storage.tags.getTagsByNote(noteId);
    } catch (error) {
      logger.error('TagHandlers: Failed to get tags by note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  private async handleGetNotesByTag(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<unknown[]> {
    try {
      const { tagId } = TagIdParamSchema.parse(input);
      logger.debug('TagHandlers: Getting notes by tag', { tagId });
      return await this.deps.storage.tags.getNotesByTag(tagId);
    } catch (error) {
      logger.error('TagHandlers: Failed to get notes by tag', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      throw error;
    }
  }

  // ============================================
  // Cleanup
  // ============================================

  cleanup(): void {
    logger.debug('TagHandlers: Cleaning up IPC handlers');

    const handlers = [
      'tags:create',
      'tags:list',
      'tags:get',
      'tags:update',
      'tags:delete',
      'tags:reorder',
      'tags:addToNote',
      'tags:removeFromNote',
      'tags:setNoteTags',
      'tags:getByNote',
      'tags:getNotesByTag',
    ];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeHandler(handler);
      } catch (error) {
        logger.warn('TagHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    logger.info('TagHandlers: IPC handlers cleaned up successfully');
  }
}
