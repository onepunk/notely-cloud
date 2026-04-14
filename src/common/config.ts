export interface ServiceConfig {
  api: string;
  admin: string;
  calendar: string;
  sync?: string;
}

// ============================================================================
// Local Server Configuration
// ============================================================================

/**
 * Configuration for local servers (transcription, etc.)
 * Uses high port range (48xxx) to avoid conflicts with common local services.
 */
export interface LocalServerConfig {
  /** Host for local servers (127.0.0.1 for localhost-only binding) */
  host: string;
  /** Port for the transcription server (Python/Whisper) */
  transcriptionPort: number;
}

/**
 * Default configuration for local servers.
 * Port allocation strategy uses 48xxx range to avoid conflicts.
 */
export const LOCAL_SERVER_CONFIG: LocalServerConfig = {
  host: '127.0.0.1',
  transcriptionPort: 48181,
};

/**
 * Get the WebSocket URL for the transcription server.
 * @param port Optional port override (defaults to LOCAL_SERVER_CONFIG.transcriptionPort)
 */
export function getTranscriptionServerWsUrl(port?: number): string {
  const p = port ?? LOCAL_SERVER_CONFIG.transcriptionPort;
  return `ws://${LOCAL_SERVER_CONFIG.host}:${p}/ws`;
}

/**
 * Get the HTTP health check URL for the transcription server.
 * @param port Optional port override (defaults to LOCAL_SERVER_CONFIG.transcriptionPort)
 */
export function getTranscriptionServerHealthUrl(port?: number): string {
  const p = port ?? LOCAL_SERVER_CONFIG.transcriptionPort;
  return `http://${LOCAL_SERVER_CONFIG.host}:${p}/health`;
}

export interface TranscriptionConfig {
  // Backend Configuration
  backendType: 'auto' | 'nvidia' | 'apple';

  // Model Configuration
  modelName: string;
  language: string;
  useGpu: boolean;
  beamSize: number;
  temperature: number;

  // Sliding Window Configuration
  useSlidingWindow: boolean;
  windowSizeMs: number;
  windowOverlapMs: number;
  maxSegmentLengthMs: number;
  minStableIterations: number; // LocalAgreement iterations before commit
  commitDelayMs: number; // Wait before committing stable text
  maxPendingAudioMs: number; // Force commit threshold
  contextPromptMaxChars: number; // Max chars for context prompt

  // Refinement Configuration
  refinementEnabled: boolean;
  refinementDelayMs: number;
  refinementBeamSize: number;
  refinementTemperature: number;
  refinementWorkers: number;
  refinementMaxQueueSize: number;

  // VAD Configuration
  vadEnabled: boolean;
  vadThreshold: number;
  vadMinSpeechDurationMs: number;
  vadMinSilenceDurationMs: number;
  vadSpeechPadMs: number;

  // Protocol Configuration
  unstableTokenCount: number;
  heartbeatIntervalMs: number;

  // Quality Filters
  minWindowRms: number;
  repetitionFilterMinWords: number;

  // Hallucination Prevention (inference-level)
  conditionOnPreviousText: boolean;
  repetitionPenalty: number;
  noRepeatNgramSize: number;
}

export const TRANSCRIPTION_CONFIG: TranscriptionConfig = {
  // Backend Configuration
  backendType: 'auto', // 'auto' detects GPU platform, 'nvidia' for CUDA, 'apple' for MLX

  // Model Configuration
  modelName: 'small.en',
  language: 'auto',
  useGpu: false,
  beamSize: 5, // Higher accuracy for proper names and uncommon words
  temperature: 0.0, // Deterministic for consistency

  // Sliding Window Configuration
  useSlidingWindow: true, // Enable O(1) sliding window processing
  windowSizeMs: 45000, // 45 second windows
  windowOverlapMs: 7500, // 7.5 second overlap
  maxSegmentLengthMs: 60000, // Max 60 second segments
  minStableIterations: 2, // LocalAgreement iterations before commit
  commitDelayMs: 1000, // Wait 1s before committing stable text
  maxPendingAudioMs: 75000, // Force commit if buffer exceeds 75s
  contextPromptMaxChars: 1200, // Max chars from committed text as prompt

  // Refinement Configuration (async re-transcription with better params)
  refinementEnabled: true,
  refinementDelayMs: 2000, // Wait 2s before refining
  refinementBeamSize: 5, // Higher accuracy
  refinementTemperature: 0.0, // Deterministic
  refinementWorkers: 1, // Single worker for refinement
  refinementMaxQueueSize: 100, // Max queued refinement jobs

  // VAD Configuration (Voice Activity Detection)
  vadEnabled: true,
  vadThreshold: 0.5, // More conservative to avoid splitting proper names
  vadMinSpeechDurationMs: 250, // Min speech length
  vadMinSilenceDurationMs: 500, // Min silence to segment
  vadSpeechPadMs: 400, // Padding around speech

  // Protocol Configuration
  unstableTokenCount: 6, // Number of unstable tokens in partial updates
  heartbeatIntervalMs: 250, // Partial update frequency

  // Quality Filters
  minWindowRms: 0.0002, // Min audio level (filter silence)
  repetitionFilterMinWords: 4, // Filter "word word word word" hallucinations (more conservative)

  // Hallucination Prevention (inference-level)
  conditionOnPreviousText: false, // Prevents hallucination propagation between segments
  repetitionPenalty: 1.2, // Penalizes repeated tokens during beam search
  noRepeatNgramSize: 3, // Prevents any trigram from repeating
};

