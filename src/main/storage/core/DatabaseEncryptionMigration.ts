/**
 * DatabaseEncryptionMigration - Migrates unencrypted SQLite database to SQLCipher encrypted format
 *
 * Migration flow:
 * 1. Check if DB needs migration (exists, has content, not marked as encrypted)
 * 2. Open the unencrypted source database
 * 3. Create a new encrypted database with SQLCipher
 * 4. Use SQLite backup API to copy data
 * 5. Verify row counts match between source and destination
 * 6. Create backup of original database
 * 7. Atomically swap files (rename encrypted to original location)
 * 8. Set secure permissions on the encrypted database (0600)
 * 9. Write the encryption marker file
 * 10. Clean up temporary files
 */

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3-multiple-ciphers';

import { logger } from '../../logger';

import { getEncryptionKeyManager } from './EncryptionKeyManager';

/**
 * Marker file indicating the database has been encrypted
 */
const ENCRYPTION_MARKER_FILE = '.db-encryption-complete';

/**
 * Backup file name for the original unencrypted database
 */
const PRE_ENCRYPTION_BACKUP = 'notes.sqlite.pre-encryption-backup';

/**
 * Temporary file name for the encrypted database during migration
 */
const TEMP_ENCRYPTED_DB = 'notes.sqlite.encrypting';

/**
 * Result of migration attempt
 */
export interface MigrationResult {
  success: boolean;
  migrated: boolean;
  message: string;
  backupPath?: string;
  error?: string;
}

/**
 * Progress callback for migration
 */
export type MigrationProgressCallback = (progress: {
  stage: 'checking' | 'copying' | 'verifying' | 'swapping' | 'cleanup' | 'complete';
  percent: number;
  message: string;
}) => void;

/**
 * Check if a database needs encryption migration
 */
export function needsEncryptionMigration(baseDir: string): boolean {
  const dataDir = path.join(baseDir, 'data');
  const dbPath = path.join(dataDir, 'notes.sqlite');
  const markerPath = path.join(dataDir, ENCRYPTION_MARKER_FILE);

  // Check if database exists and has content
  if (!fs.existsSync(dbPath)) {
    return false;
  }

  const stats = fs.statSync(dbPath);
  if (stats.size === 0) {
    return false;
  }

  // Check if already marked as encrypted
  if (fs.existsSync(markerPath)) {
    return false;
  }

  return true;
}

/**
 * Migrate an unencrypted database to SQLCipher encrypted format
 */
