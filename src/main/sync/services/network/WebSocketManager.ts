/**
 * WebSocket Manager for Real-Time Sync Notifications
 *
 * Manages WebSocket connection to the ws-gateway service for receiving
 * real-time sync notifications when changes occur on other devices.
 *
 * Features:
 * - Sec-WebSocket-Protocol authentication (more secure than URL params)
 * - Exponential backoff reconnection (max 10 attempts)
 * - WebSocket-level ping/pong keepalive
 * - Connection state tracking
 * - Token refresh handling via AuthService events
 *
 * Date: 2025-11-13
 */

import { EventEmitter } from 'node:events';

import type { AuthService } from '../../../auth/AuthService';
import { logger } from '../../../logger';
import type { CertificatePinningService } from '../../../services/security';

import { createWebSocket, WebSocket } from './createWebSocket';
import type {
  ConnectionState,
  WebSocketConfig,
  SyncNotificationPayload,
  ServerMessage,
  StateChangeEvent,
  DisconnectEvent,
  ReconnectingEvent,
  ReconnectFailedEvent,
} from './types';

/**
 * WebSocket Manager Events:
 * - 'connected': Emitted when WebSocket connection is established
 * - 'disconnected': Emitted when WebSocket connection is closed (DisconnectEvent)
 * - 'sync:needed': Emitted when server notifies of pending changes (SyncNotificationPayload)
 * - 'error': Emitted on WebSocket errors (Error)
 * - 'state-changed': Emitted when connection state changes (StateChangeEvent)
 * - 'reconnecting': Emitted when attempting to reconnect (ReconnectingEvent)
 * - 'reconnect-failed': Emitted when max reconnect attempts reached (ReconnectFailedEvent)
 */
