/**
 * Core type definitions for @diabolicallabs/secrets.
 * AES-256-GCM encrypt/decrypt for secrets at rest — node:crypto only, no
 * dependencies. Ciphertext format: "1:" + iv.base64 + ":" + authTag.base64
 * + ":" + ciphertext.base64. The leading "1" is a keyVersion prefix —
 * reserved for future key-rotation schemes, not used by v0.1.0 itself.
 */

/** Pluggable logger interface — matches the toolkit-wide convention
 * established in @diabolicallabs/llm-pricing, @diabolicallabs/llm-client,
 * @diabolicallabs/rate-limiter, and @diabolicallabs/notion.
 *
 * Stable event names:
 *   SECRETS_DECRYPT_FAILED      — decrypt() rejected (ERROR)
 *   SECRETS_MALFORMED_CIPHERTEXT — decrypt() given a non-conforming string (WARN)
 *
 * Never logs masterKey, plaintext, or ciphertext contents — only event
 * name and non-sensitive metadata (e.g. keyVersion).
 */
export interface Logger {
  warn: (event: string, data: Record<string, unknown>) => void;
}

/** Configuration for createSecretsVault(). masterKey must be a 64-character
 * hex string (32 bytes / 256 bits) — generate with
 * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
 */
export interface SecretsVaultConfig {
  masterKey: string; // 64-char hex string (32 bytes) — validated at construction
  logger?: Logger; // pluggable logger — matches toolkit-wide convention
}

/** The secrets vault interface — what consumers program against. Obtain an
 * instance via createSecretsVault(). encrypt()/decrypt() are synchronous —
 * node:crypto's GCM primitives do not require async I/O.
 */
export interface SecretsVault {
  // Encrypts plaintext, returning a self-contained ciphertext string
  // ("keyVersion:iv:authTag:ciphertext", all base64-encoded segments).
  encrypt(plaintext: string): string;

  // Decrypts a ciphertext string produced by encrypt(). Throws SecretsError
  // — never returns garbage or a partial result on failure.
  decrypt(ciphertext: string): string;
}

/** Thrown by createSecretsVault() and SecretsVault methods. Exported as a
 * value (not just a type) so callers can use `instanceof SecretsError`.
 *
 * kind discriminator:
 *   'invalid_master_key'    — masterKey missing, wrong length, or not hex.
 *                              Thrown by createSecretsVault() itself.
 *   'malformed_ciphertext'  — decrypt() input fails structural validation
 *                              (segment count, keyVersion, base64, IV/tag
 *                              length) BEFORE node:crypto is invoked.
 *   'decrypt_failed'        — node:crypto itself threw (wrong key, GCM
 *                              auth tag mismatch, tampered ciphertext).
 */
export class SecretsError extends Error {
  readonly kind: 'invalid_master_key' | 'decrypt_failed' | 'malformed_ciphertext';

  constructor(opts: {
    message: string;
    kind: 'invalid_master_key' | 'decrypt_failed' | 'malformed_ciphertext';
  }) {
    super(opts.message);
    this.name = 'SecretsError';
    this.kind = opts.kind;
  }
}
