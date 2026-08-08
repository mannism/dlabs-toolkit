/**
 * Public-surface smoke test for @diabolicallabs/secrets.
 * Verifies exports are present at the module level and one round-trip
 * works through the barrel import (not the internal module paths).
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSecretsVault, SecretsError } from './index.js';

describe('@diabolicallabs/secrets', () => {
  it('exports createSecretsVault as a function', () => {
    expect(typeof createSecretsVault).toBe('function');
  });

  it('exports SecretsError as a class', () => {
    expect(typeof SecretsError).toBe('function');
  });

  it('SecretsError can be instantiated with correct fields', () => {
    const err = new SecretsError({
      message: 'decryption failed',
      kind: 'decrypt_failed',
    });
    expect(err).toBeInstanceOf(SecretsError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SecretsError');
    expect(err.message).toBe('decryption failed');
    expect(err.kind).toBe('decrypt_failed');
  });

  it('createSecretsVault returns a SecretsVault that round-trips via the barrel export', () => {
    const masterKey = randomBytes(32).toString('hex');
    const vault = createSecretsVault({ masterKey });
    expect(typeof vault.encrypt).toBe('function');
    expect(typeof vault.decrypt).toBe('function');

    const ciphertext = vault.encrypt('hello world');
    expect(vault.decrypt(ciphertext)).toBe('hello world');
  });
});
