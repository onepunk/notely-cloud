/**
 * Certificate Pinning Types
 *
 * Type definitions for the certificate pinning security module.
 */

import type tls from 'tls';

/**
 * A single certificate pin entry with metadata.
 */
export interface PinEntry {
  /** Base64-encoded SHA-256 hash of the SPKI (Subject Public Key Info) */
  pin: string;
  /** Human-readable description of the certificate/CA */
  description: string;
  /** Optional expiry date for rotation planning (ISO 8601 format) */
  expiresAt?: string;
  /** Whether this is a backup pin for rotation purposes */
  isBackup?: boolean;
}

/**
 * Pin configuration for a specific domain pattern.
 */
export interface DomainPinConfig {
  /** Domain pattern (supports wildcards like *.yourdomain.com) */
  domain: string;
  /** Array of valid pins for this domain */
  pins: PinEntry[];
}

/**
 * Event emitted when certificate pinning validation fails.
 */
export interface PinningFailedEvent {
  /** The hostname that failed validation */
  hostname: string;
  /** The actual pin extracted from the certificate */
  certPin: string;
  /** The expected pins that were configured */
  expectedPins: string[];
  /** Timestamp of the failure */
  timestamp: Date;
}

/**
 * Event emitted when certificate pinning validation succeeds.
 */
export interface PinningSuccessEvent {
  /** The hostname that was validated */
  hostname: string;
  /** The pin that matched */
  matchedPin: string;
  /** Timestamp of the success */
  timestamp: Date;
}

/**
 * Configuration options for the CertificatePinningService.
 */
export interface CertificatePinningServiceConfig {
  /** Custom pin configurations (overrides defaults) */
  customPins?: DomainPinConfig[];
  /** Enable verbose logging */
  verbose?: boolean;
}

/**
 * TLS options for WebSocket connections with certificate pinning.
 *
 * Note: The checkServerIdentity callback receives a tls.PeerCertificate which includes
 * the issuerCertificate chain for walking up to root CA during pin validation.
 */
export interface PinnedTLSOptions {
  /** Always reject unauthorized certificates */
  rejectUnauthorized: true;
  /** Custom server identity check function */
  checkServerIdentity: (host: string, cert: tls.PeerCertificate) => Error | undefined;
}
