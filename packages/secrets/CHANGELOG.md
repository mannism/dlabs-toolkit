# @diabolicallabs/secrets

## 0.2.0

### Minor Changes

- 136601a: Raise `engines.node` to `>=22.12.0`; Node 20 (end of life April 2026) is no longer supported.

## 0.1.1

### Patch Changes

- 091ee06: New package: `@diabolicallabs/secrets` — AES-256-GCM encrypt/decrypt for secrets at rest, `node:crypto` only, zero runtime dependencies. Ships `createSecretsVault()`, `setSecretsLogger()`, and `SecretsError` (kind: `invalid_master_key` | `malformed_ciphertext` | `decrypt_failed`).
