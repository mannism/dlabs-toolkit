/**
 * AES-256-GCM encrypt/decrypt for @diabolicallabs/secrets.
 *
 * Ciphertext format: "1:" + iv.base64 + ":" + authTag.base64 + ":" + ciphertext.base64
 * The leading "1" is a keyVersion prefix — reserved for future key-rotation
 * schemes; only version "1" exists in v0.1.0. It is also bound as GCM
 * additional authenticated data (AAD), so a ciphertext cannot be relabeled
 * under a different keyVersion without failing tag verification.
 *
 * node:crypto only — no dependencies.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getLogger } from './logger.js';
import { SecretsError, type SecretsVault, type SecretsVaultConfig } from './types.js';

const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;
const KEY_VERSION = '1';
const IV_LENGTH = 12; // 96-bit IV — GCM-recommended length
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag — GCM default

// Structural base64 check: alphabet + padding shape only (length%4 handled
// by the caller). Not a canonical validator — sufficient to reject
// non-base64 input before it reaches node:crypto.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function isValidBase64(segment: string): boolean {
  return segment.length % 4 === 0 && BASE64_RE.test(segment);
}

/**
 * createSecretsVault(config) — validates masterKey (bare regex, no Zod: a
 * format-constrained config string read from the deploying app's own env
 * var, not an API payload — see the toolkit's agent-sdk UUID-guard
 * precedent) and returns an encrypt/decrypt pair closed over the derived
 * key buffer.
 *
 * @example
 * import { createSecretsVault } from '@diabolicallabs/secrets';
 *
 * const vault = createSecretsVault({ masterKey: process.env.SECRETS_MASTER_KEY! });
 * const ciphertext = vault.encrypt('sk-live-...');
 * const plaintext = vault.decrypt(ciphertext);
 */
export function createSecretsVault(config: SecretsVaultConfig): SecretsVault {
  if (!MASTER_KEY_RE.test(config.masterKey)) {
    throw new SecretsError({
      message: 'masterKey must be a 64-character hex string (32 bytes / 256 bits)',
      kind: 'invalid_master_key',
    });
  }

  const masterKeyBuffer = Buffer.from(config.masterKey, 'hex');
  const logger = config.logger ?? getLogger();

  function throwMalformed(reason: string): never {
    logger.warn('SECRETS_MALFORMED_CIPHERTEXT', { reason });
    throw new SecretsError({ message: reason, kind: 'malformed_ciphertext' });
  }

  function encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', masterKeyBuffer, iv);
    cipher.setAAD(Buffer.from(KEY_VERSION, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [
      KEY_VERSION,
      iv.toString('base64'),
      authTag.toString('base64'),
      ciphertext.toString('base64'),
    ].join(':');
  }

  function decrypt(ciphertextString: string): string {
    const segments = ciphertextString.split(':');
    const [keyVersion, ivB64, authTagB64, ciphertextB64] = segments;

    if (
      segments.length !== 4 ||
      keyVersion === undefined ||
      ivB64 === undefined ||
      authTagB64 === undefined ||
      ciphertextB64 === undefined
    ) {
      throwMalformed(`expected 4 colon-separated segments, got ${segments.length}`);
    }

    if (keyVersion !== KEY_VERSION) {
      throwMalformed(`unrecognized keyVersion prefix: "${keyVersion}"`);
    }
    if (!isValidBase64(ivB64) || !isValidBase64(authTagB64) || !isValidBase64(ciphertextB64)) {
      throwMalformed('one or more segments are not valid base64');
    }

    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(authTagB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    if (iv.length !== IV_LENGTH) {
      throwMalformed(`decoded IV must be ${IV_LENGTH} bytes, got ${iv.length}`);
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throwMalformed(`decoded auth tag must be ${AUTH_TAG_LENGTH} bytes, got ${authTag.length}`);
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', masterKeyBuffer, iv);
      decipher.setAAD(Buffer.from(keyVersion, 'utf8'));
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (err) {
      logger.warn('SECRETS_DECRYPT_FAILED', {
        reason: err instanceof Error ? err.message : 'unknown',
      });
      throw new SecretsError({
        message: 'decryption failed — wrong master key or tampered ciphertext',
        kind: 'decrypt_failed',
      });
    }
  }

  return { encrypt, decrypt };
}
