import { ipcMain } from 'electron';
import { z } from 'zod';

import { logger } from '../logger';
import { getKeystoreService } from '../services/security';
import { type IStorageService } from '../storage/index';

// Validation schemas
const GenerateSummarySchema = z.object({
  transcriptionId: z.string().min(1),
  summaryType: z.string().optional().default('full'),
  forceRegenerate: z.boolean().optional().default(false),
});

const GetSummarySchema = z.object({
  summaryId: z.string().min(1),
});

const GetSummariesByTranscriptionSchema = z.object({
  transcriptionId: z.string().min(1),
});

const DeleteSummarySchema = z.object({
  summaryId: z.string().min(1),
});

const UpdateSummaryTextSchema = z.object({
  summaryId: z.string().min(1),
  summaryText: z.string().min(1),
});

// Entity types for summaries
export interface AISummary {
  id: string;
  transcriptionId: string;
  summaryText: string;
  summaryType: string;
  processingTimeMs?: number;
  modelUsed?: string;
  backendType?: string;
  pipelineUsed?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SummaryHandlersDependencies {
  storage: IStorageService;
  notificationManager?: import('../services/SummaryNotificationManager').SummaryNotificationManager;
  syncPush?: () => Promise<{ success: boolean }>;
}

interface ServerSummaryData {
  id: string;
  entity_id?: string;
  transcription_id: string;
  summary_text: string;
  summary_type?: string;
  processing_time_ms?: number;
  model_used?: string;
  model_version?: string;
  backend_type?: string;
  pipeline_used?: boolean;
  created_at: string;
  updated_at?: string;
}

interface APIResponse {
  success?: boolean;
  summary?: ServerSummaryData;
  summaries?: ServerSummaryData[];
  error?: string;
  details?: unknown;
  [key: string]: unknown;
}

/**
 * SummaryHandlers manages all IPC handlers related to AI summary operations.
 * This includes generating summaries from transcriptions, retrieving existing summaries,
 * and managing summary data.
 */
export class SummaryHandlers {
  constructor(private deps: SummaryHandlersDependencies) {}

  /**
   * Register all summary-related IPC handlers
   */
  register(): void {
    logger.debug('SummaryHandlers: Registering IPC handlers');

    ipcMain.handle('summary:generate', this.handleGenerateSummary.bind(this));
    ipcMain.handle('summary:get', this.handleGetSummary.bind(this));
    ipcMain.handle('summary:getByTranscription', this.handleGetSummariesByTranscription.bind(this));
    ipcMain.handle('summary:delete', this.handleDeleteSummary.bind(this));
    ipcMain.handle('summary:list', this.handleListSummaries.bind(this));
    ipcMain.handle(
      'summary:checkServerSummaryExists',
      this.handleCheckServerSummaryExists.bind(this)
    );
    ipcMain.handle('summary:updateSummaryText', this.handleUpdateSummaryText.bind(this));

    logger.debug('SummaryHandlers: All handlers registered successfully');
  }

