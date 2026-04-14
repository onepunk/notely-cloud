import { toast } from 'sonner';

import { AppError, isAppError, wrapError, type ErrorCode } from '@common/errors';

/**
 * Extract a safe error message from an unknown error.
 * If the error is an AppError, returns the user-friendly message with code.
 * Otherwise, returns a generic fallback to avoid exposing internal details.
 */
export function toErrorMessage(error: unknown, fallback = 'Something went wrong'): string {
  // AppError - use the formatted user message
  if (isAppError(error)) {
    return error.toUserString();
  }

  // String error - only use if it looks user-friendly (short, no stack trace indicators)
  if (typeof error === 'string' && error.trim().length > 0 && error.length < 100) {
    // Check for signs of internal error details
    if (!error.includes('at ') && !error.includes('Error:') && !error.includes('/')) {
      return error;
    }
  }

  // Error object with message - check if it's safe
  const e = error as { code?: string; message?: string } & Record<string, unknown>;
  if (typeof e?.message === 'string' && e.message.trim().length > 0) {
    const msg = e.message;
    // Only use if it's short and doesn't look like a stack trace or internal error
    if (
      msg.length < 100 &&
      !msg.includes('at ') &&
      !msg.includes('SQLITE') &&
      !msg.includes('ECONNREFUSED')
    ) {
      return msg;
    }
  }

  return fallback;
}

/**
 * Report an error to the user via toast and log it.
 *
 * @param error - The error to report (AppError, Error, or unknown)
 * @param fallbackCode - Error code to use if error is not an AppError
 * @param context - Additional context for logging
 */
export function reportError(
  error: unknown,
  fallbackCode: ErrorCode = 'E8001',
  context?: Record<string, unknown>
): void {
  // Wrap in AppError if needed
  const appError = isAppError(error) ? error : wrapError(error, fallbackCode, context);

  // Log the full error details (not shown to user)
  try {
    window.api.log.error(`[${appError.code}] ${appError.userMessage}`, {
      ...appError.toLogObject(),
      context,
    });
  } catch {
    // Swallow logging bridge errors in renderer
    console.error('[Error Logging Failed]', appError.toLogObject());
  }

  // Show user-friendly toast with error code
  const toastMessage = appError.toUserString();

  if (appError.hint) {
    toast.error(toastMessage, {
      description: appError.hint,
    });
  } else {
    toast.error(toastMessage);
  }
}

/**
 * Report an error with a reference ID shown to the user.
 * Use this for critical errors where users might need to contact support.
 */
export function reportErrorWithRef(
  error: unknown,
  fallbackCode: ErrorCode = 'E8001',
  context?: Record<string, unknown>
): void {
  const appError = isAppError(error) ? error : wrapError(error, fallbackCode, context);

  // Log the full error details
  try {
    window.api.log.error(`[${appError.code}] ${appError.userMessage}`, {
      ...appError.toLogObject(),
      context,
    });
  } catch {
    console.error('[Error Logging Failed]', appError.toLogObject());
  }

  // Show toast with reference ID for support
  toast.error(appError.toUserString(), {
    description: appError.hint
      ? `${appError.hint}\nRef: ${appError.correlationId}`
      : `Ref: ${appError.correlationId}`,
  });
}

/**
 * Create and report an AppError in one call.
 * Convenient for catch blocks.
 */
export function throwAndReport(
  code: ErrorCode,
  options?: {
    userMessage?: string;
    internalDetails?: Record<string, unknown>;
    cause?: unknown;
  }
): never {
  const appError = new AppError(code, options);
  reportError(appError);
  throw appError;
}

/**
 * Format an error for inline display (banners, message bars, etc.)
 * Unlike reportError(), this does NOT show a toast - it returns the message.
 * Use this when you need to display an error inline in a component.
 *
 * @param error - The error to format
 * @param fallbackCode - Error code to use if error is not an AppError
 * @param context - Additional context for logging
 * @returns User-friendly error message with error code (e.g., "Failed to sync (E2001)")
 */
export function formatErrorForDisplay(
  error: unknown,
  fallbackCode: ErrorCode = 'E8001',
  context?: Record<string, unknown>
): string {
  // Wrap in AppError if needed
  const appError = isAppError(error) ? error : wrapError(error, fallbackCode, context);

  // Log the full error details (not shown to user)
  try {
    window.api.log.error(`[${appError.code}] ${appError.userMessage}`, {
      ...appError.toLogObject(),
      context,
    });
  } catch {
    // Swallow logging bridge errors in renderer
    console.error('[Error Logging Failed]', appError.toLogObject());
  }

  // Return user-friendly message with error code
  return appError.toUserString();
}

// Re-export for convenience
export { AppError, isAppError, wrapError, ERROR_CODES } from '@common/errors';
export type { ErrorCode } from '@common/errors';
