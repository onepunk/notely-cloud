/**
 * WebSocket Real-Time Sync Types
 *
 * Type definitions for WebSocket connection management and real-time sync notifications.
 *
 * Date: 2025-11-13
 */

/**
 * WebSocket connection state
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Configuration for WebSocketManager
 */
export interface WebSocketConfig {
  /** Function to get the current access token */
  getAccessToken: () => Promise<string>;
  /** Function to get the device ID */
  getDeviceId: () => string;
}

/**
 * Payload received when a sync notification arrives
 */
export interface SyncNotificationPayload {
  /** What triggered the sync notification */
  reason?: string;
  /** When the change occurred on the server */
  timestamp?: number;
  /** Device ID that originated the change */
  source_device_id?: string;
  /** Number of entities changed */
  changes_count?: number;
}

/**
 * Client-to-Server message types
 */
export interface ClientMessage {
  type: 'ping' | 'auth';
  payload?: {
    token?: string;
    deviceId?: string;
  };
}

/**
 * Server-to-Client message types
 */
export interface ServerMessage {
  type: 'pong' | 'sync:needed' | 'error' | 'authenticated';
  payload?: {
    reason?: string;
    timestamp?: number;
    originDeviceId?: string;
    code?: string;
    message?: string;
  };
}

/**
 * WebSocket state change event payload
 */
export interface StateChangeEvent {
  oldState: ConnectionState;
  newState: ConnectionState;
}

/**
 * WebSocket disconnection event payload
 */
export interface DisconnectEvent {
  code: number;
  reason: string;
}

/**
 * Reconnection event payload
 */
export interface ReconnectingEvent {
  attempt: number;
  delay: number;
}

/**
 * Reconnection failed event payload
 */
export interface ReconnectFailedEvent {
  attempts: number;
}
