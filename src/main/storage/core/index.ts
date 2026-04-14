/**
 * Core infrastructure exports
 */

export { DatabaseManager } from './DatabaseManager';
export type { DatabaseManagerOptions } from './DatabaseManager';
export { TransactionManager } from './TransactionManager';
export { EncryptionHelper } from './EncryptionHelper';
export {
  EncryptionKeyManager,
  EncryptionKeyError,
  getEncryptionKeyManager,
  createEncryptionKeyManager,
  resetEncryptionKeyManager,
} from './EncryptionKeyManager';
export type { IEncryptionKeyManager } from './EncryptionKeyManager';
export {
  needsEncryptionMigration,
  migrateToEncryptedDatabase,
  rollbackEncryption,
  deleteEncryptionBackup,
  hasEncryptionBackup,
} from './DatabaseEncryptionMigration';
export type { MigrationResult, MigrationProgressCallback } from './DatabaseEncryptionMigration';

export type { TransactionOptions } from './TransactionManager';
export type { EncryptionResult, DecryptionInput } from './EncryptionHelper';
