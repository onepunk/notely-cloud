# HeartbeatService

## Overview

The `HeartbeatService` manages periodic heartbeat requests to the license server for concurrent usage tracking. It ensures that desktop clients maintain an active session with the license server and handles scenarios where concurrent session limits are exceeded.

## Features

- **Periodic Heartbeats**: Sends heartbeat every 5 minutes while authenticated
- **Unique Client ID**: Generates and persists a unique client ID on first run
- **Session Tracking**: Creates new session token on each app startup
- **Retry Logic**: Exponential backoff retry strategy (1s, 2s, 4s)
- **Offline Mode**: Automatically falls back to offline mode when server is unreachable
- **Concurrent Limit Detection**: Detects and emits events when session limits are exceeded
- **Lifecycle Management**: Start, stop, pause, and resume capabilities
- **Comprehensive Logging**: Production-ready logging with sensitive data masking

## Usage

### Basic Setup

```typescript
import { HeartbeatService } from './services/heartbeat';
import { LicenseService } from './services/license';

// Initialize dependencies
const heartbeatService = new HeartbeatService({
  settings: settingsService,
  getAccessToken: async () => {
    return await settingsService.get('auth.accessToken');
  },
  getOrganizationId: async () => {
    // Extract from JWT or settings
    return await extractOrganizationId();
  },
  getApiUrl: async () => {
    const customUrl = await settingsService.get('server.apiUrl');
    return customUrl || DEFAULT_API_URL;
  },
  clientVersion: app.getVersion(), // Electron app version
});
```

### Starting the Service

```typescript
// Start heartbeat after successful license validation
licenseService.onChanged(async (license) => {
  if (license.status === 'active') {
    await heartbeatService.start();
  } else {
    heartbeatService.stop();
  }
});

// Or start manually after auth
async function onUserAuthenticated() {
  await heartbeatService.start();
}
```

### Stopping the Service

```typescript
// Stop on app close
app.on('before-quit', () => {
  heartbeatService.stop();
});

// Stop on logout
async function onUserLogout() {
  heartbeatService.stop();
}
```

### Network State Management

```typescript
// Pause when offline
app.on('offline', () => {
  heartbeatService.pause();
});

// Resume when online
app.on('online', () => {
  heartbeatService.resume();
});
```

## Events

The HeartbeatService emits several events that you can listen to:

### `heartbeat:success`

Emitted on successful heartbeat.

```typescript
heartbeatService.on('heartbeat:success', (data) => {
  console.log('Heartbeat successful:', {
    status: data.status, // 'active' | 'limit_exceeded'
    activeSessions: data.activeSessions,
    sessionLimit: data.sessionLimit,
  });
});
```

### `heartbeat:limit-exceeded`

Emitted when concurrent session limit is reached. This is when the UI should show a modal to the user.

```typescript
heartbeatService.on('heartbeat:limit-exceeded', (data) => {
  // Show modal to user
  showConcurrentLimitModal({
    activeSessions: data.activeSessions,
    sessionLimit: data.sessionLimit,
    warnings: data.warnings,
  });
});
```

**Example Modal Implementation:**

```typescript
function showConcurrentLimitModal(data) {
  dialog.showMessageBox({
    type: 'warning',
    title: 'Session Limit Reached',
    message: 'Concurrent Session Limit Exceeded',
    detail: `Your organization has ${data.activeSessions} active sessions, but the limit is ${data.sessionLimit}. Please close other sessions or contact your administrator.`,
    buttons: ['OK'],
  });
}
```

### `heartbeat:error`

Emitted when heartbeat fails after all retry attempts.

```typescript
heartbeatService.on('heartbeat:error', (data) => {
  logger.error('Heartbeat error:', data.error);
  // Optionally notify user or update UI state
});
```

### `heartbeat:offline`

Emitted when the service enters offline mode (either manually paused or after retries exhausted).

```typescript
heartbeatService.on('heartbeat:offline', () => {
  console.log('Heartbeat service is now offline');
  // Update UI to show offline status
});
```

### `heartbeat:online`

Emitted when the service resumes from offline mode.

```typescript
heartbeatService.on('heartbeat:online', () => {
  console.log('Heartbeat service is now online');
  // Update UI to show online status
});
```

## API Reference

### Constructor

```typescript
new HeartbeatService(deps: HeartbeatServiceDeps)
```

**Dependencies:**

```typescript
interface HeartbeatServiceDeps {
  settings: ISettingsService;
  getAccessToken: () => Promise<string | null>;
  getOrganizationId: () => Promise<string | null>;
  getApiUrl: () => Promise<string>;
  clientVersion: string;
}
```

### Methods

#### `start(): Promise<void>`

Starts the heartbeat service. Sends an immediate heartbeat and schedules periodic heartbeats every 5 minutes.

```typescript
await heartbeatService.start();
```

#### `stop(): void`

Stops the heartbeat service. Clears all timers and resets state.

```typescript
heartbeatService.stop();
```

#### `pause(): void`

Pauses heartbeat requests while keeping the service running. Useful when offline.

```typescript
heartbeatService.pause();
```

#### `resume(): void`

Resumes heartbeat requests. Sends an immediate heartbeat.

```typescript
heartbeatService.resume();
```

#### `getStatus(): object`

Returns current service status.

```typescript
const status = heartbeatService.getStatus();
// {
//   isRunning: true,
//   isPaused: false,
//   sessionToken: "abc12345...xyz9"
// }
```