export class WebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private readonly maxReconnectDelay = 30000; // 30 seconds max
  private isPaused = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private currentUrl: string = '';
  private state: ConnectionState = 'disconnected';

  // Bound handlers for proper event listener removal
  private boundHandleTokenRefresh: () => void;
  private boundHandleLogout: () => Promise<void>;

  constructor(
    private config: WebSocketConfig,
    private authService: AuthService,
    private certificatePinningService?: CertificatePinningService
  ) {
    super();

    // Bind handlers for proper removal
    this.boundHandleTokenRefresh = this.handleTokenRefresh.bind(this);
    this.boundHandleLogout = this.disconnect.bind(this);

    // Listen for token refresh events from AuthService
    this.authService.on('token-refreshed', this.boundHandleTokenRefresh);
    this.authService.on('logout', this.boundHandleLogout);
  }

  /**
   * Get the current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Connect to the WebSocket server
   * @param wsUrl - WebSocket server URL (e.g., wss://ws.yourdomain.com)
   */
  async connect(wsUrl: string): Promise<void> {
    if (this.isPaused) {
      logger.debug('WebSocketManager: Connection paused, skipping connect');
      return;
    }

    if (this.state === 'connecting') {
      logger.debug('WebSocketManager: Already connecting, skipping');
      return;
    }

    this.currentUrl = wsUrl;
    this.setState('connecting');

    try {
      const token = await this.config.getAccessToken();
      const deviceId = this.config.getDeviceId();

      if (!token) {
        logger.warn('WebSocketManager: No access token available, cannot connect');
        this.setState('disconnected');
        return;
      }

      // Use Sec-WebSocket-Protocol header for auth (more secure than URL params)
      // Format: "Bearer.<base64url-token>.<deviceId>"
      // Must use base64url (not base64) because RFC 6455 subprotocol names are tokens
      // that cannot contain +, /, or = characters
      const authProtocol = `Bearer.${Buffer.from(token).toString('base64url')}.${deviceId}`;

      logger.info('WebSocketManager: Connecting to WebSocket server', {
        url: `${wsUrl}/ws`,
        deviceId: deviceId.substring(0, 8) + '...',
      });

      // Get TLS pinning options for secure WebSocket connections
      // Pass port to allow skipping pinning for dev/staging servers (non-443 ports)
      const wsUrlObj = new URL(wsUrl);
      const tlsOptions = this.certificatePinningService?.getWebSocketTLSOptions(
        wsUrlObj.hostname,
        wsUrlObj.port || undefined // Pass port (empty string becomes undefined for port 443)
      );

      // Pass TLS options to WebSocket constructor
      // Use createWebSocket factory which validates the ws module loaded correctly
      this.ws = createWebSocket(
        `${wsUrl}/ws`,
        [authProtocol],
        tlsOptions as unknown as WebSocket.ClientOptions | undefined
      );

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data: WebSocket.Data) => this.handleMessage(data));
      this.ws.on('close', (code: number, reason: Buffer) =>
        this.handleClose(code, reason.toString())
      );
      this.ws.on('error', (err: Error) => this.handleError(err));
      this.ws.on('pong', () => this.handlePong());
    } catch (error) {
      logger.error('WebSocketManager: Connection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.handleError(error as Error);
    }
  }

  /**
   * Pause the WebSocket connection (stops reconnection attempts)
   */
  pause(): void {
    logger.info('WebSocketManager: Pausing WebSocket');
    this.isPaused = true;
    this.clearReconnectTimer();
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close(1000, 'Paused');
    }
  }

  /**
   * Resume the WebSocket connection after being paused
   */
  resume(): void {
    logger.info('WebSocketManager: Resuming WebSocket');
    this.isPaused = false;
    this.reconnectAttempts = 0;
    if (this.currentUrl) {
      this.connect(this.currentUrl);
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  async disconnect(): Promise<void> {
    logger.info('WebSocketManager: Disconnecting');
    this.isPaused = true;
    this.clearReconnectTimer();
    this.stopPingInterval();

    if (this.ws) {
      this.ws.close(1000, 'Disconnect requested');
      this.ws = null;
    }

    this.setState('disconnected');
  }

  /**
   * Clean up all resources and event listeners
   */
  destroy(): void {
    this.disconnect();
    this.authService.removeListener('token-refreshed', this.boundHandleTokenRefresh);
    this.authService.removeListener('logout', this.boundHandleLogout);
    this.removeAllListeners();
    logger.info('WebSocketManager: Destroyed');
  }

  private setState(newState: ConnectionState): void {
    const oldState = this.state;
    this.state = newState;
    if (oldState !== newState) {
      const event: StateChangeEvent = { oldState, newState };
      this.emit('state-changed', event);
      logger.debug('WebSocketManager: State changed', event);
    }
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.setState('connected');
    this.startPingInterval();
    this.emit('connected');
    logger.info('WebSocketManager: Connected');
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString()) as ServerMessage;

      if (message.type === 'sync:needed') {
        const payload: SyncNotificationPayload = {
          reason: message.payload?.reason,
          timestamp: message.payload?.timestamp,
          source_device_id: message.payload?.originDeviceId,
        };
        logger.info('WebSocketManager: Received sync notification', payload);
        this.emit('sync:needed', payload);
      } else if (message.type === 'authenticated') {
        logger.info('WebSocketManager: Authentication confirmed');
      } else if (message.type === 'error') {
        logger.warn('WebSocketManager: Server error', { error: message.payload });
        if (message.payload?.code === 'AUTH_EXPIRED') {
          // Token expired, trigger refresh via reconnect with new token
          this.handleTokenRefresh();
        }
      } else if (message.type === 'pong') {
        // Server-level pong (different from WebSocket-level pong)
        logger.debug('WebSocketManager: Application-level pong received');
      }
    } catch (err) {
      logger.error('WebSocketManager: Failed to parse message', {
        error: err instanceof Error ? err.message : String(err),
        data: data.toString().substring(0, 100),
      });
    }
  }

  private handleClose(code: number, reason: string): void {
    this.stopPingInterval();
    this.setState('disconnected');

    const event: DisconnectEvent = { code, reason };
    this.emit('disconnected', event);
    logger.info('WebSocketManager: Disconnected', event);

    if (!this.isPaused) {
      this.scheduleReconnect();
    }
  }

  private handleError(error: Error): void {
    logger.error('WebSocketManager: Error', {
      error: error.message,
      stack: error.stack,
    });
    this.emit('error', error);
  }

  private handlePong(): void {
    // WebSocket-level pong received - connection is alive
    logger.debug('WebSocketManager: Pong received');
  }

  private handleTokenRefresh(): void {
    logger.info('WebSocketManager: Token refreshed, reconnecting');
    // Close current connection - handleClose will trigger reconnect
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'Token refresh');
    }
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    // Send WebSocket-level ping every 30 seconds
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
        logger.debug('WebSocketManager: Ping sent');
      }
    }, 30000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    // Check if we've exceeded max attempts
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.warn('WebSocketManager: Max reconnect attempts reached, giving up', {
        attempts: this.reconnectAttempts,
      });
      const event: ReconnectFailedEvent = { attempts: this.reconnectAttempts };
      this.emit('reconnect-failed', event);
      return;
    }

    this.setState('reconnecting');

    // Exponential backoff: 1s, 2s, 4s, 8s... max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    logger.info('WebSocketManager: Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delay,
      maxAttempts: this.maxReconnectAttempts,
    });

    const event: ReconnectingEvent = { attempt: this.reconnectAttempts, delay };
    this.emit('reconnecting', event);

    this.reconnectTimer = setTimeout(() => {
      this.connect(this.currentUrl);
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