export async function migrateToEncryptedDatabase(
  baseDir: string,
  onProgress?: MigrationProgressCallback
): Promise<MigrationResult> {
  const dataDir = path.join(baseDir, 'data');
  const dbPath = path.join(dataDir, 'notes.sqlite');
  const tempEncryptedPath = path.join(dataDir, TEMP_ENCRYPTED_DB);
  const backupPath = path.join(dataDir, PRE_ENCRYPTION_BACKUP);
  const markerPath = path.join(dataDir, ENCRYPTION_MARKER_FILE);

  const report = (
    stage: 'checking' | 'copying' | 'verifying' | 'swapping' | 'cleanup' | 'complete',
    percent: number,
    message: string
  ) => {
    logger.info(`DatabaseEncryptionMigration: [${stage}] ${message}`);
    if (onProgress) {
      onProgress({ stage, percent, message });
    }
  };

  try {
    // Stage 1: Check if migration is needed
    report('checking', 0, 'Checking if migration is needed...');

    if (!needsEncryptionMigration(baseDir)) {
      return {
        success: true,
        migrated: false,
        message: 'Database does not need migration (already encrypted or does not exist)',
      };
    }

    report('checking', 10, 'Migration required - database is unencrypted');

    // Get the encryption key
    const keyManager = getEncryptionKeyManager(baseDir);
    const sqlCipherKey = await keyManager.getSqlCipherKey();

    // Stage 2: Open source database and create encrypted destination
    report('copying', 20, 'Opening source database...');

    // Clean up any leftover temp file from previous failed migration
    if (fs.existsSync(tempEncryptedPath)) {
      fs.unlinkSync(tempEncryptedPath);
    }

    // Open the source (unencrypted) database
    const sourceDb = new Database(dbPath, { readonly: true });

    // Create and configure the encrypted destination database
    report('copying', 30, 'Creating encrypted database...');
    const destDb = new Database(tempEncryptedPath);

    // Apply encryption key to destination
    destDb.pragma(`key = ${sqlCipherKey}`);

    // Configure destination with same settings as source
    destDb.pragma('journal_mode = WAL');
    destDb.pragma('foreign_keys = ON');

    // Stage 3: Copy data using backup API
    report('copying', 40, 'Copying data to encrypted database...');

    // Use SQLite backup API for reliable data transfer
    await sourceDb.backup(tempEncryptedPath, {
      progress: ({ totalPages, remainingPages }) => {
        const percent = Math.round(40 + ((totalPages - remainingPages) / totalPages) * 30);
        report('copying', percent, `Copying... ${totalPages - remainingPages}/${totalPages} pages`);
        return 0; // Continue backup
      },
    });

    // Close and reopen the encrypted database to verify the backup
    destDb.close();
    const verifyDb = new Database(tempEncryptedPath);
    verifyDb.pragma(`key = ${sqlCipherKey}`);

    // Stage 4: Verify row counts
    report('verifying', 70, 'Verifying data integrity...');

    // Get all tables from source
    const tables = sourceDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    let verificationPassed = true;
    for (const table of tables) {
      const sourceCount = sourceDb
        .prepare(`SELECT COUNT(*) as count FROM "${table.name}"`)
        .get() as {
        count: number;
      };
      const destCount = verifyDb.prepare(`SELECT COUNT(*) as count FROM "${table.name}"`).get() as {
        count: number;
      };

      if (sourceCount.count !== destCount.count) {
        logger.error('DatabaseEncryptionMigration: Row count mismatch', {
          table: table.name,
          sourceCount: sourceCount.count,
          destCount: destCount.count,
        });
        verificationPassed = false;
        break;
      }
    }

    sourceDb.close();
    verifyDb.close();

    if (!verificationPassed) {
      // Clean up temp file on failure
      if (fs.existsSync(tempEncryptedPath)) {
        fs.unlinkSync(tempEncryptedPath);
      }
      return {
        success: false,
        migrated: false,
        message: 'Data verification failed - row counts do not match',
        error: 'Row count mismatch between source and encrypted database',
      };
    }

    report('verifying', 80, 'Data verification passed');

    // Stage 5: Swap files atomically
    report('swapping', 85, 'Creating backup of original database...');

    // Create backup of original
    fs.copyFileSync(dbPath, backupPath);
    logger.info('DatabaseEncryptionMigration: Created backup at %s', backupPath);

    // Also copy WAL and SHM files if they exist
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, `${backupPath}-wal`);
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, `${backupPath}-shm`);
    }

    report('swapping', 90, 'Replacing original with encrypted database...');

    // Remove WAL and SHM files from original (they're not compatible with encrypted DB)
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    if (fs.existsSync(shmPath)) {
      fs.unlinkSync(shmPath);
    }

    // Atomic swap - rename encrypted to original location
    fs.renameSync(tempEncryptedPath, dbPath);

    // Set secure permissions (owner read/write only)
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch (chmodError) {
      // Non-fatal on Windows
      logger.warn('DatabaseEncryptionMigration: Failed to set permissions', {
        error: chmodError instanceof Error ? chmodError.message : chmodError,
      });
    }

    // Stage 6: Write marker file
    report('cleanup', 95, 'Finalizing migration...');

    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        migratedAt: new Date().toISOString(),
        version: 1,
        cipher: 'sqlcipher',
      }),
      { mode: 0o600 }
    );

    // Clean up temp encrypted WAL/SHM if they exist
    const tempWalPath = `${tempEncryptedPath}-wal`;
    const tempShmPath = `${tempEncryptedPath}-shm`;
    if (fs.existsSync(tempWalPath)) {
      fs.unlinkSync(tempWalPath);
    }
    if (fs.existsSync(tempShmPath)) {
      fs.unlinkSync(tempShmPath);
    }

    report('complete', 100, 'Migration completed successfully');

    return {
      success: true,
      migrated: true,
      message: 'Database successfully encrypted',
      backupPath,
    };
  } catch (error) {
    logger.error('DatabaseEncryptionMigration: Migration failed', {
      error: error instanceof Error ? error.stack || error.message : error,
    });

    // Clean up temp file on failure
    if (fs.existsSync(tempEncryptedPath)) {
      try {
        fs.unlinkSync(tempEncryptedPath);
      } catch {
        // Ignore cleanup errors
      }
    }

    return {
      success: false,
      migrated: false,
      message: 'Migration failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Rollback encryption by restoring the backup
 */
export async function rollbackEncryption(baseDir: string): Promise<MigrationResult> {
  const dataDir = path.join(baseDir, 'data');
  const dbPath = path.join(dataDir, 'notes.sqlite');
  const backupPath = path.join(dataDir, PRE_ENCRYPTION_BACKUP);
  const markerPath = path.join(dataDir, ENCRYPTION_MARKER_FILE);

  try {
    // Check if backup exists
    if (!fs.existsSync(backupPath)) {
      return {
        success: false,
        migrated: false,
        message: 'No backup found to restore',
        error: `Backup file not found at ${backupPath}`,
      };
    }

    logger.info('DatabaseEncryptionMigration: Rolling back encryption...');

    // Remove current encrypted database
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }

    // Remove WAL/SHM files
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (fs.existsSync(walPath)) {
      fs.unlinkSync(walPath);
    }
    if (fs.existsSync(shmPath)) {
      fs.unlinkSync(shmPath);
    }

    // Restore from backup
    fs.copyFileSync(backupPath, dbPath);

    // Restore WAL/SHM if they exist in backup
    if (fs.existsSync(`${backupPath}-wal`)) {
      fs.copyFileSync(`${backupPath}-wal`, walPath);
    }
    if (fs.existsSync(`${backupPath}-shm`)) {
      fs.copyFileSync(`${backupPath}-shm`, shmPath);
    }

    // Remove marker file
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }

    logger.info('DatabaseEncryptionMigration: Rollback completed');

    return {
      success: true,
      migrated: false,
      message: 'Encryption rolled back successfully - database is now unencrypted',
    };
  } catch (error) {
    logger.error('DatabaseEncryptionMigration: Rollback failed', {
      error: error instanceof Error ? error.message : error,
    });

    return {
      success: false,
      migrated: false,
      message: 'Rollback failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Delete the pre-encryption backup (after user confirmation)
 */
export function deleteEncryptionBackup(baseDir: string): boolean {
  const dataDir = path.join(baseDir, 'data');
  const backupPath = path.join(dataDir, PRE_ENCRYPTION_BACKUP);

  try {
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);

      // Also delete backup WAL/SHM
      if (fs.existsSync(`${backupPath}-wal`)) {
        fs.unlinkSync(`${backupPath}-wal`);
      }
      if (fs.existsSync(`${backupPath}-shm`)) {
        fs.unlinkSync(`${backupPath}-shm`);
      }

      logger.info('DatabaseEncryptionMigration: Deleted backup at %s', backupPath);
      return true;
    }
    return false;
  } catch (error) {
    logger.error('DatabaseEncryptionMigration: Failed to delete backup', {
      error: error instanceof Error ? error.message : error,
    });
    return false;
  }
}

/**
 * Check if a pre-encryption backup exists
 */
export function hasEncryptionBackup(baseDir: string): boolean {
  const backupPath = path.join(baseDir, 'data', PRE_ENCRYPTION_BACKUP);
  return fs.existsSync(backupPath);
}
