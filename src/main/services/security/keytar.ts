/**
 * Credential Storage Abstraction Layer
 *
 * Provides a unified interface for secure credential storage.
 * Uses Electron's safeStorage API with file-based blob storage.
 *
 * Migration: On first access, attempts to migrate any existing keytar entries
 * to safeStorage for seamless upgrade from older versions.
 */

import { logger } from '../../logger';

import { getSafeStorageBackend, type KeytarModule } from './safeStorageBackend';

// Re-export the interface for type compatibility
export type { KeytarModule };

let cachedModule: KeytarModule | null = null;
let migrationAttempted = false;

/**
 * Service name used in both keytar and safeStorage
 */
const SERVICE_NAME = 'com.notely.desktop';

/**
 * Known keytar accounts that may need migration.
 * Auth tokens use dynamic names (auth-<hash>-access/refresh) and are handled separately.
 */
const KNOWN_ACCOUNTS = ['database-encryption-key', 'database-encryption-key-temp'];

/**
 * Attempt to import the legacy keytar module
 * Returns null if keytar is not available
 */
async function tryImportKeytar(): Promise<{
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials?(service: string): Promise<Array<{ account: string; password: string }>>;
} | null> {
  try {
    // eslint-disable-next-line import/no-unresolved -- keytar is intentionally not installed; import fails and is caught
    const imported = await import('keytar');
    const keytarModule = (imported as { default?: unknown }).default ?? imported;
    return keytarModule as {
      getPassword(service: string, account: string): Promise<string | null>;
      setPassword(service: string, account: string, password: string): Promise<void>;
      deletePassword(service: string, account: string): Promise<boolean>;
      findCredentials?(service: string): Promise<Array<{ account: string; password: string }>>;
    };
  } catch {
    return null;
  }
}

/**
 * Migrate a single credential from keytar to safeStorage
 */
async function migrateCredential(
  keytar: Awaited<ReturnType<typeof tryImportKeytar>>,
  safeStorage: KeytarModule,
  account: string
): Promise<boolean> {
  if (!keytar) return false;

  try {
    const value = await keytar.getPassword(SERVICE_NAME, account);
    if (!value) {
      return false;
    }

    // Check if already exists in safeStorage
    const existing = await safeStorage.getPassword(SERVICE_NAME, account);
    if (existing) {
      // Already migrated, just clean up keytar
      await keytar.deletePassword(SERVICE_NAME, account).catch(() => {});
      return true;
    }

    // Migrate to safeStorage
    await safeStorage.setPassword(SERVICE_NAME, account, value);
    logger.info('keytar.ts: Migrated credential to safeStorage', { account });

    // Remove from keytar after successful migration
    await keytar.deletePassword(SERVICE_NAME, account).catch(() => {});
    logger.info('keytar.ts: Removed old keytar entry', { account });

    return true;
  } catch (error) {
    logger.warn('keytar.ts: Failed to migrate credential', {
      account,
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

/**
 * Attempt to migrate existing keytar entries to safeStorage.
 * This is a one-time, best-effort operation on first access.
 */
async function migrateFromKeytar(safeStorage: KeytarModule): Promise<void> {
  if (migrationAttempted) {
    return;
  }
  migrationAttempted = true;

  const keytar = await tryImportKeytar();
  if (!keytar) {
    logger.info('keytar.ts: Legacy keytar not available, no migration needed');
    return;
  }

  logger.info('keytar.ts: Attempting migration from keytar to safeStorage');

  let migratedCount = 0;

  // Migrate known static accounts
  for (const account of KNOWN_ACCOUNTS) {
    const migrated = await migrateCredential(keytar, safeStorage, account);
    if (migrated) migratedCount++;
  }

  // Try to find and migrate any auth tokens (pattern: auth-*-access, auth-*-refresh)
  if (typeof keytar.findCredentials === 'function') {
    try {
      const credentials = await keytar.findCredentials(SERVICE_NAME);
      for (const cred of credentials) {
        if (cred.account.startsWith('auth-')) {
          const migrated = await migrateCredential(keytar, safeStorage, cred.account);
          if (migrated) migratedCount++;
        }
      }
    } catch (error) {
      // findCredentials may not be supported on all platforms
      logger.debug('keytar.ts: Could not enumerate keytar credentials', {
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  if (migratedCount > 0) {
    logger.info('keytar.ts: Migration from keytar complete', { migratedCount });
  } else {
    logger.info('keytar.ts: No credentials found in keytar to migrate');
  }
}

/**
 * Get the credential storage module.
 * Uses safeStorage as the backend, with automatic migration from keytar on first access.
 *
 * @returns A KeytarModule-compatible interface for credential storage
 */
export async function getKeytar(): Promise<KeytarModule> {
  if (cachedModule) {
    return cachedModule;
  }

  const safeStorageBackend = getSafeStorageBackend();

  // Attempt migration from keytar (one-time, best-effort)
  await migrateFromKeytar(safeStorageBackend);

  cachedModule = safeStorageBackend;
  return cachedModule;
}

/**
 * Reset cached module and migration state (for testing)
 */
export function resetKeytar(): void {
  cachedModule = null;
  migrationAttempted = false;
}
