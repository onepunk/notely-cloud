/**
 * Window API Type Definitions
 * Re-exports the actual API types from preload for TypeScript
 */

import type { Api as PreloadApi } from '../../preload/index';

// Use the actual API types from preload
type WindowAPI = PreloadApi;

declare global {
  interface Window {
    api: WindowAPI;
  }
}

export {};
