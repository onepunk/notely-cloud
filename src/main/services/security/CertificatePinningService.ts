/**
 * Certificate Pinning Service
 *
 * Implements SPKI (Subject Public Key Info) certificate pinning for the Notely desktop client.
 * This prevents Man-in-the-Middle attacks by validating server certificates against known pins.
 *
 * Features:
 * - Electron session certificate verification
 * - Custom HTTPS agent for Node.js fetch with pinning
 * - WebSocket TLS options with pin verification
 * - Event emission for pin failures (for UI notifications)
 *
 * Since Notely uses CloudFlare proxy, we pin CloudFlare's CA certificates.
 */

import { createHash, X509Certificate } from 'crypto';
import { EventEmitter } from 'events';
import https from 'https';
import tls from 'tls';

import { app, session } from 'electron';

import { SECURITY_CONFIG } from '../../../common/config';
import { logger } from '../../logger';

import {
  getPinsForDomain,
  requiresPinning,
  requiresPinningWithPort,
  getAllConfiguredPins,
} from './PinConfiguration';
import type {
  CertificatePinningServiceConfig,
  PinningFailedEvent,
  PinningSuccessEvent,
  PinnedTLSOptions,
} from './types';

/**
 * CertificatePinningService manages certificate pinning for all network connections.
 *
 * Usage:
 * 1. Create instance early in app lifecycle
 * 2. Call initialize() before any network requests
 * 3. Use createPinnedHttpsAgent() for fetch calls
 * 4. Use getWebSocketTLSOptions() for WebSocket connections
 * 5. Listen to 'pinning-failed' events for UI notifications
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class CertificatePinningService extends EventEmitter {
  private enabled: boolean;
  private initialized = false;
  private config: CertificatePinningServiceConfig;

  constructor(config: CertificatePinningServiceConfig = {}) {
    super();
    this.config = config;
    this.enabled = this.shouldEnforcePinning();
  }

  /**
   * Determine if certificate pinning should be enforced.
   *
   * - Production (packaged app): ALWAYS enforced, cannot be disabled
   * - Development: Enabled by default, can be disabled via SECURITY_CONFIG
   */
  private shouldEnforcePinning(): boolean {
    // Production builds: ALWAYS enforce, no override possible
    if (app.isPackaged) {
      return true;
    }

    // Development: respect config setting (default is enabled)
    return !SECURITY_CONFIG.disableCertificatePinning;
  }

  /**
   * Check if certificate pinning is currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Initialize the certificate pinning service.
   * Must be called before any network requests are made.
   */
  initialize(): void {
    if (this.initialized) {
      logger.warn('CertificatePinningService: Already initialized');
      return;
    }

    if (!this.enabled) {
      logger.warn('CertificatePinningService: DISABLED (development mode override)');
      logger.warn(
        'CertificatePinningService: Set SECURITY_CONFIG.disableCertificatePinning = false to enable'
      );
      this.initialized = true;
      return;
    }

    // Log configured pins for debugging
    if (this.config.verbose) {
      const allPins = getAllConfiguredPins();
      logger.debug('CertificatePinningService: Configured pins', { pins: allPins });
    }

    // Configure Electron session certificate verification
    this.configureElectronSession();

    logger.debug('CertificatePinningService: Initialized and ENABLED');
    this.initialized = true;
  }

  /**
   * Configure Electron session for certificate verification.
   * This handles certificate verification for BrowserWindow and net module requests.
   */
  private configureElectronSession(): void {
    const ses = session.defaultSession;

    ses.setCertificateVerifyProc((request, callback) => {
      const { hostname, certificate, verificationResult, errorCode } = request;

      // First, check standard system verification passed
      if (verificationResult !== 'net::OK') {
        logger.error('CertificatePinningService: Standard verification failed', {
          hostname,
          result: verificationResult,
          errorCode,
        });
        callback(-2); // Reject
        return;
      }

      // Extract port from URL if available (Electron 28+ includes request.url)
      let port: number = 443;
      if ('url' in request && typeof request.url === 'string') {
        try {
          const parsed = new URL(request.url);
          port = parsed.port ? parseInt(parsed.port, 10) : 443;
        } catch {
          /* use default */
        }
      }

      // Check if this connection requires pinning (Notely Cloud only)
      // Pinning only applies to *.yourdomain.com on standard port 443
      if (!requiresPinningWithPort(hostname, port)) {
        if (this.config.verbose) {
          logger.debug('CertificatePinningService: Skipping pinning (not Notely Cloud)', {
            hostname,
            port,
          });
        }
        callback(0); // Allow without pinning
        return;
      }

      // Get configured pins for this domain
      const expectedPins = getPinsForDomain(hostname);

      // Extract SPKI pins from the entire certificate chain (leaf + issuers)
      const chainPins = this.extractChainPins(certificate);

      // Validate: at least one certificate in the chain must match a known pin
      const matchedPin = chainPins.find((pin) => expectedPins.includes(pin));
      const isValid = matchedPin !== undefined;

      if (!isValid) {
        logger.error('CertificatePinningService: Pin validation FAILED', {
          hostname,
          chainPins,
          expectedPins,
        });

        const event: PinningFailedEvent = {
          hostname,
          certPin: chainPins[0] || '',
          expectedPins,
          timestamp: new Date(),
        };
        this.emit('pinning-failed', event);

        callback(-2); // Reject connection
        return;
      }

      if (this.config.verbose) {
        logger.debug('CertificatePinningService: Pin validated', {
          hostname,
          matchedPin,
          chainPins,
        });
      }

      const event: PinningSuccessEvent = {
        hostname,
        matchedPin,
        timestamp: new Date(),
      };
      this.emit('pinning-success', event);

      callback(0); // Accept
    });
  }

  /**
   * Extract SPKI pins from the entire certificate chain.
   *
   * Walks through the leaf certificate and all issuer certificates,
   * extracting the SPKI pin from each. This allows pinning to any
   * certificate in the chain (leaf, intermediate CA, or root CA).
   *
   * @param cert - Electron Certificate object (leaf certificate)
   * @returns Array of Base64-encoded SHA-256 SPKI hashes for the chain
   */
  private extractChainPins(cert: Electron.Certificate): string[] {
    const pins: string[] = [];
    let currentCert: Electron.Certificate | undefined = cert;

    while (currentCert) {
      const pin = this.extractSPKIPinFromElectronCert(currentCert);
      if (pin) {
        pins.push(pin);
      }
      // Move to the issuer certificate (if available)
      currentCert = currentCert.issuerCert;
    }

    return pins;
  }

  /**
   * Extract SPKI pin (SHA-256 hash) from Electron certificate object.
   *
   * Electron's cert.data is PEM-encoded text, not DER binary.
   * We decode the PEM, parse the certificate, extract the SPKI (public key),
   * and hash it to produce a standard SPKI pin.
   *
   * @param cert - Electron Certificate object
   * @returns Base64-encoded SHA-256 hash of the SPKI
   */
  private extractSPKIPinFromElectronCert(cert: Electron.Certificate): string {
    try {
      // cert.data is PEM-encoded text (includes -----BEGIN/END CERTIFICATE----- headers)
      // X509Certificate can parse PEM directly
      const x509 = new X509Certificate(cert.data);

      // Export the public key in SPKI DER format
      const publicKeyDer = x509.publicKey.export({ type: 'spki', format: 'der' });

      // Hash the SPKI to produce the pin
      return createHash('sha256').update(publicKeyDer).digest('base64');
    } catch (error) {
      logger.error('CertificatePinningService: Failed to extract SPKI from certificate', {
        error: error instanceof Error ? error.message : String(error),
        fingerprint: cert.fingerprint,
      });
      // Return empty string which will fail pin validation
      return '';
    }
  }

  /**
   * Create a custom HTTPS agent with certificate pinning for Node.js fetch/http calls.
   *
   * @param hostname - The hostname to create the agent for
   * @param port - Optional port number (defaults to 443)
   * @returns https.Agent configured with certificate pinning
   */
  createPinnedHttpsAgent(hostname: string, port?: number | string): https.Agent {
    // Only apply pinning for Notely Cloud (*.yourdomain.com on port 443)
    if (!requiresPinningWithPort(hostname, port)) {
      if (this.config.verbose) {
        logger.debug('CertificatePinningService: Skipping HTTPS pinning (not Notely Cloud)', {
          hostname,
          port,
        });
      }
      return new https.Agent();
    }

    const expectedPins = getPinsForDomain(hostname);
    const enabled = this.enabled;

    return new https.Agent({
      // Custom server identity check that includes pin validation
      checkServerIdentity: (host: string, cert: tls.PeerCertificate): Error | undefined => {
        // First, perform standard hostname verification
        const standardError = tls.checkServerIdentity(host, cert);
        if (standardError) {
          return standardError;
        }

        // If pinning is disabled or no pins configured, allow
        if (!enabled || expectedPins.length === 0) {
          return undefined;
        }

        // Extract SPKI pin from the certificate
        const certPin = this.extractSPKIPinFromTLSCert(cert);

        // Validate against expected pins
        const isValid = expectedPins.some((pin) => pin === certPin);

        if (!isValid) {
          logger.error('CertificatePinningService: HTTPS Agent pin validation failed', {
            host,
            certPin,
            expectedPins,
          });

          const event: PinningFailedEvent = {
            hostname: host,
            certPin,
            expectedPins,
            timestamp: new Date(),
          };
          this.emit('pinning-failed', event);

          return new Error(`Certificate pin validation failed for ${host}`);
        }

        if (this.config.verbose) {
          logger.debug('CertificatePinningService: HTTPS Agent pin validated', { host, certPin });
        }

        return undefined;
      },
    });
  }

  /**
   * Get TLS options for WebSocket connections with certificate pinning.
   *
   * @param hostname - The hostname for the WebSocket connection
   * @param port - Optional port number (defaults to 443)
   * @returns TLS options object for WebSocket constructor
   */
  getWebSocketTLSOptions(hostname: string, port?: number | string): PinnedTLSOptions | undefined {
    if (!this.enabled) {
      return undefined;
    }

    // Only apply pinning for Notely Cloud (*.yourdomain.com on port 443)
    if (!requiresPinningWithPort(hostname, port)) {
      if (this.config.verbose) {
        logger.debug('CertificatePinningService: Skipping WebSocket pinning (not Notely Cloud)', {
          hostname,
          port,
        });
      }
      return undefined;
    }

    const expectedPins = getPinsForDomain(hostname);
    if (expectedPins.length === 0) {
      return undefined;
    }

    return {
      rejectUnauthorized: true,
      checkServerIdentity: (host: string, cert: tls.PeerCertificate): Error | undefined => {
        // Standard hostname verification is handled by the TLS layer
        // Here we just do pin validation

        // Extract SPKI pins from the entire certificate chain (leaf + issuers)
        // This matches the behavior of configureElectronSession()
        const chainPins = this.extractTLSChainPins(cert);

        // Validate: at least one certificate in the chain must match a known pin
        const matchedPin = chainPins.find((pin) => expectedPins.includes(pin));
        const isValid = matchedPin !== undefined;

        if (!isValid) {
          logger.error('CertificatePinningService: WebSocket pin validation failed', {
            host,
            chainPins,
            expectedPins,
          });

          const event: PinningFailedEvent = {
            hostname: host,
            certPin: chainPins[0] || '',
            expectedPins,
            timestamp: new Date(),
          };
          this.emit('pinning-failed', event);

          return new Error(`WebSocket certificate pin validation failed for ${host}`);
        }

        if (this.config.verbose) {
          logger.debug('CertificatePinningService: WebSocket pin validated', {
            host,
            matchedPin,
            chainPins,
          });
        }

        return undefined;
      },
    };
  }

  /**
   * Extract SPKI pin from a Node.js TLS PeerCertificate.
   *
   * Note: cert.pubkey is the raw public key bytes, but SPKI includes the
   * algorithm identifier. We need to parse the certificate and export
   * the public key in SPKI format to get the correct pin.
   *
   * @param cert - TLS PeerCertificate object
   * @returns Base64-encoded SHA-256 hash of the SPKI
   */
  private extractSPKIPinFromTLSCert(cert: tls.PeerCertificate): string {
    // Try to parse the raw certificate and extract SPKI properly
    if (cert.raw) {
      try {
        const x509 = new X509Certificate(cert.raw);
        const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' });
        return createHash('sha256').update(spkiDer).digest('base64');
      } catch {
        // Fall through to fallback
      }
    }

    // Fallback: hash the raw pubkey (note: this gives a different hash than SPKI)
    if (cert.pubkey) {
      logger.warn('CertificatePinningService: Using raw pubkey hash (may not match SPKI pins)');
      return createHash('sha256').update(cert.pubkey).digest('base64');
    }

    // Should not happen with valid certificates
    logger.warn('CertificatePinningService: Certificate missing pubkey and raw data');
    return '';
  }

  /**
   * Extract SPKI pins from the entire TLS certificate chain.
   *
   * Walks through the leaf certificate and all issuer certificates,
   * extracting the SPKI pin from each. This allows pinning to any
   * certificate in the chain (leaf, intermediate CA, or root CA).
   *
   * Note: The checkServerIdentity callback receives a DetailedPeerCertificate
   * at runtime (which includes issuerCertificate), even though the type
   * definition is PeerCertificate. We use type assertion to access this.
   *
   * @param cert - TLS PeerCertificate object (leaf certificate)
   * @returns Array of Base64-encoded SHA-256 SPKI hashes for the chain
   */
  private extractTLSChainPins(cert: tls.PeerCertificate): string[] {
    const pins: string[] = [];
    // Cast to DetailedPeerCertificate to access issuerCertificate chain
    let currentCert: tls.DetailedPeerCertificate | undefined = cert as tls.DetailedPeerCertificate;

    while (currentCert) {
      const pin = this.extractSPKIPinFromTLSCert(currentCert);
      if (pin) {
        pins.push(pin);
      }

      // Move to the issuer certificate (if available)
      const issuer = currentCert.issuerCertificate;

      // Avoid infinite loop for self-signed certificates (issuer === self)
      if (!issuer || issuer === currentCert) {
        break;
      }

      currentCert = issuer;
    }

    return pins;
  }

  /**
   * Validate a certificate pin manually.
   * Useful for testing or custom validation scenarios.
   *
   * @param certPin - The pin extracted from a certificate
   * @param hostname - The hostname to validate against
   * @returns true if the pin is valid for the hostname
   */
  validatePin(certPin: string, hostname: string): boolean {
    if (!this.enabled) {
      return true;
    }

    const expectedPins = getPinsForDomain(hostname);
    if (expectedPins.length === 0) {
      return true;
    }

    return expectedPins.some((pin) => pin === certPin);
  }

  /**
   * Get status information for debugging.
   */
  getStatus(): {
    enabled: boolean;
    initialized: boolean;
    isPackaged: boolean;
    configDisabled: boolean;
  } {
    return {
      enabled: this.enabled,
      initialized: this.initialized,
      isPackaged: app.isPackaged,
      configDisabled: SECURITY_CONFIG.disableCertificatePinning,
    };
  }
}

// Type declarations for events
export interface CertificatePinningServiceEvents {
  'pinning-failed': (event: PinningFailedEvent) => void;
  'pinning-success': (event: PinningSuccessEvent) => void;
}

// Extend EventEmitter interface for type safety
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/no-unsafe-declaration-merging
export interface CertificatePinningService {
  on<K extends keyof CertificatePinningServiceEvents>(
    event: K,
    listener: CertificatePinningServiceEvents[K]
  ): this;
  emit<K extends keyof CertificatePinningServiceEvents>(
    event: K,
    ...args: Parameters<CertificatePinningServiceEvents[K]>
  ): boolean;
}