  /**
   * Generate a new summary from a transcription
   */
  private async handleGenerateSummary(
    _event: Electron.IpcMainInvokeEvent,
    request: unknown
  ): Promise<{ success: boolean; summary?: AISummary; error?: string }> {
    try {
      const validated = GenerateSummarySchema.parse(request);
      logger.info('SummaryHandlers: Generating summary', {
        transcriptionId: validated.transcriptionId,
        summaryType: validated.summaryType,
        forceRegenerate: validated.forceRegenerate,
      });

      // Ensure transcription data is synced to the server before requesting summary
      if (this.deps.syncPush) {
        logger.info('SummaryHandlers: Syncing data to server before summary generation');
        try {
          const syncResult = await this.deps.syncPush();
          logger.info('SummaryHandlers: Pre-summary sync completed', {
            success: syncResult.success,
          });
        } catch (syncErr) {
          logger.warn('SummaryHandlers: Pre-summary sync failed, proceeding anyway', {
            error: syncErr instanceof Error ? syncErr.message : syncErr,
          });
        }
      }

      // Call the server API to generate summary
      // The server looks up transcription text from its own synced data
      const requestBody = {
        transcriptionId: validated.transcriptionId,
        summaryType: validated.summaryType,
      };

      logger.info('SummaryHandlers: Sending summary request to server', {
        transcriptionId: requestBody.transcriptionId,
        summaryType: requestBody.summaryType,
      });

      const response = await this.callSummaryAPI('/generate', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      if (!response.success) {
        logger.error('SummaryHandlers: Server returned error', {
          error: response.error,
          details: response.details,
        });
        return { success: false, error: response.error || 'Failed to generate summary' };
      }

      const summaryData = response.summary;
      if (!summaryData) {
        return { success: false, error: 'Server returned no summary data' };
      }

      const summary: AISummary = {
        id: summaryData.id,
        transcriptionId: validated.transcriptionId,
        summaryText: summaryData.summary_text,
        summaryType: validated.summaryType,
        processingTimeMs: summaryData.processing_time_ms,
        modelUsed: summaryData.model_used || summaryData.model_version,
        backendType: summaryData.backend_type,
        pipelineUsed: summaryData.pipeline_used,
        createdAt: new Date(summaryData.created_at),
        updatedAt: new Date(summaryData.updated_at || summaryData.created_at),
      };

      // Store summary locally for offline access
      await this.storeSummaryLocally(summary);

      logger.info('SummaryHandlers: Summary generated successfully', { summaryId: summary.id });
      return { success: true, summary };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to generate summary', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Get a specific summary by ID
   */
  private async handleGetSummary(
    _event: Electron.IpcMainInvokeEvent,
    request: unknown
  ): Promise<{ success: boolean; summary?: AISummary; error?: string }> {
    try {
      const validated = GetSummarySchema.parse(request);
      logger.debug('SummaryHandlers: Getting summary', { summaryId: validated.summaryId });

      // Try to get from local storage first
      const localSummary = await this.getSummaryFromLocal(validated.summaryId);
      if (localSummary) {
        return { success: true, summary: localSummary };
      }

      // Fall back to server API
      const response = await this.callSummaryAPI(`/${validated.summaryId}`, {
        method: 'GET',
      });

      if (!response.success) {
        return { success: false, error: response.error || 'Summary not found' };
      }

      const summaryData = response.summary;
      if (!summaryData) {
        return { success: false, error: 'Summary not found' };
      }

      const summary: AISummary = {
        id: summaryData.id,
        transcriptionId: summaryData.transcription_id,
        summaryText: summaryData.summary_text,
        summaryType: summaryData.summary_type || 'full',
        processingTimeMs: summaryData.processing_time_ms,
        modelUsed: summaryData.model_used || summaryData.model_version,
        backendType: summaryData.backend_type,
        pipelineUsed: summaryData.pipeline_used,
        createdAt: new Date(summaryData.created_at),
        updatedAt: new Date(summaryData.updated_at || summaryData.created_at),
      };

      // Store locally for future offline access
      await this.storeSummaryLocally(summary);

      return { success: true, summary };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to get summary', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Get all summaries for a transcription
   */
  private async handleGetSummariesByTranscription(
    _event: Electron.IpcMainInvokeEvent,
    request: unknown
  ): Promise<{ success: boolean; summaries?: AISummary[]; error?: string }> {
    try {
      const validated = GetSummariesByTranscriptionSchema.parse(request);
      logger.debug('SummaryHandlers: Getting summaries by transcription', {
        transcriptionId: validated.transcriptionId,
      });

      // Try local storage first
      const localSummaries = await this.getSummariesByTranscriptionFromLocal(
        validated.transcriptionId
      );

      // Also try to sync with server
      try {
        const response = await this.callSummaryAPI(`/transcription/${validated.transcriptionId}`, {
          method: 'GET',
        });

        if (response.success && response.summaries) {
          const serverSummaries: AISummary[] = response.summaries.map(
            (summaryData: ServerSummaryData) => ({
              id: summaryData.id,
              transcriptionId: summaryData.transcription_id || validated.transcriptionId,
              summaryText: summaryData.summary_text,
              summaryType: summaryData.summary_type || 'full',
              processingTimeMs: summaryData.processing_time_ms,
              modelUsed: summaryData.model_used || summaryData.model_version,
              backendType: summaryData.backend_type,
              pipelineUsed: summaryData.pipeline_used,
              createdAt: new Date(summaryData.created_at),
              updatedAt: new Date(summaryData.updated_at || summaryData.created_at),
            })
          );

          // Store server summaries locally
          for (const summary of serverSummaries) {
            await this.storeSummaryLocally(summary);
          }

          return { success: true, summaries: serverSummaries };
        }
      } catch (error) {
        logger.warn('SummaryHandlers: Server sync failed, using local data only', {
          error: error instanceof Error ? error.message : error,
        });
      }

      // Return local summaries if server sync failed
      return { success: true, summaries: localSummaries };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to get summaries by transcription', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Delete a summary
   */
  private async handleDeleteSummary(
    _event: Electron.IpcMainInvokeEvent,
    request: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const validated = DeleteSummarySchema.parse(request);
      logger.info('SummaryHandlers: Deleting summary', { summaryId: validated.summaryId });

      // Delete from server
      const response = await this.callSummaryAPI(`/${validated.summaryId}`, {
        method: 'DELETE',
      });

      if (!response.success) {
        return { success: false, error: response.error || 'Failed to delete summary' };
      }

      // Delete from local storage
      await this.deleteSummaryFromLocal(validated.summaryId);

      logger.info('SummaryHandlers: Summary deleted successfully', {
        summaryId: validated.summaryId,
      });
      return { success: true };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to delete summary', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * List all summaries for current user
   */
  private async handleListSummaries(
    _event: Electron.IpcMainInvokeEvent
  ): Promise<{ success: boolean; summaries?: AISummary[]; error?: string }> {
    try {
      logger.debug('SummaryHandlers: Listing all summaries');

      // Get from local storage
      const localSummaries = await this.getAllSummariesFromLocal();

      return { success: true, summaries: localSummaries };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to list summaries', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Check if a summary already exists on the server for the given transcription
   */
  private async handleCheckServerSummaryExists(
    _event: Electron.IpcMainInvokeEvent,
    transcriptionId: string
  ): Promise<{ success: boolean; exists?: boolean; error?: string }> {
    try {
      if (!transcriptionId) {
        return { success: false, error: 'Transcription ID is required' };
      }

      logger.debug('SummaryHandlers: Checking server for existing summaries', {
        transcriptionId,
      });

      // Call the server API to check for existing summaries
      const response = await this.callSummaryAPI(`/transcription/${transcriptionId}`, {
        method: 'GET',
      });

      if (!response.success) {
        // If the request failed due to network or auth issues, return error
        if (response.error && !response.error.includes('not found')) {
          return { success: false, error: response.error };
        }
        // If no summaries found (404), that's a valid response
        return { success: true, exists: false };
      }

      // Check if any summaries were returned
      const exists = !!(
        response.summaries &&
        Array.isArray(response.summaries) &&
        response.summaries.length > 0
      );

      logger.debug('SummaryHandlers: Server summary check result', {
        transcriptionId,
        exists,
        summaryCount: response.summaries?.length || 0,
      });

      return { success: true, exists };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to check server for existing summaries', {
        transcriptionId,
        error: error instanceof Error ? error.message : error,
      });

      // Don't fail the whole operation if server check fails - just proceed as if no summaries exist
      return { success: true, exists: false };
    }
  }

  /**
   * Update summary text (e.g. to persist action item checked state)
   */
  private async handleUpdateSummaryText(
    _event: Electron.IpcMainInvokeEvent,
    request: unknown
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const validated = UpdateSummaryTextSchema.parse(request);
      logger.debug('SummaryHandlers: Updating summary text', {
        summaryId: validated.summaryId,
      });

      await this.deps.storage.summaries.update({
        id: validated.summaryId,
        summaryText: validated.summaryText,
      });

      return { success: true };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to update summary text', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  /**
   * Call the summary API with authentication
   */
  private async callSummaryAPI(endpoint: string, options: RequestInit): Promise<APIResponse> {
    // Get server URL from settings (single source of truth)
    const serverUrl = await this.deps.storage.settings.get('auth.serverUrl');
    if (!serverUrl) {
      throw new Error('Server URL not configured');
    }

    const authToken = await this.getAuthToken();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const response = await fetch(`${serverUrl}/api/summaries${endpoint}`, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    });

    // Handle 204 No Content (successful DELETE)
    if (response.status === 204) {
      return { success: true };
    }

    // Handle non-OK responses
    if (!response.ok) {
      try {
        const errorBody = await response.json();
        return {
          success: false,
          error: errorBody.error || `Server error: ${response.status}`,
          details: errorBody.details,
        };
      } catch {
        return { success: false, error: `Server error: ${response.status}` };
      }
    }

    // Parse successful response
    const data = await response.json();

    // Server wraps response in { success: true, summary/summaries }
    // But for GET single summary, server returns raw object
    // Normalize to always have success flag
    if (data.success === undefined) {
      // Raw response from GET /api/summaries/:id - it returns the summary directly
      // Also handles GET /api/summaries/transcription/:id which returns { summaries: [...] }
      if (data.summaries) {
        return { success: true, summaries: data.summaries };
      }
      // Single summary returned directly
      return { success: true, summary: data as ServerSummaryData };
    }

    return data;
  }

  /**
   * Get auth token from storage
   */
  private async getAuthToken(): Promise<string | null> {
    try {
      logger.debug('SummaryHandlers: Getting auth token from settings');

      if (!this.deps) {
        logger.error('SummaryHandlers: No dependencies provided');
        return null;
      }

      if (!this.deps.storage) {
        logger.error('SummaryHandlers: No storage service in dependencies');
        return null;
      }

      if (!this.deps.storage.settings) {
        logger.error('SummaryHandlers: No settings service in storage');
        return null;
      }

      logger.debug('SummaryHandlers: Retrieving access token from keystore');
      const keystoreService = getKeystoreService();
      const accessToken = await keystoreService.getAccessToken();

      logger.debug('SummaryHandlers: Got access token from keystore', {
        hasAccessToken: !!accessToken,
        tokenLength: accessToken?.length || 0,
      });

      return accessToken || null;
    } catch (error) {
      logger.error('SummaryHandlers: Failed to get auth token', {
        error,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  /**
   * Store summary in local storage
   */
  private async storeSummaryLocally(summary: AISummary): Promise<void> {
    try {
      logger.debug('SummaryHandlers: Storing summary locally', { summaryId: summary.id });

      // Upsert behavior: create if new, otherwise update existing record
      const exists = await this.deps.storage.summaries.exists(summary.id);
      if (!exists) {
        await this.deps.storage.summaries.create({
          id: summary.id,
          transcriptionId: summary.transcriptionId,
          summaryText: summary.summaryText,
          summaryType: summary.summaryType,
          processingTimeMs: summary.processingTimeMs,
          modelUsed: summary.modelUsed,
          backendType: summary.backendType,
          pipelineUsed: summary.pipelineUsed,
        });
      } else {
        await this.deps.storage.summaries.update({
          id: summary.id,
          summaryText: summary.summaryText,
          summaryType: summary.summaryType,
          processingTimeMs: summary.processingTimeMs,
          modelUsed: summary.modelUsed,
          backendType: summary.backendType,
          pipelineUsed: summary.pipelineUsed,
        });
      }

      logger.debug('SummaryHandlers: Summary stored locally successfully', {
        summaryId: summary.id,
      });
    } catch (error) {
      logger.error('SummaryHandlers: Failed to store summary locally', { error });
    }
  }

  /**
   * Get summary from local storage
   */
  private async getSummaryFromLocal(summaryId: string): Promise<AISummary | null> {
    try {
      logger.debug('SummaryHandlers: Getting summary from local storage', { summaryId });

      const summary = await this.deps.storage.summaries.get(summaryId);
      if (!summary) {
        return null;
      }

      return {
        id: summary.id,
        transcriptionId: summary.transcriptionId,
        summaryText: summary.summaryText || '',
        summaryType: summary.summaryType,
        processingTimeMs: summary.processingTimeMs,
        modelUsed: summary.modelUsed,
        backendType: summary.backendType,
        pipelineUsed: summary.pipelineUsed,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      };
    } catch (error) {
      logger.error('SummaryHandlers: Failed to get summary from local storage', { error });
      return null;
    }
  }

  /**
   * Get summaries by transcription from local storage
   */
  private async getSummariesByTranscriptionFromLocal(
    transcriptionId: string
  ): Promise<AISummary[]> {
    try {
      logger.debug('SummaryHandlers: Getting summaries by transcription from local storage', {
        transcriptionId,
      });

      const summaries = await this.deps.storage.summaries.getByTranscriptionId(transcriptionId);

      return summaries.map((summary) => ({
        id: summary.id,
        transcriptionId: summary.transcriptionId,
        summaryText: summary.summaryText || '',
        summaryType: summary.summaryType,
        processingTimeMs: summary.processingTimeMs,
        modelUsed: summary.modelUsed,
        backendType: summary.backendType,
        pipelineUsed: summary.pipelineUsed,
        createdAt: summary.createdAt,
        updatedAt: summary.updatedAt,
      }));
    } catch (error) {
      logger.error('SummaryHandlers: Failed to get summaries by transcription from local storage', {
        error,
      });
      return [];
    }
  }

  /**
   * Get all summaries from local storage
   */
  private async getAllSummariesFromLocal(): Promise<AISummary[]> {
    try {
      logger.debug('SummaryHandlers: Getting all summaries from local storage');

      const summaries = await this.deps.storage.summaries.getAllSummaries();

      return summaries
        .filter((summary) => !summary.deleted)
        .map((summary) => ({
          id: summary.id,
          transcriptionId: summary.transcriptionId,
          summaryText: summary.summaryText || '',
          summaryType: summary.summaryType,
          processingTimeMs: summary.processingTimeMs,
          modelUsed: summary.modelUsed,
          backendType: summary.backendType,
          pipelineUsed: summary.pipelineUsed,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
        }));
    } catch (error) {
      logger.error('SummaryHandlers: Failed to get all summaries from local storage', { error });
      return [];
    }
  }

  /**
   * Delete summary from local storage
   */
  private async deleteSummaryFromLocal(summaryId: string): Promise<void> {
    try {
      logger.debug('SummaryHandlers: Deleting summary from local storage', { summaryId });

      await this.deps.storage.summaries.delete(summaryId);

      logger.debug('SummaryHandlers: Summary deleted from local storage successfully', {
        summaryId,
      });
    } catch (error) {
      logger.error('SummaryHandlers: Failed to delete summary from local storage', { error });
    }
  }

  /**
   * Cleanup handler - remove all IPC listeners
   */
  cleanup(): void {
    logger.debug('SummaryHandlers: Cleaning up IPC handlers');

    // Remove all registered handlers
    ipcMain.removeAllListeners('summary:generate');
    ipcMain.removeAllListeners('summary:get');
    ipcMain.removeAllListeners('summary:getByTranscription');
    ipcMain.removeAllListeners('summary:delete');
    ipcMain.removeAllListeners('summary:list');
    ipcMain.removeAllListeners('summary:checkServerSummaryExists');
    ipcMain.removeAllListeners('summary:updateSummaryText');

    logger.debug('SummaryHandlers: Cleanup completed');
  }
}
