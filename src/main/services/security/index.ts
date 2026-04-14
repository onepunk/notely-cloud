/**
 * Security Module
 *
 * Provides certificate pinning, secure credential storage, and other security features
 * for the Notely desktop client.
 */

export { CertificatePinningService } from './CertificatePinningService';
export {
  getPinsForDomain,
  getPinConfigForDomain,
  requiresPinning,
  getAllConfiguredPins,
} from './PinConfiguration';
export { pinnedFetch, isNetAvailable } from './pinnedFetch';
export type {
  PinEntry,
  DomainPinConfig,
  PinningFailedEvent,
  PinningSuccessEvent,
  CertificatePinningServiceConfig,
  PinnedTLSOptions,
} from './types';

// Keystore (OS credential storage)
export {
  KeystoreService,
  KeystoreError,
  getKeystoreService,
  resetKeystoreService,
} from './KeystoreService';
export type { IKeystoreService, AuthTokens, KeystoreScope } from './KeystoreService';

// Password Protection (optional password-based encryption key protection)
export {
  PasswordProtectionService,
  PasswordProtectionError,
  getPasswordProtectionService,
  resetPasswordProtectionService,
} from './PasswordProtectionService';
export type {
  PasswordProtectionStatus,
  EncryptedKeyBlob,
  PasswordErrorCode,
} from './PasswordProtectionService';
