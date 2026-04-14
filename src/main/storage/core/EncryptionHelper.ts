/**
 * EncryptionHelper - Centralized encryption operations for sensitive data
 */

import crypto from 'node:crypto';

export type EncryptionResult = {
  cipher: Buffer;
  iv: Buffer; // 12-byte IV (DB columns still named *_nonce for compatibility)
  tag: Buffer;
};

export type DecryptionInput = {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
};

export class EncryptionHelper {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32; // 256 bits
  private static readonly IV_LENGTH = 12; // 96 bits (recommended for GCM)
  private static readonly TAG_LENGTH = 16; // 128 bits

  /**
   * Encrypt data using AES-256-GCM
   */
  encryptAesGcm(key: Buffer, data: string): EncryptionResult {
    if (key.length !== EncryptionHelper.KEY_LENGTH) {
      throw new Error(`Key must be ${EncryptionHelper.KEY_LENGTH} bytes long`);
    }

    const iv = crypto.randomBytes(EncryptionHelper.IV_LENGTH);
    const cipher = crypto.createCipheriv(EncryptionHelper.ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      cipher: encrypted,
      iv,
      tag,
    };
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  decryptAesGcm(key: Buffer, input: DecryptionInput): string {
    if (key.length !== EncryptionHelper.KEY_LENGTH) {
      throw new Error(`Key must be ${EncryptionHelper.KEY_LENGTH} bytes long`);
    }

    const decipher = crypto.createDecipheriv(EncryptionHelper.ALGORITHM, key, input.iv);
    decipher.setAuthTag(input.tag);

    let decrypted = decipher.update(input.cipher, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Legacy decrypt for v1 records created before IV-based implementation.
   * Uses deprecated createDecipher with AAD bound to stored nonce.
   */
  decryptAesGcmLegacyV1(key: Buffer, input: DecryptionInput): string {
    if (key.length !== EncryptionHelper.KEY_LENGTH) {
      throw new Error(`Key must be ${EncryptionHelper.KEY_LENGTH} bytes long`);
    }

    // Deprecated API path to maintain backward compatibility
    const decipher = crypto.createDecipher(EncryptionHelper.ALGORITHM, key);
    decipher.setAAD(input.iv);
    decipher.setAuthTag(input.tag);

    let decrypted = decipher.update(input.cipher, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Generate a secure hash for data integrity
   */
  generateHash(data: string, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
    return crypto.createHash(algorithm).update(data).digest('hex');
  }

  /**
   * Verify hash integrity
   */
  verifyHash(data: string, hash: string, algorithm: 'sha256' | 'sha512' = 'sha256'): boolean {
    const computedHash = this.generateHash(data, algorithm);
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(computedHash));
  }

  /**
   * Count words and characters in text (utility for transcriptions)
   */
  countWords(text: string): { chars: number; words: number } {
    const chars = text.length;
    const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
    return { chars, words };
  }

  /**
   * Generate a secure random ID
   */
  generateId(): string {
    return crypto.randomUUID();
  }

  /**
   * Generate a secure random key
   */
  generateKey(length: number = EncryptionHelper.KEY_LENGTH): Buffer {
    return crypto.randomBytes(length);
  }

  /**
   * Derive key from password using PBKDF2
   */
  deriveKeyFromPassword(
    password: string,
    salt: string | Buffer,
    iterations: number = 100000
  ): Buffer {
    const saltBuffer = typeof salt === 'string' ? Buffer.from(salt) : salt;
    return crypto.pbkdf2Sync(
      password,
      saltBuffer,
      iterations,
      EncryptionHelper.KEY_LENGTH,
      'sha512'
    );
  }

  /**
   * Generate a random salt for password derivation
   */
  generateSalt(length: number = 16): Buffer {
    return crypto.randomBytes(length);
  }

  /**
   * Secure comparison of two strings (timing attack resistant)
   */
  secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  /**
   * Generate HMAC for message authentication
   */
  generateHmac(key: Buffer, data: string, algorithm: 'sha256' | 'sha512' = 'sha256'): string {
    return crypto.createHmac(algorithm, key).update(data).digest('hex');
  }

  /**
   * Verify HMAC
   */
  verifyHmac(
    key: Buffer,
    data: string,
    hmac: string,
    algorithm: 'sha256' | 'sha512' = 'sha256'
  ): boolean {
    const computedHmac = this.generateHmac(key, data, algorithm);
    return this.secureCompare(hmac, computedHmac);
  }

  /**
   * Encrypt multiple fields in an object
   */
  async encryptFields(
    key: Buffer,
    data: Record<string, unknown>,
    fieldsToEncrypt: string[]
  ): Promise<Record<string, unknown>> {
    const result = { ...data };

    for (const field of fieldsToEncrypt) {
      if (field in result && typeof result[field] === 'string') {
        const encrypted = this.encryptAesGcm(key, result[field] as string);
        result[`${field}_cipher`] = encrypted.cipher;
        result[`${field}_nonce`] = encrypted.iv;
        result[`${field}_tag`] = encrypted.tag;
        delete result[field]; // Remove plaintext
      }
    }

    return result;
  }

  /**
   * Decrypt multiple fields in an object
   */
  async decryptFields(
    key: Buffer,
    data: Record<string, unknown>,
    fieldsToDecrypt: string[]
  ): Promise<Record<string, unknown>> {
    const result = { ...data };

    for (const field of fieldsToDecrypt) {
      const cipherField = `${field}_cipher`;
      const nonceField = `${field}_nonce`;
      const tagField = `${field}_tag`;

      if (cipherField in result && nonceField in result && tagField in result) {
        const decrypted = this.decryptAesGcm(key, {
          cipher: result[cipherField] as Buffer,
          iv: result[nonceField] as Buffer,
          tag: result[tagField] as Buffer,
        });

        result[field] = decrypted;
        delete result[cipherField];
        delete result[nonceField];
        delete result[tagField];
      }
    }

    return result;
  }
}
