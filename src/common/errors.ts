/**
 * Centralized Error Code Registry
 *
 * Error codes follow the pattern: E{category}{number}
 * - E1xxx: Authentication & Authorization
 * - E2xxx: Sync & Network
 * - E3xxx: AI/Summary/Transcription
 * - E4xxx: Storage & Database
 * - E5xxx: Export & Import
 * - E6xxx: Calendar & Integrations
 * - E7xxx: Security & Encryption
 * - E8xxx: System & General
 *
 * Each error code maps to a user-friendly message.
 * Internal details are logged separately with a correlation ID.
 */

export interface ErrorDefinition {
  readonly code: string;
  readonly message: string;
  /** Optional hint for the user on how to resolve */
  readonly hint?: string;
}

/**
 * Error code definitions - user-friendly messages only
 */
export const ERROR_CODES = {
  // Authentication & Authorization (E1xxx)
  E1001: { code: 'E1001', message: 'Authentication failed' },
  E1002: { code: 'E1002', message: 'Session expired. Please sign in again' },
  E1003: { code: 'E1003', message: 'Not authorized to perform this action' },
  E1004: { code: 'E1004', message: 'Could not open sign-in window' },
  E1005: { code: 'E1005', message: 'Account linking failed' },
  E1006: { code: 'E1006', message: 'License activation failed' },
  E1007: { code: 'E1007', message: 'Sign out failed' },

  // Sync & Network (E2xxx)
  E2001: { code: 'E2001', message: 'Sync failed', hint: 'Check your internet connection' },
  E2002: {
    code: 'E2002',
    message: 'Cannot connect to server',
    hint: 'Check your internet connection',
  },
  E2003: { code: 'E2003', message: 'Sync conflict detected' },
  E2004: { code: 'E2004', message: 'Server is unavailable', hint: 'Try again later' },
  E2005: { code: 'E2005', message: 'Request timed out', hint: 'Check your internet connection' },

  // AI/Summary/Transcription (E3xxx)
  E3001: { code: 'E3001', message: 'Failed to generate summary', hint: 'Try again later' },
  E3002: { code: 'E3002', message: 'Summary not found' },
  E3003: { code: 'E3003', message: 'Transcription has no text to summarize' },
  E3004: { code: 'E3004', message: 'Transcription failed' },
  E3005: { code: 'E3005', message: 'Transcription server unavailable' },
  E3006: { code: 'E3006', message: 'Recording not found' },
  E3007: { code: 'E3007', message: 'Failed to start meeting recording' },
  E3008: { code: 'E3008', message: 'Failed to create transcription' },
  E3009: {
    code: 'E3009',
    message: 'No microphone found',
    hint: 'Please connect a microphone and try again',
  },
  E3010: {
    code: 'E3010',
    message: 'Microphone access denied',
    hint: 'Allow microphone access in your system settings',
  },
  E3011: {
    code: 'E3011',
    message: 'Microphone is in use',
    hint: 'Close other apps that may be using the microphone',
  },

  // Storage & Database (E4xxx)
  E4001: { code: 'E4001', message: 'Failed to save note' },
  E4002: { code: 'E4002', message: 'Failed to load note' },
  E4003: { code: 'E4003', message: 'Database is busy', hint: 'Please try again' },
  E4004: { code: 'E4004', message: 'Note not found' },
  E4005: { code: 'E4005', message: 'Failed to create note' },
  E4006: { code: 'E4006', message: 'Failed to delete note' },
  E4007: { code: 'E4007', message: 'Failed to update note' },
  E4008: { code: 'E4008', message: 'Failed to empty trash' },
  E4009: { code: 'E4009', message: 'Failed to archive note' },
  E4010: { code: 'E4010', message: 'Failed to unarchive note' },
  E4011: { code: 'E4011', message: 'Failed to update starred status' },
  E4012: { code: 'E4012', message: 'Failed to load conflict data' },
  E4013: { code: 'E4013', message: 'Failed to resolve conflict' },

  // Export & Import (E5xxx)
  E5001: { code: 'E5001', message: 'Export failed' },
  E5002: { code: 'E5002', message: 'No note selected for export' },
  E5003: { code: 'E5003', message: 'Import failed' },
  E5004: { code: 'E5004', message: 'Unsupported file format' },

  // Calendar & Integrations (E6xxx)
  E6001: { code: 'E6001', message: 'Calendar sync failed' },
  E6002: { code: 'E6002', message: 'Failed to connect calendar' },
  E6003: { code: 'E6003', message: 'Calendar authorization failed' },

  // Security & Encryption (E7xxx)
  E7001: { code: 'E7001', message: 'Incorrect password' },
  E7002: { code: 'E7002', message: 'Failed to enable password protection' },
  E7003: { code: 'E7003', message: 'Failed to disable password protection' },
  E7004: { code: 'E7004', message: 'Invalid recovery key format' },
  E7005: { code: 'E7005', message: 'Database is locked', hint: 'Enter password to unlock' },
  E7006: { code: 'E7006', message: 'Failed to change password' },
  E7007: { code: 'E7007', message: 'Failed to unlock database' },
  E7008: { code: 'E7008', message: 'Failed to reset password' },
  E7009: { code: 'E7009', message: 'Failed to load security settings' },

  // System & General (E8xxx)
  E8001: { code: 'E8001', message: 'Something went wrong' },
  E8002: { code: 'E8002', message: 'Operation failed' },
  E8003: { code: 'E8003', message: 'Feature not available' },
  E8004: { code: 'E8004', message: 'Invalid request' },
  E8005: { code: 'E8005', message: 'Search failed' },
  E8006: { code: 'E8006', message: 'Failed to copy to clipboard' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Generate a short correlation ID for error tracking.
 * Format: 6 alphanumeric characters (e.g., "a1b2c3")
 */
export function generateCorrelationId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Application Error with error code and correlation ID.
 * Use this for all errors that may be shown to users.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly correlationId: string;
  public readonly userMessage: string;
  public readonly hint?: string;
  public readonly internalDetails?: Record<string, unknown>;
  public readonly originalCause?: unknown;

  constructor(
    code: ErrorCode,
    options?: {
      /** Override the default user message */
      userMessage?: string;
      /** Internal details for logging (never shown to user) */
      internalDetails?: Record<string, unknown>;
      /** Original error that caused this */
      cause?: unknown;
    }
  ) {
    const errorDef = ERROR_CODES[code] as ErrorDefinition;
    const userMessage = options?.userMessage || errorDef.message;

    super(userMessage);
    this.name = 'AppError';
    this.code = code;
    this.correlationId = generateCorrelationId();
    this.userMessage = userMessage;
    this.hint = errorDef.hint;
    this.internalDetails = options?.internalDetails;

    // Capture the original error
    if (options?.cause !== undefined) {
      this.originalCause = options.cause;
    }
  }

  /**
   * Get the formatted message for display in UI (toast, error boundary, etc.)
   * Format: "User message (E1234)"
   */
  toUserString(): string {
    return `${this.userMessage} (${this.code})`;
  }

  /**
   * Get the full message including reference ID for support
   * Format: "User message (E1234)\nRef: abc123"
   */
  toUserStringWithRef(): string {
    return `${this.userMessage} (${this.code})\nRef: ${this.correlationId}`;
  }

  /**
   * Get the object for logging (includes all internal details)
   */
  toLogObject(): Record<string, unknown> {
    return {
      errorCode: this.code,
      correlationId: this.correlationId,
      userMessage: this.userMessage,
      internalDetails: this.internalDetails,
      originalCause:
        this.originalCause instanceof Error
          ? {
              name: this.originalCause.name,
              message: this.originalCause.message,
              stack: this.originalCause.stack,
            }
          : this.originalCause,
      stack: this.stack,
    };
  }
}

/**
 * Wrap an unknown error into an AppError.
 * Useful for catch blocks where you don't know the error type.
 */
export function wrapError(
  error: unknown,
  code: ErrorCode = 'E8001',
  internalDetails?: Record<string, unknown>
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(code, {
    internalDetails: {
      ...internalDetails,
      originalError: error instanceof Error ? error.message : String(error),
    },
    cause: error,
  });
}

/**
 * Type guard to check if an error is an AppError
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
