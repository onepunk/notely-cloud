import { app, safeStorage } from 'electron';

// Set restrictive umask BEFORE any file operations
// This ensures all files created by the app have permissions 0600 (rw-------)
// and directories have permissions 0700 (rwx------)
process.umask(0o077);

import { AppManager } from './AppManager';
import { logger } from './logger';

let appManager: AppManager;

// Ensure single instance
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// On Linux, when DEBUG_DB is set and no keyring is available, allow safeStorage
// to use plaintext encryption so token storage works in dev/test environments.
if (process.platform === 'linux' && process.env.DEBUG_DB === 'true') {
  safeStorage.setUsePlainTextEncryption(true);
}

// Log application startup
logger.info(
  'App starting. packaged=%s, platform=%s, version=%s',
  app.isPackaged,
  process.platform,
  app.getVersion()
);

// Setup protocol handler for deep links
AppManager.setupProtocolHandler();

// Initialize application when ready
app.whenReady().then(async () => {
  try {
    // Create and initialize the application manager
    appManager = new AppManager({
      userDataPath: app.getPath('userData'),
      argv: process.argv,
    });

    await appManager.initialize();
  } catch (error) {
    logger.error('Failed to initialize application', {
      error: error instanceof Error ? error.message : error,
    });
    app.quit();
  }
});

// Standard app lifecycle handlers
app.on('window-all-closed', async () => {
  logger.info('App: window-all-closed event fired');

  if (appManager && !appManager.isShuttingDownStatus()) {
    await appManager.shutdown();
  }

  // On macOS, keep app running when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (appManager) {
    await appManager.handleActivate();
  }
});

// Network connectivity monitoring for auto-sync
// Note: 'online'/'offline' events are not available on app in main process.
// Network status should be monitored via renderer process or periodic checks.
// The AppManager handles network status internally via its own mechanisms.

// Graceful shutdown on process signals
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully');
  if (appManager && !appManager.isShuttingDownStatus()) {
    await appManager.shutdown();
    app.quit();
  }
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  if (appManager && !appManager.isShuttingDownStatus()) {
    await appManager.shutdown();
    app.quit();
  }
});

// Error handling for uncaught exceptions and rejections
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', {
    err: { message: err.message, stack: err.stack, name: err.name },
  });
});
process.on('unhandledRejection', (reason: unknown) => {
  const details: Record<string, unknown> = { reason };
  if (reason instanceof Error) {
    details.message = reason.message;
    details.stack = reason.stack;
    details.name = reason.name;
  }
  logger.error('unhandledRejection', details);
});
