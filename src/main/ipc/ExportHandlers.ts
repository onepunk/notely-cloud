/**
 * Export IPC Handlers - Handles note export operations
 */

import { ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import type { ExportService, ExportResult, ExportFormat } from '../services/export';

// Validation schemas
const ExportNoteSchema = z.object({
  noteId: z.string().min(1),
  format: z.enum(['txt', 'md', 'docx', 'rtf', 'pdf']),
});

export interface ExportHandlersDependencies {
  exportService: ExportService;
}

/**
 * ExportHandlers manages all IPC handlers related to note export operations.
 */
export class ExportHandlers {
  constructor(private deps: ExportHandlersDependencies) {}

  /**
   * Register all export-related IPC handlers
   */
  register(): void {
    logger.debug('ExportHandlers: Registering IPC handlers');

    ipcMain.handle('export:note', this.handleExportNote.bind(this));

    logger.debug('ExportHandlers: All handlers registered successfully');
  }

  /**
   * Export a note to the specified format
   */
  private async handleExportNote(
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<ExportResult> {
    try {
      const { noteId, format } = ExportNoteSchema.parse(input);
      logger.debug('ExportHandlers: Exporting note', { noteId, format });

      const result = await this.deps.exportService.exportNote(noteId, format as ExportFormat);

      if (result.success) {
        logger.info('ExportHandlers: Note exported successfully', {
          noteId,
          format,
          filePath: result.filePath,
        });
      } else {
        logger.warn('ExportHandlers: Export failed or cancelled', {
          noteId,
          format,
          error: result.error,
        });
      }

      return result;
    } catch (error) {
      logger.error('ExportHandlers: Failed to export note', {
        error: error instanceof Error ? error.message : error,
        input,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Export failed',
      };
    }
  }

  /**
   * Cleanup and unregister handlers
   */
  cleanup(): void {
    logger.debug('ExportHandlers: Cleaning up IPC handlers');

    const handlers = ['export:note'];

    handlers.forEach((handler) => {
      try {
        ipcMain.removeHandler(handler);
      } catch (error) {
        logger.warn('ExportHandlers: Failed to remove handler', {
          handler,
          error: error instanceof Error ? error.message : error,
        });
      }
    });

    logger.debug('ExportHandlers: Cleanup completed');
  }
}
