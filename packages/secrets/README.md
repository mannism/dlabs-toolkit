# @diabolicallabs/secrets

AES-256-GCM encrypt/decrypt for secrets at rest. `node:crypto` only — zero runtime dependencies. © Diabolical Labs

## Install

```bash
pnpm add @diabolicallabs/secrets
```

## Usage

```typescript
import { createSecretsVault, SecretsError } from '@diabolicallabs/secrets';

// masterKey is a 64-character hex string (32 bytes / 256 bits), read from
// an env var. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
const vault = createSecretsVault({ masterKey: process.env['SECRETS_MASTER_KEY']! });

const ciphertext = vault.encrypt('sk-live-abc123-provider-api-key');
// "1:base64iv:base64authTag:base64ciphertext" — store this string in your DB

try {
  const plaintext = vault.decrypt(ciphertext);
} catch (err) {
  if (err instanceof SecretsError) {
    // err.kind: 'invalid_master_key' | 'malformed_ciphertext' | 'decrypt_failed'
  }
}
```

`createSecretsVault()` throws `SecretsError(kind: 'invalid_master_key')` immediately if `masterKey` is missing, the wrong length, or not valid hex — fail fast at startup, not on the first encrypt/decrypt call.

## API

### `createSecretsVault(config): SecretsVault`

| Config field | Type | Default | Description |
|---|---|---|---|
| `masterKey` | `string` | required | 64-character hex string (32 bytes / 256 bits). Validated at construction. |
| `logger` | `Logger` | stdout JSON | Pluggable structured logger |

### `SecretsVault` interface

| Method | Return | Description |
|---|---|---|
| `encrypt(plaintext)` | `string` | Returns a self-contained ciphertext string. Never throws under normal use. |
| `decrypt(ciphertext)` | `string` | Returns the original plaintext. Throws `SecretsError` on any failure — never returns garbage. |

### `SecretsError`

```typescript
class SecretsError extends Error {
  readonly kind: 'invalid_master_key' | 'malformed_ciphertext' | 'decrypt_failed';
}
```

| `kind` | Thrown when |
|---|---|
| `invalid_master_key` | `masterKey` is missing, the wrong length, or not valid hex — thrown by `createSecretsVault()` itself |
| `malformed_ciphertext` | `decrypt()` input fails structural validation (segment count, `keyVersion`, base64 shape, decoded IV/auth-tag length) — before `node:crypto` is ever invoked |
| `decrypt_failed` | `node:crypto` itself rejected the ciphertext — wrong master key, or a tampered/truncated ciphertext failing GCM auth-tag verification |

### `setSecretsLogger(logger: Logger | null): void`

Override the module-level default logger used by vaults constructed without their own `config.logger`. Pass `null` to reset to the default. Default logger writes structured JSON to stdout and never logs `masterKey`, plaintext, or ciphertext contents — only the event name and non-sensitive metadata (e.g. a failure reason string).

## Implementation notes

**Why AES-256-GCM.** GCM is an authenticated encryption mode: alongside the ciphertext it produces an authentication tag that proves the ciphertext was produced with this exact key and has not been altered. A non-authenticated mode (e.g. AES-CBC without a separate HMAC) will happily "decrypt" tampered or wrong-key ciphertext into garbage bytes with no error — silently corrupting whatever the caller stores. GCM's auth-tag check turns that failure mode into a thrown exception (`SecretsError(kind: 'decrypt_failed')`) instead.

**Why the `keyVersion` prefix, with only one version.** The ciphertext format reserves its first segment for a key-version tag (`"1"` today) even though v0.1.0 supports exactly one master key and no rotation mechanism. This is deliberate future-proofing of the *format*, not the rotation logic itself (out of scope for v0.1.0 — see the package's `manifest.yaml`): a future v2 that adds key rotation can add a `"2"` prefix and dispatch on it, without having to migrate or reformat every ciphertext already stored by v1 callers. The `keyVersion` is also bound as GCM additional authenticated data (AAD) on both encrypt and decrypt, so an attacker with database write access cannot relabel a v1 ciphertext as v2 (or vice versa) — the auth tag would fail to verify.

**Why the auth tag matters (not just present in the output).** It is not enough for the ciphertext format to *include* a tag-shaped segment — `decrypt()` must actually call `setAuthTag()` and let `node:crypto` verify it before returning plaintext. This package's test suite (`src/__tests__/unit/vault.test.ts`) includes a dedicated tamper test: it decodes a valid ciphertext's data segment to raw bytes, flips a single bit, re-encodes, and asserts `decrypt()` throws `kind: 'decrypt_failed'`. Flipping a *base64 string* character instead of the *decoded bytes* is a known trap here — base64 padding can alias, so two different strings can decode to identical bytes, making a naive tamper test pass for the wrong reason.

**Consumer-owned storage.** This package is encrypt/decrypt only. It has no opinion on how you store the resulting ciphertext string — a `TEXT` column, a JSONB blob, a secrets manager entry. Store the whole `"keyVersion:iv:authTag:ciphertext"` string as-is; do not split it apart for storage.

### `await import()` for `tsx`-runtime consumers

Like the rest of the `@diabolicallabs/*` scope, this package is **ESM-only** (`exports` has no `require` condition). A static top-level `import { createSecretsVault } from '@diabolicallabs/secrets'` will crash a `tsx`-run process (e.g. Railway workers started via `tsx src/worker.ts`) at boot with `ERR_PACKAGE_PATH_NOT_EXPORTED` if anything upstream in the module graph is loaded in CJS mode. Use a dynamic import instead:

```typescript
const { createSecretsVault } = await import('@diabolicallabs/secrets');
```

This mirrors the pattern already established for `@diabolicallabs/agent-sdk` in `brand-compliance-saas/src/lib/spend/instrument.ts` — see that file's header comment for the full ESM/tsx gotcha writeup. If your consumer runs under a native ESM entrypoint (Next.js route handlers, `node --experimental-strip-types`, a bundler-built output), a normal static import works fine; the dynamic-import requirement is specific to `tsx`-run CJS-mode processes.