## Server API Specification

### Endpoint

`POST /api/license/heartbeat`

### Authentication

Bearer token required in Authorization header.

### Rate Limit

20 requests per minute per client.

### Request Format

```json
{
  "clientId": "desktop-abc123",
  "sessionToken": "session-xyz789",
  "clientVersion": "1.0.0",
  "platform": "win32",
  "organizationId": "uuid"
}
```

### Response Format (Success)

```json
{
  "success": true,
  "data": {
    "status": "active",
    "activeSessions": 5,
    "sessionLimit": 10,
    "warnings": []
  }
}
```

### Response Format (Limit Exceeded)

```json
{
  "success": true,
  "data": {
    "status": "limit_exceeded",
    "activeSessions": 10,
    "sessionLimit": 10,
    "warnings": ["Concurrent session limit reached"]
  }
}
```

## Configuration

### Constants

These constants are defined in the service and can be adjusted if needed:

```typescript
const HEARTBEAT_INTERVAL_MS = 300000; // 5 minutes
const MAX_RETRY_ATTEMPTS = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const HEARTBEAT_TIMEOUT_MS = 10000; // 10 seconds
const CLIENT_ID_STORAGE_KEY = 'heartbeat.clientId';
```

### Storage

The service stores the following in settings:

- `heartbeat.clientId`: Persistent unique client identifier (generated once)

## Error Handling

### Retry Logic

The service implements exponential backoff retry:

1. First retry: 1 second delay
2. Second retry: 2 seconds delay
3. Third retry: 4 seconds delay

After 3 failed attempts, the service enters offline mode and emits `heartbeat:offline`.

### Network Errors

Network errors are handled gracefully:

- Timeouts after 10 seconds
- Falls back to offline mode on network issues
- Automatically resumes when `resume()` is called

### Authentication Errors

401 errors are logged but don't trigger immediate retries. The service will retry on the next scheduled heartbeat.

## Complete Integration Example

```typescript
import { app } from 'electron';
import { HeartbeatService } from './services/heartbeat';
import { LicenseService } from './services/license';

// Initialize services
const licenseService = new LicenseService({ settings: settingsService });
const heartbeatService = new HeartbeatService({
  settings: settingsService,
  getAccessToken: async () => settingsService.get('auth.accessToken'),
  getOrganizationId: async () => extractOrgIdFromToken(),
  getApiUrl: async () => {
    const customUrl = await settingsService.get('server.apiUrl');
    return customUrl || DEFAULT_API_URL;
  },
  clientVersion: app.getVersion(),
});

// Set up event listeners
heartbeatService.on('heartbeat:limit-exceeded', (data) => {
  mainWindow.webContents.send('show-concurrent-limit-modal', data);
});

heartbeatService.on('heartbeat:error', (data) => {
  logger.error('Heartbeat failed:', data);
});

heartbeatService.on('heartbeat:offline', () => {
  mainWindow.webContents.send('heartbeat-status-changed', { online: false });
});

heartbeatService.on('heartbeat:online', () => {
  mainWindow.webContents.send('heartbeat-status-changed', { online: true });
});

// Start heartbeat when license is active
licenseService.onChanged(async (license) => {
  if (license.status === 'active') {
    await heartbeatService.start();
  } else {
    heartbeatService.stop();
  }
});

// Handle network state
if (process.platform !== 'linux') {
  // Note: 'online' and 'offline' events may not work reliably on Linux
  app.on('online', () => heartbeatService.resume());
  app.on('offline', () => heartbeatService.pause());
}

// Stop on app close
app.on('before-quit', () => {
  heartbeatService.stop();
});
```

## Testing

### Manual Testing

```typescript
// Start service
await heartbeatService.start();

// Check status
console.log(heartbeatService.getStatus());

// Simulate offline
heartbeatService.pause();

// Simulate online
heartbeatService.resume();

// Stop service
heartbeatService.stop();
```

### Unit Testing

```typescript
import { HeartbeatService } from './HeartbeatService';

describe('HeartbeatService', () => {
  it('should generate unique client ID on first run', async () => {
    const service = new HeartbeatService(deps);
    await service.start();
    // Assert client ID is stored in settings
  });

  it('should emit limit-exceeded event when limit reached', async () => {
    // Mock fetch to return limit_exceeded response
    const service = new HeartbeatService(deps);
    const listener = jest.fn();
    service.on('heartbeat:limit-exceeded', listener);
    await service.start();
    // Assert listener was called
  });

  it('should retry with exponential backoff', async () => {
    // Mock fetch to fail
    const service = new HeartbeatService(deps);
    await service.start();
    // Assert retries happen with correct delays
  });
});
```

## Security Considerations

- **Token Masking**: All sensitive tokens are masked in logs
- **HTTPS Only**: Heartbeat endpoint should only be accessible via HTTPS in production
- **Rate Limiting**: Server enforces 20 requests/min per client
- **Authentication**: All requests require valid Bearer token
- **No Mock Data**: Service fails gracefully with proper error handling, no mock responses

## Troubleshooting

### Heartbeat Not Starting

Check that:

1. User is authenticated (`getAccessToken()` returns a token)
2. Organization ID is available
3. License status is 'active'
4. `start()` has been called

### Heartbeat Failing

Check logs for:

- Network connectivity issues
- Invalid authentication token
- Rate limiting (429 errors)
- Server errors (5xx)

### Events Not Firing

Ensure event listeners are registered before calling `start()`.
