import crypto from 'node:crypto';
import fs, { createWriteStream, promises as fsPromises } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { app } from 'electron';

import type {
  ComponentInfo,
  ComponentManifest,
  ComponentStatus,
  DownloadProgress,
  DownloadResult,
  ManifestBinaryComponent,
  ManifestModelComponent,
  VerificationResult,
} from '../../../shared/types/components';
import {
  ComponentIds,
  ComponentDisplayNames,
  COMPONENT_DOWNLOAD_BASE_URL,
} from '../../../shared/types/components';
import { logger } from '../../logger';

/**
 * Event types emitted by ComponentManager
 */
export interface ComponentManagerEvents {
  'status-changed': (info: ComponentInfo) => void;
  'download-progress': (progress: DownloadProgress) => void;
  'download-complete': (componentId: string) => void;
  'download-error': (data: { componentId: string; error: string }) => void;
  'all-ready': () => void;
}

type EventCallback<T> = T extends (...args: infer A) => void ? (...args: A) => void : never;

/**
 * ComponentManager handles on-demand download of audio-engine binary and model files.
 * Components are stored in userData and persist across app updates.
 */
export class ComponentManager {
  private readonly componentsDir: string;
  private manifest: ComponentManifest | null = null;
  private manifestCachePath: string;
  private downloadAbortController: AbortController | null = null;
  private eventListeners: Map<string, Set<EventCallback<unknown>>> = new Map();

  /** Track download state */
  private downloadingComponents: Set<string> = new Set();
  private componentStates: Map<string, ComponentInfo> = new Map();

  /** Track when manifest was last fetched to avoid redundant requests */
  private lastManifestFetchTime: number = 0;
  private static readonly MANIFEST_CACHE_TTL_MS = 30000; // 30 seconds

  constructor() {
    this.componentsDir = path.join(app.getPath('userData'), 'notely-components');
    this.manifestCachePath = path.join(this.componentsDir, 'manifest.json');
  }

