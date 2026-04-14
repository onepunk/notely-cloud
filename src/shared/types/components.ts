/**
 * Shared TypeScript types for component download functionality
 * Used by both main and renderer processes
 */

/**
 * Component status representing the current state of a downloadable component
 */
export type ComponentStatus =
  | 'not_downloaded'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'corrupted'
  | 'error';

/**
 * Component type classification
 */
export type ComponentType = 'binary' | 'model';

/**
 * Information about a single downloadable component
 */
export interface ComponentInfo {
  /** Unique identifier (e.g., 'audio-engine' or 'model-small.en') */
  id: string;
  /** Type of component */
  type: ComponentType;
  /** Display name for UI */
  displayName: string;
  /** Current status */
  status: ComponentStatus;
  /** Local path when downloaded */
  localPath?: string;
  /** Expected SHA256 hash from manifest */
  expectedHash?: string;
  /** Actual SHA256 hash computed from local file */
  actualHash?: string;
  /** Download progress (0-100) */
  downloadProgress?: number;
  /** Size in bytes */
  sizeBytes?: number;
  /** Error message if status is 'error' */
  errorMessage?: string;
  /** Version from manifest */
  version?: string;
}

/**
 * Platform-specific binary information in manifest
 */
export interface PlatformBinaryInfo {
  /** Relative path to file on server */
  file: string;
  /** SHA256 hash of the file */
  sha256: string;
  /** Size in bytes */
  sizeBytes: number;
}

/**
 * Model file information in manifest
 */
export interface ModelFileInfo {
  /** File name (e.g., 'model.bin') */
  name: string;
  /** Relative path on server */
  path: string;
  /** SHA256 hash of the file */
  sha256: string;
  /** Size in bytes */
  sizeBytes: number;
}

/**
 * Binary component definition in manifest
 */
export interface ManifestBinaryComponent {
  type: 'binary';
  version: string;
  /** Platform-specific binaries keyed by platform (e.g., 'win32-x64', 'darwin-arm64') */
  platforms: Record<string, PlatformBinaryInfo>;
}

/**
 * Model component definition in manifest
 */
export interface ManifestModelComponent {
  type: 'model';
  version: string;
  /** List of files that make up the model */
  files: ModelFileInfo[];
  /** Total size of all files */
  totalSizeBytes: number;
}

/**
 * Component manifest from server
 */
export interface ComponentManifest {
  /** Manifest format version */
  manifestVersion: string;
  /** When the manifest was generated */
  generatedAt: string;
  /** Components available for download */
  components: {
    [id: string]: ManifestBinaryComponent | ManifestModelComponent;
  };
}

/**
 * Download progress event payload
 */
export interface DownloadProgress {
  /** Component being downloaded */
  componentId: string;
  /** Progress for this component (0-100) */
  percent: number;
  /** Bytes downloaded so far */
  bytesDownloaded: number;
  /** Total bytes to download */
  bytesTotal: number;
  /** Overall progress across all components (0-100) */
  overallPercent: number;
  /** Download speed in bytes per second */
  speedBps?: number;
  /** Estimated time remaining in milliseconds */
  estimatedTimeMs?: number;
}

/**
 * Component status change event payload
 */
export interface ComponentStatusChanged {
  componentId: string;
  status: ComponentStatus;
  hash?: string;
  errorMessage?: string;
}

/**
 * Download error event payload
 */
export interface DownloadError {
  componentId: string;
  error: string;
  retryable: boolean;
}

/**
 * All components ready event payload
 */
export interface AllComponentsReady {
  components: ComponentInfo[];
  timestamp: string;
}

/**
 * Component download result
 */
export interface DownloadResult {
  success: boolean;
  componentId: string;
  localPath?: string;
  hash?: string;
  error?: string;
}

/**
 * Verification result for a component
 */
export interface VerificationResult {
  valid: boolean;
  componentId: string;
  expectedHash?: string;
  actualHash?: string;
  error?: string;
}

/**
 * Constants for component IDs
 */
export const ComponentIds = {
  AUDIO_ENGINE: 'audio-engine',
  MODEL_SMALL_EN: 'model-small.en',
} as const;

/**
 * Display names for components
 */
export const ComponentDisplayNames: Record<string, string> = {
  [ComponentIds.AUDIO_ENGINE]: 'Speech Engine',
  [ComponentIds.MODEL_SMALL_EN]: 'Speech Model',
};

/**
 * Setup status event sent from main process to renderer during startup
 */
export interface SetupStatusEvent {
  phase: 'verifying' | 'downloading' | 'starting-server' | 'ready' | 'error';
  message?: string;
}

/**
 * Component download base URL
 */
export const COMPONENT_DOWNLOAD_BASE_URL = 'https://get.yourdomain.com/components';
