import crypto from 'node:crypto';

/**
 * PKCE (Proof Key for Code Exchange) utilities for OAuth2 desktop authentication
 * Implements RFC 7636 with SHA256 code challenge method
 */

/**
 * Generate a cryptographically random code verifier (43-128 characters, base64url)
 * RFC 7636 recommends 43-character length for sufficient entropy
 */
export function generateCodeVerifier(): string {
  // Generate 32 random bytes and encode as base64url (results in 43 characters)
  const buffer = crypto.randomBytes(32);
  return buffer.toString('base64url');
}

/**
 * Generate code challenge from verifier using SHA256 method (RFC 7636)
 */
export function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(verifier);
  return hash.digest('base64url');
}

/**
 * Validate PKCE parameters format and length
 */
export function validatePKCEParams(params: {
  codeVerifier?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): { valid: boolean; error?: string } {
  const { codeVerifier, codeChallenge, codeChallengeMethod } = params;

  if (codeVerifier) {
    if (typeof codeVerifier !== 'string') {
      return { valid: false, error: 'Code verifier must be a string' };
    }
    if (codeVerifier.length < 43 || codeVerifier.length > 128) {
      return { valid: false, error: 'Code verifier must be 43-128 characters' };
    }
    // Base64url character set: A-Z, a-z, 0-9, -, _
    if (!/^[A-Za-z0-9_-]+$/.test(codeVerifier)) {
      return { valid: false, error: 'Code verifier contains invalid characters' };
    }
  }

  if (codeChallenge) {
    if (typeof codeChallenge !== 'string') {
      return { valid: false, error: 'Code challenge must be a string' };
    }
    if (codeChallenge.length !== 43) {
      return {
        valid: false,
        error: 'Code challenge must be exactly 43 characters (SHA256 base64url)',
      };
    }
    if (!/^[A-Za-z0-9_-]+$/.test(codeChallenge)) {
      return { valid: false, error: 'Code challenge contains invalid characters' };
    }
  }

  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    return { valid: false, error: 'Only S256 code challenge method is supported' };
  }

  return { valid: true };
}

/**
 * Generate a complete PKCE pair (verifier and challenge)
 */
export function generatePKCEPair(): {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} {
  // Some environments apply aggressive input sanitization. Avoid generating
  // code_challenge strings that accidentally match command keywords (e.g. "sh").
  const isSanitizerSafe = (s: string) =>
    !/(curl|wget|nc|netcat|bash|sh|cmd|powershell)/i.test(s) && !/[;&|`$(){}]/.test(s);

  let codeVerifier = '';
  let codeChallenge = '';
  // Try a few times to get a sanitizer-safe challenge (extremely likely on first try)
  for (let i = 0; i < 8; i++) {
    codeVerifier = generateCodeVerifier();
    codeChallenge = generateCodeChallenge(codeVerifier);
    if (isSanitizerSafe(codeChallenge)) break;
  }

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: 'S256' as const,
  };
}

/**
 * Validate that a code verifier matches a code challenge
 * Used for testing and validation purposes
 */
export function validateCodeChallenge(
  verifier: string,
  challenge: string,
  method: string = 'S256'
): boolean {
  if (method !== 'S256') {
    return false;
  }

  const computedChallenge = generateCodeChallenge(verifier);
  return computedChallenge === challenge;
}

/**
 * Generate cryptographically secure state parameter for CSRF protection
 */
export function generateState(): string {
  // Generate 24 random bytes and encode as hex (48 chars), avoiding special characters
  // Hex reduces the chance of aggressive sanitizers flagging the value as malicious
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Create authorization URL with PKCE parameters
 */
export function buildAuthorizationUrl(params: {
  baseUrl: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  desktopSessionId: string;
  scope?: string;
  returnTo?: string;
}): string {
  const { baseUrl, state, codeChallenge, codeChallengeMethod, desktopSessionId, scope, returnTo } =
    params;

  const url = new URL(`${baseUrl}/api/auth/microsoft/login`);
  url.searchParams.set('client_type', 'desktop');
  url.searchParams.set('desktop_session_id', desktopSessionId);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', codeChallengeMethod);

  if (scope) {
    url.searchParams.set('scope', scope);
  }

  if (returnTo) {
    url.searchParams.set('return_to', returnTo);
  }

  return url.toString();
}

/**
 * Parse authorization callback URL and extract parameters
 */
export function parseAuthorizationCallback(callbackUrl: string): {
  code?: string;
  state?: string;
  desktopSessionId?: string;
  error?: string;
  errorDescription?: string;
} | null {
  try {
    const url = new URL(callbackUrl);

    if (url.protocol !== 'notely:' || url.host !== 'auth' || url.pathname !== '/callback') {
      return null;
    }

    return {
      code: url.searchParams.get('code') || undefined,
      state: url.searchParams.get('state') || undefined,
      desktopSessionId: url.searchParams.get('desktop_session_id') || undefined,
      error: url.searchParams.get('error') || undefined,
      errorDescription: url.searchParams.get('error_description') || undefined,
    };
  } catch {
    return null;
  }
}