  /**
   * Register an event listener
   */
  on<K extends keyof ComponentManagerEvents>(
    event: K,
    callback: ComponentManagerEvents[K]
  ): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback as EventCallback<unknown>);
    return () => this.off(event, callback);
  }

  /**
   * Remove an event listener
   */
  off<K extends keyof ComponentManagerEvents>(event: K, callback: ComponentManagerEvents[K]): void {
    this.eventListeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  /**
   * Emit an event to all listeners
   */
  private emit<K extends keyof ComponentManagerEvents>(
    event: K,
    ...args: Parameters<ComponentManagerEvents[K]>
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        try {
          (listener as (...args: unknown[]) => void)(...args);
        } catch (error) {
          logger.error(`ComponentManager: Error in ${event} listener`, {
            error: error instanceof Error ? error.message : error,
          });
        }
      }
    }
  }

  /**
   * Initialize the component manager - creates directories and loads cached manifest
   */
  async initialize(): Promise<void> {
    logger.debug('ComponentManager: Initializing...');

    // Ensure components directory exists
    await fsPromises.mkdir(this.componentsDir, { recursive: true });
    await fsPromises.mkdir(path.join(this.componentsDir, 'audio-engine'), { recursive: true });
    await fsPromises.mkdir(path.join(this.componentsDir, 'models', 'small.en'), {
      recursive: true,
    });

    // Try to load cached manifest
    await this.loadCachedManifest();

    logger.debug('ComponentManager: Initialized', { componentsDir: this.componentsDir });
  }

  /**
   * Get the platform key for the current platform and architecture
   */
  private getPlatformKey(): string {
    const platform = process.platform;
    const arch = process.arch;
    return `${platform}-${arch}`;
  }

  /**
   * Load manifest from local cache
   */
  private async loadCachedManifest(): Promise<void> {
    try {
      if (fs.existsSync(this.manifestCachePath)) {
        const content = await fsPromises.readFile(this.manifestCachePath, 'utf-8');
        this.manifest = JSON.parse(content) as ComponentManifest;
        logger.debug('ComponentManager: Loaded cached manifest', {
          version: this.manifest.manifestVersion,
          generatedAt: this.manifest.generatedAt,
        });
      }
    } catch (error) {
      logger.warn('ComponentManager: Failed to load cached manifest', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Default headers for HTTP requests to bypass Cloudflare bot detection
   */
  private readonly defaultHeaders = {
    'User-Agent': `Notely/${app.getVersion()} (Electron)`,
    Accept: 'application/json, application/octet-stream, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  /**
   * Fetch manifest from server
   */
  async fetchManifest(): Promise<ComponentManifest> {
    logger.debug('ComponentManager: Fetching manifest from server...');

    const url = `${COMPONENT_DOWNLOAD_BASE_URL}/manifest.json`;

    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        { timeout: 30000, headers: this.defaultHeaders },
        (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            // Handle redirect
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              logger.debug('ComponentManager: Following redirect', { redirectUrl });
              https
                .get(
                  redirectUrl,
                  { timeout: 30000, headers: this.defaultHeaders },
                  (redirectResponse) => {
                    this.handleManifestResponse(redirectResponse, resolve, reject);
                  }
                )
                .on('error', reject);
              return;
            }
          }
          this.handleManifestResponse(response, resolve, reject);
        }
      );

      request.on('error', (error) => {
        logger.error('ComponentManager: Failed to fetch manifest', {
          error: error.message,
        });
        reject(error);
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Manifest fetch timeout'));
      });
    });
  }

  private handleManifestResponse(
    response: http.IncomingMessage,
    resolve: (manifest: ComponentManifest) => void,
    reject: (error: Error) => void
  ): void {
    if (response.statusCode !== 200) {
      reject(new Error(`Failed to fetch manifest: HTTP ${response.statusCode}`));
      return;
    }

    let data = '';
    response.on('data', (chunk) => {
      data += chunk;
    });

    response.on('end', async () => {
      try {
        const manifest = JSON.parse(data) as ComponentManifest;
        this.manifest = manifest;
        this.lastManifestFetchTime = Date.now();

        // Cache the manifest
        await fsPromises.writeFile(this.manifestCachePath, data, 'utf-8');

        logger.debug('ComponentManager: Manifest fetched and cached', {
          version: manifest.manifestVersion,
          componentCount: Object.keys(manifest.components).length,
        });

        resolve(manifest);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    response.on('error', reject);
  }

  /**
   * Compute SHA256 hash of a file
   */
  async computeFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Get the local path for a component
   */
  getComponentPath(componentId: string): string {
    if (componentId === ComponentIds.AUDIO_ENGINE) {
      const binaryName = process.platform === 'win32' ? 'audio-engine.exe' : 'audio-engine';
      return path.join(this.componentsDir, 'audio-engine', binaryName);
    } else if (componentId === ComponentIds.MODEL_SMALL_EN) {
      return path.join(this.componentsDir, 'models', 'small.en');
    }
    throw new Error(`Unknown component: ${componentId}`);
  }

  /**
   * Check if a component exists locally and verify its hash
   */
  async verifyComponent(componentId: string): Promise<VerificationResult> {
    logger.debug('ComponentManager: Verifying component', { componentId });

    if (!this.manifest) {
      try {
        await this.fetchManifest();
      } catch (error) {
        // Try to use cached manifest if fetch fails
        if (!this.manifest) {
          return {
            valid: false,
            componentId,
            error: 'No manifest available',
          };
        }
      }
    }

    const componentDef = this.manifest!.components[componentId];
    if (!componentDef) {
      return {
        valid: false,
        componentId,
        error: `Component not found in manifest: ${componentId}`,
      };
    }

    if (componentId === ComponentIds.AUDIO_ENGINE) {
      return this.verifyBinaryComponent(componentId, componentDef as ManifestBinaryComponent);
    } else if (componentId === ComponentIds.MODEL_SMALL_EN) {
      return this.verifyModelComponent(componentId, componentDef as ManifestModelComponent);
    }

    return {
      valid: false,
      componentId,
      error: `Unknown component type`,
    };
  }

  private async verifyBinaryComponent(
    componentId: string,
    componentDef: ManifestBinaryComponent
  ): Promise<VerificationResult> {
    const platformKey = this.getPlatformKey();
    const platformInfo = componentDef.platforms[platformKey];

    if (!platformInfo) {
      return {
        valid: false,
        componentId,
        error: `No binary available for platform: ${platformKey}`,
      };
    }

    const localPath = this.getComponentPath(componentId);

    if (!fs.existsSync(localPath)) {
      return {
        valid: false,
        componentId,
        expectedHash: platformInfo.sha256,
        error: 'File does not exist',
      };
    }

    try {
      const actualHash = await this.computeFileHash(localPath);
      const valid = actualHash === platformInfo.sha256;

      return {
        valid,
        componentId,
        expectedHash: platformInfo.sha256,
        actualHash,
        error: valid ? undefined : 'Hash mismatch',
      };
    } catch (error) {
      return {
        valid: false,
        componentId,
        expectedHash: platformInfo.sha256,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async verifyModelComponent(
    componentId: string,
    componentDef: ManifestModelComponent
  ): Promise<VerificationResult> {
    const modelDir = this.getComponentPath(componentId);

    // Check all files in the model
    for (const fileInfo of componentDef.files) {
      const localPath = path.join(modelDir, fileInfo.name);

      if (!fs.existsSync(localPath)) {
        return {
          valid: false,
          componentId,
          error: `Missing file: ${fileInfo.name}`,
        };
      }

      try {
        const actualHash = await this.computeFileHash(localPath);
        if (actualHash !== fileInfo.sha256) {
          return {
            valid: false,
            componentId,
            expectedHash: fileInfo.sha256,
            actualHash,
            error: `Hash mismatch for ${fileInfo.name}`,
          };
        }
      } catch (error) {
        return {
          valid: false,
          componentId,
          error: `Failed to verify ${fileInfo.name}: ${error instanceof Error ? error.message : error}`,
        };
      }
    }

    return {
      valid: true,
      componentId,
    };
  }

  /**
   * Check the status of all required components
   */
  async checkAllComponents(): Promise<ComponentInfo[]> {
    logger.debug('ComponentManager: Checking all components...');

    // Only fetch manifest if we don't have one or it's stale
    const now = Date.now();
    const manifestAge = now - this.lastManifestFetchTime;
    const shouldFetchManifest =
      !this.manifest || manifestAge > ComponentManager.MANIFEST_CACHE_TTL_MS;

    if (shouldFetchManifest) {
      try {
        await this.fetchManifest();
      } catch (error) {
        logger.warn('ComponentManager: Failed to fetch manifest, using cached version', {
          error: error instanceof Error ? error.message : error,
        });
      }
    } else {
      logger.debug('ComponentManager: Using cached manifest', { ageMs: manifestAge });
    }

    const components: ComponentInfo[] = [];

    for (const componentId of [ComponentIds.AUDIO_ENGINE, ComponentIds.MODEL_SMALL_EN]) {
      const info = await this.getComponentInfo(componentId);
      components.push(info);
      this.componentStates.set(componentId, info);
    }

    logger.debug('ComponentManager: Component check complete', {
      components: components.map((c) => ({ id: c.id, status: c.status })),
    });

    return components;
  }

  /**
   * Get detailed info about a specific component
   */
  async getComponentInfo(componentId: string): Promise<ComponentInfo> {
    const displayName = ComponentDisplayNames[componentId] || componentId;
    const type = componentId === ComponentIds.AUDIO_ENGINE ? 'binary' : 'model';

    // Check if currently downloading
    if (this.downloadingComponents.has(componentId)) {
      const cachedState = this.componentStates.get(componentId);
      if (cachedState) {
        return cachedState;
      }
      return {
        id: componentId,
        type,
        displayName,
        status: 'downloading',
        downloadProgress: 0,
      };
    }

    // Get size from manifest
    let sizeBytes: number | undefined;
    if (this.manifest?.components[componentId]) {
      const componentDef = this.manifest.components[componentId];
      if (componentDef.type === 'binary') {
        const platformKey = this.getPlatformKey();
        const platformInfo = (componentDef as ManifestBinaryComponent).platforms[platformKey];
        sizeBytes = platformInfo?.sizeBytes;
      } else {
        sizeBytes = (componentDef as ManifestModelComponent).totalSizeBytes;
      }
    }

    // Verify component
    const verification = await this.verifyComponent(componentId);

    let status: ComponentStatus;
    if (verification.valid) {
      status = 'ready';
    } else if (
      verification.error?.includes('does not exist') ||
      verification.error?.includes('Missing file')
    ) {
      status = 'not_downloaded';
    } else if (verification.error?.includes('Hash mismatch')) {
      status = 'corrupted';
    } else {
      status = 'error';
    }

    const info: ComponentInfo = {
      id: componentId,
      type,
      displayName,
      status,
      localPath: this.getComponentPath(componentId),
      expectedHash: verification.expectedHash,
      actualHash: verification.actualHash,
      sizeBytes,
      errorMessage: verification.error,
      version: this.manifest?.components[componentId]?.version,
    };

    this.componentStates.set(componentId, info);
    return info;
  }

  /**
   * Download a specific component
   */
  async downloadComponent(
    componentId: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    logger.debug('ComponentManager: Starting download', { componentId });

    if (this.downloadingComponents.has(componentId)) {
      return {
        success: false,
        componentId,
        error: 'Download already in progress',
      };
    }

    if (!this.manifest) {
      try {
        await this.fetchManifest();
      } catch (error) {
        return {
          success: false,
          componentId,
          error: `Failed to fetch manifest: ${error instanceof Error ? error.message : error}`,
        };
      }
    }

    const componentDef = this.manifest!.components[componentId];
    if (!componentDef) {
      return {
        success: false,
        componentId,
        error: `Component not found in manifest: ${componentId}`,
      };
    }

    this.downloadingComponents.add(componentId);
    this.updateComponentStatus(componentId, 'downloading');

    try {
      if (componentDef.type === 'binary') {
        return await this.downloadBinaryComponent(
          componentId,
          componentDef as ManifestBinaryComponent,
          onProgress
        );
      } else {
        return await this.downloadModelComponent(
          componentId,
          componentDef as ManifestModelComponent,
          onProgress
        );
      }
    } finally {
      this.downloadingComponents.delete(componentId);
    }
  }

  private async downloadBinaryComponent(
    componentId: string,
    componentDef: ManifestBinaryComponent,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    const platformKey = this.getPlatformKey();
    const platformInfo = componentDef.platforms[platformKey];

    if (!platformInfo) {
      this.updateComponentStatus(componentId, 'error', `No binary for platform: ${platformKey}`);
      return {
        success: false,
        componentId,
        error: `No binary available for platform: ${platformKey}`,
      };
    }

    const url = `${COMPONENT_DOWNLOAD_BASE_URL}/${platformInfo.file}`;
    const localPath = this.getComponentPath(componentId);

    // Ensure directory exists
    await fsPromises.mkdir(path.dirname(localPath), { recursive: true });

    try {
      await this.downloadFile(url, localPath, platformInfo.sizeBytes, componentId, onProgress);

      // Make binary executable on Unix
      if (process.platform !== 'win32') {
        await fsPromises.chmod(localPath, 0o755);
      }

      // Verify hash
      this.updateComponentStatus(componentId, 'verifying');
      const actualHash = await this.computeFileHash(localPath);

      if (actualHash !== platformInfo.sha256) {
        // Delete corrupted file
        await fsPromises.unlink(localPath).catch(() => {});
        this.updateComponentStatus(componentId, 'corrupted', 'Downloaded file hash mismatch');
        return {
          success: false,
          componentId,
          error: 'Downloaded file verification failed - hash mismatch',
        };
      }

      this.updateComponentStatus(componentId, 'ready');
      this.emit('download-complete', componentId);

      return {
        success: true,
        componentId,
        localPath,
        hash: actualHash,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateComponentStatus(componentId, 'error', errorMsg);
      this.emit('download-error', { componentId, error: errorMsg });
      return {
        success: false,
        componentId,
        error: errorMsg,
      };
    }
  }

  private async downloadModelComponent(
    componentId: string,
    componentDef: ManifestModelComponent,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<DownloadResult> {
    const modelDir = this.getComponentPath(componentId);

    // Ensure directory exists
    await fsPromises.mkdir(modelDir, { recursive: true });

    let totalDownloaded = 0;
    const totalSize = componentDef.totalSizeBytes;

    try {
      for (const fileInfo of componentDef.files) {
        const url = `${COMPONENT_DOWNLOAD_BASE_URL}/${fileInfo.path}`;
        const localPath = path.join(modelDir, fileInfo.name);

        await this.downloadFile(url, localPath, fileInfo.sizeBytes, componentId, (progress) => {
          // Calculate overall progress including already downloaded files
          const currentFileProgress = progress.bytesDownloaded;
          const overallDownloaded = totalDownloaded + currentFileProgress;
          const overallPercent = Math.round((overallDownloaded / totalSize) * 100);

          if (onProgress) {
            onProgress({
              ...progress,
              bytesTotal: totalSize,
              bytesDownloaded: overallDownloaded,
              overallPercent,
            });
          }

          this.emit('download-progress', {
            componentId,
            percent: overallPercent,
            bytesDownloaded: overallDownloaded,
            bytesTotal: totalSize,
            overallPercent,
          });
        });

        totalDownloaded += fileInfo.sizeBytes;

        // Verify file hash
        const actualHash = await this.computeFileHash(localPath);
        if (actualHash !== fileInfo.sha256) {
          await fsPromises.unlink(localPath).catch(() => {});
          throw new Error(`Hash mismatch for ${fileInfo.name}`);
        }
      }

      this.updateComponentStatus(componentId, 'ready');
      this.emit('download-complete', componentId);

      return {
        success: true,
        componentId,
        localPath: modelDir,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.updateComponentStatus(componentId, 'error', errorMsg);
      this.emit('download-error', { componentId, error: errorMsg });
      return {
        success: false,
        componentId,
        error: errorMsg,
      };
    }
  }

  private downloadFile(
    url: string,
    localPath: string,
    totalSize: number,
    componentId: string,
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const tempPath = `${localPath}.tmp`;
      const fileStream = createWriteStream(tempPath);

      let downloadedBytes = 0;
      const startTime = Date.now();

      const request = https.get(
        url,
        { timeout: 300000, headers: this.defaultHeaders },
        (response) => {
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              fileStream.close();
              fsPromises.unlink(tempPath).catch(() => {});
              this.downloadFile(redirectUrl, localPath, totalSize, componentId, onProgress)
                .then(resolve)
                .catch(reject);
              return;
            }
          }

          if (response.statusCode !== 200) {
            fileStream.close();
            fsPromises.unlink(tempPath).catch(() => {});
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          response.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length;
            const percent = Math.round((downloadedBytes / totalSize) * 100);
            const elapsed = (Date.now() - startTime) / 1000;
            const speedBps = elapsed > 0 ? downloadedBytes / elapsed : 0;
            const remaining = totalSize - downloadedBytes;
            const estimatedTimeMs = speedBps > 0 ? (remaining / speedBps) * 1000 : undefined;

            // Update component state
            const state = this.componentStates.get(componentId);
            if (state) {
              state.downloadProgress = percent;
              this.componentStates.set(componentId, state);
            }

            if (onProgress) {
              onProgress({
                componentId,
                percent,
                bytesDownloaded: downloadedBytes,
                bytesTotal: totalSize,
                overallPercent: percent,
                speedBps,
                estimatedTimeMs,
              });
            }

            this.emit('download-progress', {
              componentId,
              percent,
              bytesDownloaded: downloadedBytes,
              bytesTotal: totalSize,
              overallPercent: percent,
              speedBps,
              estimatedTimeMs,
            });
          });

          pipeline(response, fileStream)
            .then(async () => {
              // Remove existing target to avoid EPERM on Windows where
              // Defender may hold a brief lock on the previous binary
              await fsPromises.unlink(localPath).catch(() => {});

              // Retry rename with backoff — Windows Defender can transiently
              // lock newly-written executables during scanning
              let lastError: Error | undefined;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  await fsPromises.rename(tempPath, localPath);
                  lastError = undefined;
                  break;
                } catch (err: unknown) {
                  lastError = err as Error;
                  if ((err as NodeJS.ErrnoException).code === 'EPERM' && attempt < 2) {
                    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
                  } else {
                    throw err;
                  }
                }
              }
              if (lastError) throw lastError;

              resolve();
            })
            .catch(async (error) => {
              await fsPromises.unlink(tempPath).catch(() => {});
              reject(error);
            });
        }
      );

      request.on('error', async (error) => {
        fileStream.close();
        await fsPromises.unlink(tempPath).catch(() => {});
        reject(error);
      });

      request.on('timeout', async () => {
        request.destroy();
        fileStream.close();
        await fsPromises.unlink(tempPath).catch(() => {});
        reject(new Error('Download timeout'));
      });
    });
  }

  private updateComponentStatus(
    componentId: string,
    status: ComponentStatus,
    errorMessage?: string
  ): void {
    const state = this.componentStates.get(componentId) || {
      id: componentId,
      type: componentId === ComponentIds.AUDIO_ENGINE ? 'binary' : 'model',
      displayName: ComponentDisplayNames[componentId] || componentId,
      status,
    };

    state.status = status;
    state.errorMessage = errorMessage;
    this.componentStates.set(componentId, state);

    this.emit('status-changed', state);
  }

  /**
   * Download all missing or corrupted components
   */
  async downloadAllComponents(
    onProgress?: (progress: DownloadProgress) => void
  ): Promise<{ success: boolean; results: DownloadResult[] }> {
    logger.debug('ComponentManager: Starting download of all components');

    const components = await this.checkAllComponents();
    const needsDownload = components.filter(
      (c) => c.status === 'not_downloaded' || c.status === 'corrupted'
    );

    if (needsDownload.length === 0) {
      logger.debug('ComponentManager: All components already ready');
      this.emit('all-ready');
      return { success: true, results: [] };
    }

    // Calculate total size for overall progress
    const totalSize = needsDownload.reduce((sum, c) => sum + (c.sizeBytes || 0), 0);
    let overallDownloaded = 0;

    const results: DownloadResult[] = [];

    for (const component of needsDownload) {
      const componentSize = component.sizeBytes || 0;
      let componentDownloaded = 0;

      const result = await this.downloadComponent(component.id, (progress) => {
        componentDownloaded = progress.bytesDownloaded;
        const currentOverall = overallDownloaded + componentDownloaded;
        const overallPercent = totalSize > 0 ? Math.round((currentOverall / totalSize) * 100) : 0;

        if (onProgress) {
          onProgress({
            ...progress,
            bytesTotal: totalSize,
            bytesDownloaded: currentOverall,
            overallPercent,
          });
        }
      });

      results.push(result);

      if (result.success) {
        overallDownloaded += componentSize;
      } else {
        logger.error('ComponentManager: Component download failed', {
          componentId: component.id,
          error: result.error,
        });
        return { success: false, results };
      }
    }

    logger.debug('ComponentManager: All components downloaded successfully');
    this.emit('all-ready');
    return { success: true, results };
  }

  /**
   * Cancel any in-progress downloads
   */
  cancelDownload(): void {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
    this.downloadingComponents.clear();
  }

  /**
   * Delete and re-download a corrupted component
   */
  async repairComponent(componentId: string): Promise<DownloadResult> {
    logger.debug('ComponentManager: Repairing component', { componentId });

    const localPath = this.getComponentPath(componentId);

    // Delete existing files
    try {
      if (componentId === ComponentIds.MODEL_SMALL_EN) {
        // Delete entire model directory
        await fsPromises.rm(localPath, { recursive: true, force: true });
      } else {
        // Delete single binary
        await fsPromises.unlink(localPath).catch(() => {});
      }
    } catch (error) {
      logger.warn('ComponentManager: Failed to delete component files', {
        componentId,
        error: error instanceof Error ? error.message : error,
      });
    }

    // Re-download
    return this.downloadComponent(componentId);
  }

  /**
   * Check if all required components are ready
   */
  async areAllComponentsReady(): Promise<boolean> {
    const components = await this.checkAllComponents();
    return components.every((c) => c.status === 'ready');
  }

  /**
   * Ensure the audio-engine binary is present and valid.
   * Verifies hash against manifest; downloads if missing or corrupted.
   * Corrupted binaries are renamed to .back before re-downloading.
   */
  async ensureAudioEngine(): Promise<{ alreadyValid: boolean; path: string }> {
    // Fetch manifest (or use cached)
    if (!this.manifest) {
      await this.fetchManifest();
    }

    if (!this.manifest) {
      throw new Error('No component manifest available');
    }

    const componentId = ComponentIds.AUDIO_ENGINE;
    const localPath = this.getComponentPath(componentId);
    const componentDef = this.manifest.components[componentId] as
      | ManifestBinaryComponent
      | undefined;

    if (!componentDef) {
      throw new Error(`Component ${componentId} not found in manifest`);
    }

    const platformKey = this.getPlatformKey();
    const platformInfo = componentDef.platforms[platformKey];
    if (!platformInfo) {
      throw new Error(`No binary available for platform: ${platformKey}`);
    }

    // Check if file exists and verify hash
    if (fs.existsSync(localPath)) {
      const actualHash = await this.computeFileHash(localPath);
      if (actualHash === platformInfo.sha256) {
        logger.info('ComponentManager: Audio engine binary valid', {
          path: localPath,
          hash: actualHash.substring(0, 12),
        });
        this.emit('all-ready');
        return { alreadyValid: true, path: localPath };
      }

      // Hash mismatch — rename to .back and re-download
      logger.warn('ComponentManager: Audio engine hash mismatch, renaming to .back', {
        expected: platformInfo.sha256.substring(0, 12),
        actual: actualHash.substring(0, 12),
      });
      try {
        await fsPromises.rename(localPath, `${localPath}.back`);
      } catch {
        await fsPromises.unlink(localPath).catch(() => {});
      }
    }

    // Binary missing or just renamed — download it
    logger.info('ComponentManager: Downloading audio engine binary...');
    const result = await this.downloadComponent(componentId);

    if (!result.success) {
      throw new Error(`Failed to download audio engine: ${result.error}`);
    }

    this.emit('all-ready');
    return { alreadyValid: false, path: localPath };
  }

  /**
   * Get the audio-engine binary path (for TranscriptionServerManager)
   */
  getAudioEnginePath(): string {
    return this.getComponentPath(ComponentIds.AUDIO_ENGINE);
  }

  /**
   * Get the model directory path (for TranscriptionServerManager)
   */
  getModelPath(): string {
    return this.getComponentPath(ComponentIds.MODEL_SMALL_EN);
  }
}
