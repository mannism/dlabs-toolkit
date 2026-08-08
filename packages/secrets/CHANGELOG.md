# @diabolicallabs/secrets

## 0.1.1

### Patch Changes

- 091ee06: New package: `@diabolicallabs/secrets` — AES-256-GCM encrypt/decrypt for secrets at rest, `node:crypto` only, zero runtime dependencies. Ships `createSecretsVault()`, `setSecretsLogger()`, and `SecretsError` (kind: `invalid_master_key` | `malformed_ciphertext` | `decrypt_failed`).
