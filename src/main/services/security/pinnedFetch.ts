/**
 * Pinned Fetch Utility
 *
 * Provides a fetch function that uses Electron's net module, which respects
 * the session's certificate verification (including our SPKI pinning).
 *
 * Use this instead of native Node.js fetch() for all network requests
 * to Notely servers to ensure certificate pinning is enforced.
 */

import { net } from 'electron';

import { logger } from '../../logger';

/**
 * Fetch using Electron's net module with certificate pinning.
 *
 * This fetch respects the session's setCertificateVerifyProc, which
 * enforces our SPKI certificate pinning for Notely servers.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (method, headers, body, etc.)
 * @returns Promise<Response> - The fetch response
 */
export async function pinnedFetch(url: string | URL, options?: RequestInit): Promise<Response> {
  const urlString = url instanceof URL ? url.toString() : url;

  try {
    // Use Electron's net.fetch which respects session certificate verification
    const response = await net.fetch(urlString, options as Parameters<typeof net.fetch>[1]);
    return response;
  } catch (error) {
    // Log the error with context
    logger.error('pinnedFetch: Request failed', {
      url: urlString,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Check if Electron's net module is available.
 * This should always be true in the main process after app is ready.
 */
export function isNetAvailable(): boolean {
  try {
    return typeof net?.fetch === 'function';
  } catch {
    return false;
  }
}
