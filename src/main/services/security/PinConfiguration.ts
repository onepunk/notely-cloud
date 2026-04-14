/**
 * Certificate Pin Configuration
 *
 * Contains SPKI (Subject Public Key Info) pins for Google Trust Services certificates.
 * CloudFlare's Universal SSL now uses Google Trust Services as the certificate authority,
 * so we pin GTS CA certificates instead of the legacy DigiCert certificates.
 *
 * These pins target Google Trust Services CA certificates which are stable and don't change
 * with individual domain certificate renewals.
 *
 * Pin Sources:
 * - https://pki.goog/repository/ (Google Trust Services root certificates)
 * - Extracted from api.yourdomain.com certificate chain
 */

import type { DomainPinConfig, PinEntry } from './types';

/**
 * Google Trust Services CA certificate pins (SHA-256 SPKI hashes)
 *
 * CloudFlare's Universal SSL certificates are now issued by Google Trust Services.
 * These pins cover the GTS intermediate and root CAs used in the certificate chain.
 */
const GOOGLE_TRUST_SERVICES_PINS: PinEntry[] = [
  // yourdomain.com leaf certificate SPKI - the actual certificate presented by CloudFlare
  // Note: This will change on certificate renewal (every ~90 days with Let's Encrypt/GTS)
  {
    pin: '5Dla+grwI6ajjVzTezQtSEHHcQ7k0moVFGv7w1h3qW4=',
    description: 'yourdomain.com leaf certificate',
  },
  // Google Trust Services WE1 intermediate - issues yourdomain.com certificates
  {
    pin: 'kIdp6NNEd8wsugYyyIYFsi1ylMCED3hZbSR8ZFsa/A4=',
    description: 'Google Trust Services WE1',
  },
  // GTS Root R4 (cross-signed by GlobalSign) - parent of WE1
  {
    pin: 'mEflZT5enoR1FuXLgYYGqnVEoZvmf9c2bVBpiOjYQ0c=',
    description: 'GTS Root R4 (cross-signed by GlobalSign)',
  },
  // GTS Root R1 - commonly used Google root, backup
  {
    pin: 'hxqRlPTu1bMS/0DITB1SSu0vd4u/8l8TjPgfaAp63Gc=',
    description: 'GTS Root R1',
    isBackup: true,
  },
  // GTS Root R2 - additional Google root, backup
  {
    pin: 'GRQX4AA3CjsDPM/yLfBKJg7/AYA7ELMSOT+VcU0SC+A=',
    description: 'GTS Root R2',
    isBackup: true,
  },
  // GlobalSign Root CA - cross-signs GTS roots, backup
  {
    pin: 'K87oWBWM9UZfyddvDfoxL+8lpNyoUB2ptGtn0fv6G2Q=',
    description: 'GlobalSign Root CA',
    isBackup: true,
  },
];

/**
 * Domain-specific pin configurations.
 *
 * Supports wildcard patterns for domain matching.
 * The *.yourdomain.com pattern matches all Notely subdomains.
 */
export const PIN_CONFIGURATIONS: DomainPinConfig[] = [
  {
    domain: '*.yourdomain.com',
    pins: GOOGLE_TRUST_SERVICES_PINS,
  },
  {
    domain: 'yourdomain.com',
    pins: GOOGLE_TRUST_SERVICES_PINS,
  },
];

/**
 * Get pin entries for a specific domain.
 *
 * @param hostname - The hostname to get pins for
 * @returns Array of pin strings, or empty array if no pins configured
 */
export function getPinsForDomain(hostname: string): string[] {
  for (const config of PIN_CONFIGURATIONS) {
    if (matchesDomain(hostname, config.domain)) {
      return config.pins.map((p) => p.pin);
    }
  }
  return [];
}

/**
 * Get full pin configuration for a domain.
 *
 * @param hostname - The hostname to get configuration for
 * @returns DomainPinConfig or undefined if not configured
 */
export function getPinConfigForDomain(hostname: string): DomainPinConfig | undefined {
  for (const config of PIN_CONFIGURATIONS) {
    if (matchesDomain(hostname, config.domain)) {
      return config;
    }
  }
  return undefined;
}

/**
 * Check if a hostname matches a domain pattern.
 *
 * @param hostname - The hostname to check (e.g., 'api.yourdomain.com')
 * @param pattern - The pattern to match against (e.g., '*.yourdomain.com')
 * @returns true if the hostname matches the pattern
 */
function matchesDomain(hostname: string, pattern: string): boolean {
  // Exact match
  if (hostname === pattern) {
    return true;
  }

  // Wildcard match
  if (pattern.startsWith('*.')) {
    const baseDomain = pattern.slice(2);
    // Match the base domain itself (e.g., yourdomain.com matches *.yourdomain.com)
    if (hostname === baseDomain) {
      return true;
    }
    // Match subdomains (e.g., api.yourdomain.com matches *.yourdomain.com)
    if (hostname.endsWith('.' + baseDomain)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a domain requires certificate pinning.
 *
 * @param hostname - The hostname to check
 * @returns true if pinning is configured for this domain
 */
export function requiresPinning(hostname: string): boolean {
  return getPinsForDomain(hostname).length > 0;
}

/**
 * Check if a URL requires certificate pinning.
 *
 * Pinning only applies to Notely Cloud: *.yourdomain.com on standard port (443).
 * Skip pinning for:
 * - Custom domains (self-hosted deployments)
 * - Non-standard ports (dev/staging environments)
 *
 * @param url - The full URL to check
 * @returns true if pinning should be applied
 */
export function requiresPinningForUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : parsed.protocol === 'https:' || parsed.protocol === 'wss:'
        ? 443
        : 80;

    // Only pin for standard HTTPS port (Notely Cloud)
    if (port !== 443) {
      return false;
    }

    // Only pin for yourdomain.com domains
    return requiresPinning(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Check if a hostname + port combination requires pinning.
 *
 * Pinning only applies to Notely Cloud: *.yourdomain.com on standard port (443).
 * Skip pinning for:
 * - Custom domains (self-hosted deployments)
 * - Non-standard ports (dev/staging environments)
 *
 * @param hostname - The hostname to check
 * @param port - The port number (defaults to 443 if not provided)
 * @returns true if pinning should be applied
 */
export function requiresPinningWithPort(hostname: string, port?: number | string): boolean {
  // Normalize port to number
  const portNum =
    port === undefined || port === '' ? 443 : typeof port === 'string' ? parseInt(port, 10) : port;

  // Only pin for standard HTTPS port
  if (portNum !== 443) {
    return false;
  }

  // Only pin for yourdomain.com domains
  return requiresPinning(hostname);
}

/**
 * Get all configured pins across all domains.
 * Useful for logging and debugging.
 */
export function getAllConfiguredPins(): { domain: string; pins: PinEntry[] }[] {
  return PIN_CONFIGURATIONS.map((config) => ({
    domain: config.domain,
    pins: config.pins,
  }));
}
