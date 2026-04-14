/**
 * WebSocket Factory for Electron Main Process
 *
 * Validates the ws module loaded correctly and provides a factory function.
 * This catches build configuration issues at import time, not connection time.
 *
 * Background: The `ws` npm package uses conditional exports with a "browser"
 * condition that resolves to a stub that throws an error. If Vite's resolve
 * conditions are not configured correctly for Node.js, the browser stub gets
 * loaded instead of the actual WebSocket implementation.
 *
 * Date: 2025-12-17
 */
import WebSocket from 'ws';

// Validate at module load time - catches issues immediately at app startup
const isValidWsModule = ((): boolean => {
  try {
    // Node.js ws module has Server class and ping method on prototype
    // The browser stub is just a function that throws when called
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WS = WebSocket as any;
    return (
      typeof WebSocket === 'function' &&
      typeof WS.Server === 'function' &&
      typeof WebSocket.prototype.ping === 'function'
    );
  } catch {
    return false;
  }
})();

if (!isValidWsModule) {
  throw new Error(
    '[createWebSocket] CRITICAL: ws browser stub loaded instead of Node.js implementation.\n' +
      'Fix: Check vite.main.config.ts resolve.conditions is set to ["node", "import", "require", "default"]\n' +
      `Platform: ${process.platform}, Node: ${process.version}`
  );
}

/**
 * Creates a new WebSocket connection with validation.
 *
 * This is a thin wrapper around the ws library's WebSocket constructor
 * that ensures the correct module was loaded at build time.
 *
 * @param url - The WebSocket server URL (e.g., wss://ws.yourdomain.com/ws)
 * @param protocols - Optional subprotocol(s) for the connection
 * @param options - Optional WebSocket client options (headers, TLS, etc.)
 * @returns A new WebSocket instance
 */
export function createWebSocket(
  url: string,
  protocols?: string | string[],
  options?: WebSocket.ClientOptions
): WebSocket {
  return new WebSocket(url, protocols, options);
}

// Re-export WebSocket class for type usage and static property access
export { WebSocket };

// Re-export types for consumers
export type { ClientOptions } from 'ws';
