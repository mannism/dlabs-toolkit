/**
 * Behavioral test suite for @diabolicallabs/secrets — one test per
 * Acceptance Criterion 1-5 (see brief-secrets-package.md), plus the
 * remaining structural-validation branches in vault.ts's malformed-
 * ciphertext boundary.
 */

import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretsVault, SecretsError, setSecretsLogger } from '../../index.js';

function randomMasterKey(): string {
  return randomBytes(32).toString('hex');
}

describe('createSecretsVault — AC1: invalid_master_key', () => {
  it('throws SecretsError(kind: invalid_master_key) for a missing/empty key', () => {
    expect(() => createSecretsVault({ masterKey: '' })).toThrow(SecretsError);
    try {
      createSecretsVault({ masterKey: '' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('invalid_master_key');
    }
  });

  it('throws SecretsError(kind: invalid_master_key) for the wrong length', () => {
    const tooShort = randomBytes(31).toString('hex'); // 62 hex chars, not 64
    try {
      createSecretsVault({ masterKey: tooShort });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('invalid_master_key');
    }
  });

  it('throws SecretsError(kind: invalid_master_key) for non-hex characters', () => {
    const notHex = `${randomBytes(31).toString('hex')}zz`; // 64 chars, trailing non-hex
    try {
      createSecretsVault({ masterKey: notHex });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('invalid_master_key');
    }
  });
});

describe('createSecretsVault — AC2: encrypt/decrypt round-trip', () => {
  const vault = createSecretsVault({ masterKey: randomMasterKey() });

  it('round-trips a normal string', () => {
    const plaintext = 'sk-live-abc123-super-secret-api-key';
    expect(vault.decrypt(vault.encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips a string containing unicode', () => {
    const plaintext = 'sk-live-🔐-秘密-Ключ-abc123';
    expect(vault.decrypt(vault.encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips the empty string', () => {
    expect(vault.decrypt(vault.encrypt(''))).toBe('');
  });
});

describe('createSecretsVault — AC3: wrong master key never silently succeeds', () => {
  it('throws SecretsError(kind: decrypt_failed) when decrypting with a different key', () => {
    const vaultA = createSecretsVault({ masterKey: randomMasterKey() });
    const vaultB = createSecretsVault({ masterKey: randomMasterKey() });

    const ciphertext = vaultA.encrypt('top secret payload');

    try {
      vaultB.decrypt(ciphertext);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('decrypt_failed');
    }
  });
});

describe('createSecretsVault — AC4: single-byte tamper is caught by the GCM auth tag', () => {
  it('throws SecretsError(kind: decrypt_failed) when a decoded ciphertext byte is flipped', () => {
    // Per the brief's caution: flip a byte of the *decoded* ciphertext, not
    // the base64 string — a string-level flip can decode to identical bytes
    // via padding aliasing, making the test pass for the wrong reason.
    const vault = createSecretsVault({ masterKey: randomMasterKey() });
    const ciphertextString = vault.encrypt('attack at dawn, repeat, attack at dawn');

    const segments = ciphertextString.split(':');
    expect(segments.length).toBe(4);
    const [keyVersion, ivB64, authTagB64, dataB64] = segments as [string, string, string, string];

    const dataBytes = Buffer.from(dataB64, 'base64');
    expect(dataBytes.length).toBeGreaterThan(0);
    const firstByte = dataBytes.at(0) ?? 0;
    dataBytes[0] = (firstByte ^ 0xff) & 0xff; // flip every bit of the first byte

    const tampered = [keyVersion, ivB64, authTagB64, dataBytes.toString('base64')].join(':');

    try {
      vault.decrypt(tampered);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('decrypt_failed');
    }
  });
});

describe('createSecretsVault — AC5: malformed ciphertext format', () => {
  const vault = createSecretsVault({ masterKey: randomMasterKey() });

  it('throws SecretsError(kind: malformed_ciphertext) for a plain string', () => {
    try {
      vault.decrypt('not-a-ciphertext-at-all');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('malformed_ciphertext');
    }
  });

  it('throws SecretsError(kind: malformed_ciphertext) for valid base64 with the wrong segment count', () => {
    const validB64 = Buffer.from('hello').toString('base64');
    try {
      vault.decrypt(`${validB64}:${validB64}`); // 2 segments, not 4
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('malformed_ciphertext');
    }
  });

  it('throws SecretsError(kind: malformed_ciphertext) for an unrecognized keyVersion prefix', () => {
    const ciphertextString = vault.encrypt('payload');
    const [, ivB64, authTagB64, dataB64] = ciphertextString.split(':') as [
      string,
      string,
      string,
      string,
    ];
    try {
      vault.decrypt(['9', ivB64, authTagB64, dataB64].join(':'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('malformed_ciphertext');
    }
  });

  it('throws SecretsError(kind: malformed_ciphertext) for a non-base64 segment', () => {
    const ciphertextString = vault.encrypt('payload');
    const [keyVersion, , authTagB64, dataB64] = ciphertextString.split(':') as [
      string,
      string,
      string,
      string,
    ];
    try {
      vault.decrypt([keyVersion, '!!!!', authTagB64, dataB64].join(':'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('malformed_ciphertext');
    }
  });

  it('throws SecretsError(kind: malformed_ciphertext) for a decoded IV of the wrong length', () => {
    const ciphertextString = vault.encrypt('payload');
    const [keyVersion, , authTagB64, dataB64] = ciphertextString.split(':') as [
      string,
      string,
      string,
      string,
    ];
    const shortIv = Buffer.alloc(11).toString('base64'); // 11 bytes, not 12
    try {
      vault.decrypt([keyVersion, shortIv, authTagB64, dataB64].join(':'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('malformed_ciphertext');
    }
  });

  it('throws SecretsError(kind: malformed_ciphertext) for a decoded auth tag of the wrong length', () => {
    const ciphertextString = vault.encrypt('payload');
    const [keyVersion, ivB64, , dataB64] = ciphertextString.split(':') as [
      string,
      string,
      string,
      string,
    ];
    const shortTag = Buffer.alloc(15).toString('base64'); // 15 bytes, not 16
    try {
      vault.decrypt([keyVersion, ivB64, shortTag, dataB64].join(':'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretsError);
      expect((err as SecretsError).kind).toBe('malformed_ciphertext');
    }
  });
});

describe('setSecretsLogger', () => {
  afterEach(() => {
    setSecretsLogger(null); // reset to default stdout-JSON logger
  });

  it('routes SECRETS_MALFORMED_CIPHERTEXT and SECRETS_DECRYPT_FAILED to a custom logger', () => {
    const warn = vi.fn();
    setSecretsLogger({ warn });

    const vaultA = createSecretsVault({ masterKey: randomMasterKey() });
    const vaultB = createSecretsVault({ masterKey: randomMasterKey() });

    expect(() => vaultA.decrypt('not-a-ciphertext')).toThrow(SecretsError);
    expect(warn).toHaveBeenCalledWith('SECRETS_MALFORMED_CIPHERTEXT', expect.any(Object));

    const ciphertext = vaultA.encrypt('payload');
    expect(() => vaultB.decrypt(ciphertext)).toThrow(SecretsError);
    expect(warn).toHaveBeenCalledWith('SECRETS_DECRYPT_FAILED', expect.any(Object));
  });

  it('a vault created before setSecretsLogger keeps using the module logger set at construction time', () => {
    // config.logger is undefined, so the vault falls back to getLogger() at
    // construction — setSecretsLogger after that point still applies,
    // because getLogger() reads the module-level activeLogger by reference
    // only once, at createSecretsVault() call time.
    const warn = vi.fn();
    const vault = createSecretsVault({ masterKey: randomMasterKey(), logger: { warn } });
    setSecretsLogger({ warn: vi.fn() }); // should NOT affect `vault` — it captured `warn` directly

    expect(() => vault.decrypt('not-a-ciphertext')).toThrow(SecretsError);
    expect(warn).toHaveBeenCalledWith('SECRETS_MALFORMED_CIPHERTEXT', expect.any(Object));
  });
});
