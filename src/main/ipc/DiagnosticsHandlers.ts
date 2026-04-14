/**
 * Diagnostics IPC Handlers - Uploads sanitized log bundles to the platform server
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import archiver from 'archiver';
import { app, ipcMain } from 'electron';

import { getLogFileDir, logger } from '../logger';

export interface DiagnosticsUploadResult {
  success: boolean;
  error?: string;
}

export interface DiagnosticsHandlersDependencies {
  getAuthToken: () => Promise<string | null>;
  getServerUrl: () => Promise<string>;
}

/**
 * DiagnosticsHandlers manages IPC handlers for diagnostics upload.
 */
export class DiagnosticsHandlers {
  constructor(private deps: DiagnosticsHandlersDependencies) {}

  register(): void {
    logger.debug('DiagnosticsHandlers: Registering IPC handlers');
    ipcMain.handle('diagnostics:upload', this.handleUpload.bind(this));
    logger.debug('DiagnosticsHandlers: All handlers registered');
  }

  private async handleUpload(): Promise<DiagnosticsUploadResult> {
    try {
      const logDir = getLogFileDir();
      if (!logDir || !fs.existsSync(logDir)) {
        return { success: false, error: 'Log directory not found' };
      }

      const allFiles = fs.readdirSync(logDir);
      const logFiles = allFiles.filter((f) => f.endsWith('.log'));

      if (logFiles.length === 0) {
        return { success: false, error: 'No log files found' };
      }

      // Build system manifest (skip GPU — not relevant for cloud client)
      const manifest = {
        appVersion: app.getVersion(),
        platform: process.platform,
        osVersion: process.getSystemVersion(),
        arch: process.arch,
        timestamp: new Date().toISOString(),
        logFileCount: logFiles.length,
        electronVersion: process.versions.electron,
        cpuModel: os.cpus()[0]?.model || 'Unknown',
        cpuCores: os.cpus().length,
        totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3),
      };

      // Create ZIP in a temp file
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const zipFilename = `notely-diagnostics-${timestamp}.zip`;
      const tmpPath = path.join(os.tmpdir(), zipFilename);

      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(tmpPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        archive.on('error', (err: Error) => reject(err));

        archive.pipe(output);

        for (const file of logFiles) {
          archive.file(path.join(logDir, file), { name: `logs/${file}` });
        }

        archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
        archive.finalize();
      });

      // Get auth token and server URL
      const accessToken = await this.deps.getAuthToken();
      if (!accessToken) {
        this.cleanupTempFile(tmpPath);
        return { success: false, error: 'Not authenticated. Please sign in first.' };
      }

      const serverUrl = await this.deps.getServerUrl();

      // Upload via fetch with multipart form
      const zipBuffer = fs.readFileSync(tmpPath);
      const file = new File([zipBuffer], zipFilename, { type: 'application/zip' });

      const formData = new FormData();
      formData.append('file', file);

      const uploadUrl = `${serverUrl}/api/support/diagnostics/upload`;
      logger.info('DiagnosticsHandlers: Uploading diagnostics', {
        url: uploadUrl,
        zipSize: zipBuffer.length,
        logFileCount: logFiles.length,
      });

      const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        body: formData,
      });

      this.cleanupTempFile(tmpPath);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        logger.warn('DiagnosticsHandlers: Upload failed', {
          status: response.status,
          error: errorText,
        });
        return {
          success: false,
          error: `Upload failed (${response.status}): ${errorText}`,
        };
      }

      logger.info('DiagnosticsHandlers: Diagnostics uploaded successfully', {
        logFileCount: logFiles.length,
      });

      return { success: true };
    } catch (error) {
      logger.error('DiagnosticsHandlers: Failed to upload diagnostics', {
        error: error instanceof Error ? error.message : error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Upload failed',
      };
    }
  }

  private cleanupTempFile(filePath: string): void {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // Non-fatal
    }
  }

  cleanup(): void {
    logger.debug('DiagnosticsHandlers: Cleaning up IPC handlers');
    try {
      ipcMain.removeHandler('diagnostics:upload');
    } catch (error) {
      logger.warn('DiagnosticsHandlers: Failed to remove handler', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}
