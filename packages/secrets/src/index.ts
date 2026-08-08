/**
 * @diabolicallabs/secrets
 *
 * AES-256-GCM encrypt/decrypt for secrets at rest. node:crypto only — zero
 * runtime dependencies. Ciphertext format: "1:" + iv.base64 + ":" +
 * authTag.base64 + ":" + ciphertext.base64 (the leading "1" is a
 * keyVersion prefix reserved for future key rotation).
 *
 * @example
 * import { createSecretsVault } from '@diabolicallabs/secrets';
 *
 * const vault = createSecretsVault({ masterKey: process.env.SECRETS_MASTER_KEY! });
 * const ciphertext = vault.encrypt('sk-live-...');
 * const plaintext = vault.decrypt(ciphertext); // throws SecretsError on wrong key or tampering
 */

// Logger
export { setSecretsLogger } from './logger.js';

// Types
export type { Logger, SecretsVault, SecretsVaultConfig } from './types.js';

// Error class — exported as value (not just type) for instanceof checks
export { SecretsError } from './types.js';

// Factory function
export { createSecretsVault } from './vault.js';