/**
 * Build a transcription config by merging user overrides onto TRANSCRIPTION_CONFIG defaults.
 * Only non-empty, valid values from overrides are applied; everything else falls through
 * to the hardcoded defaults.
 */
export function buildTranscriptionConfig(
  overrides: Partial<TranscriptionConfig>
): TranscriptionConfig {
  const merged = { ...TRANSCRIPTION_CONFIG };

  for (const key of Object.keys(overrides) as Array<keyof TranscriptionConfig>) {
    const value = overrides[key];
    // Skip undefined/null values — they fall through to defaults
    if (value === undefined || value === null) continue;
    // Skip empty strings (settings store returns '' for unset keys)
    if (value === '') continue;
    // For numbers, skip NaN
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    // Type-safe assignment
    (merged as Record<string, unknown>)[key] = value;
  }

  return merged;
}

export const SERVICE_URLS: Record<string, ServiceConfig> = {
  development: {
    api: 'https://api.yourdomain.com',
    admin: 'https://admin.yourdomain.com',
    calendar: 'https://calendar.yourdomain.com',
    sync: 'https://api.yourdomain.com/api/sync',
  },
  production: {
    api: 'https://api.yourdomain.com',
    admin: 'https://admin.yourdomain.com',
    calendar: 'https://calendar.yourdomain.com',
    sync: 'https://api.yourdomain.com/api/sync',
  },
};

// Default to development environment
export const CURRENT_ENV = 'development' as keyof typeof SERVICE_URLS;

// Default service URLs for current environment
export const DEFAULT_API_URL = SERVICE_URLS[CURRENT_ENV].api;
export const DEFAULT_ADMIN_URL = SERVICE_URLS[CURRENT_ENV].admin;
export const DEFAULT_CALENDAR_URL = SERVICE_URLS[CURRENT_ENV].calendar;

function normalizeUrl(url: string | null | undefined): string {
  if (!url) {
    return '';
  }
  return url.replace(/\/+$/, '');
}

// Helper function to get service URL by environment
export function getServiceUrl(
  service: keyof ServiceConfig,
  env: keyof typeof SERVICE_URLS = CURRENT_ENV
): string {
  return SERVICE_URLS[env][service];
}

// Helper function to detect service type from URL
export function getServiceType(url: string): 'api' | 'admin' | 'calendar' | 'custom' {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return 'custom';
  }

  for (const config of Object.values(SERVICE_URLS)) {
    if (normalized === normalizeUrl(config.api)) return 'api';
    if (normalized === normalizeUrl(config.admin)) return 'admin';
    if (normalized === normalizeUrl(config.calendar)) return 'calendar';
  }
  return 'custom';
}

// Helper function to check if URL is a known Notely service
export function isNotelyService(url: string): boolean {
  return getServiceType(url) !== 'custom';
}

export function findServiceMatch(
  url: string
): { env: keyof typeof SERVICE_URLS; service: keyof ServiceConfig } | null {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return null;
  }

  for (const [env, config] of Object.entries(SERVICE_URLS) as Array<
    [keyof typeof SERVICE_URLS, ServiceConfig]
  >) {
    for (const key of Object.keys(config) as Array<keyof ServiceConfig>) {
      if (normalized === normalizeUrl(config[key])) {
        return { env, service: key };
      }
    }
  }

  return null;
}

// Portal URLs for license management
export const PORTAL_URL = 'https://portal.yourdomain.com';
export const PLANS_URL = 'https://yourdomain.com/plans';

// Security Configuration
export interface SecurityConfig {
  /**
   * Disable certificate pinning for local development.
   * WARNING: Only set to true when testing against local servers without valid certs.
   * This setting is IGNORED in production builds (app.isPackaged === true).
   */
  disableCertificatePinning: boolean;
}

export const SECURITY_CONFIG: SecurityConfig = {
  disableCertificatePinning: false, // Set to true only for local testing
};
