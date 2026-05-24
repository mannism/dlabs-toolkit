/**
 * Unit tests for @diabolicallabs/notifier-core types and error taxonomy.
 */

import { describe, expect, it } from 'vitest';
import {
  PlatformAuthError,
  PlatformError,
  PlatformNotFoundError,
  PlatformRateLimitError,
  PlatformUnavailableError,
  PlatformValidationError,
} from './types.js';

describe('PlatformError base class', () => {
  it('sets message, platform, and code', () => {
    const err = new PlatformError('something failed', 'slack', 'channel_not_found');
    expect(err.message).toBe('something failed');
    expect(err.platform).toBe('slack');
    expect(err.code).toBe('channel_not_found');
    expect(err.name).toBe('PlatformError');
  });

  it('extends Error', () => {
    const err = new PlatformError('msg', 'slack', 'code');
    expect(err).toBeInstanceOf(Error);
  });

  it('sets cause when provided', () => {
    const cause = new Error('original');
    const err = new PlatformError('wrapper', 'slack', 'code', cause);
    expect(err.cause).toBe(cause);
  });

  it('does not set cause when not provided', () => {
    const err = new PlatformError('msg', 'slack', 'code');
    // cause should be undefined when not provided
    expect(err.cause).toBeUndefined();
  });
});

describe('PlatformAuthError', () => {
  it('extends PlatformError', () => {
    const err = new PlatformAuthError('invalid token', 'telegram', '401');
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(PlatformAuthError);
    expect(err.name).toBe('PlatformAuthError');
  });

  it('carries platform and code', () => {
    const err = new PlatformAuthError('invalid_auth', 'slack', 'invalid_auth');
    expect(err.platform).toBe('slack');
    expect(err.code).toBe('invalid_auth');
  });
});

describe('PlatformNotFoundError', () => {
  it('extends PlatformError', () => {
    const err = new PlatformNotFoundError('chat not found', 'telegram', '400');
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(PlatformNotFoundError);
    expect(err.name).toBe('PlatformNotFoundError');
  });
});

describe('PlatformRateLimitError', () => {
  it('extends PlatformError', () => {
    const err = new PlatformRateLimitError('rate limited', 'slack', '429', 'exceeded', 1000);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(PlatformRateLimitError);
    expect(err.name).toBe('PlatformRateLimitError');
  });

  it('sets kind and retryAfterMs', () => {
    const err = new PlatformRateLimitError('rate limited', 'slack', '429', 'exceeded', 5000);
    expect(err.kind).toBe('exceeded');
    expect(err.retryAfterMs).toBe(5000);
  });

  it('supports kind: unavailable with null retryAfterMs', () => {
    const err = new PlatformRateLimitError(
      'redis down',
      'slack',
      'unavailable',
      'unavailable',
      null
    );
    expect(err.kind).toBe('unavailable');
    expect(err.retryAfterMs).toBeNull();
  });

  it('supports null retryAfterMs for exceeded kind too', () => {
    const err = new PlatformRateLimitError('rate limited', 'telegram', '429', 'exceeded', null);
    expect(err.retryAfterMs).toBeNull();
  });
});

describe('PlatformValidationError', () => {
  it('extends PlatformError', () => {
    const err = new PlatformValidationError('bad payload', 'telegram', 'bad_request');
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(PlatformValidationError);
    expect(err.name).toBe('PlatformValidationError');
  });
});

describe('PlatformUnavailableError', () => {
  it('extends PlatformError', () => {
    const err = new PlatformUnavailableError('server error', 'slack', '500');
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(PlatformUnavailableError);
    expect(err.name).toBe('PlatformUnavailableError');
  });
});

describe('error instanceof checks across the hierarchy', () => {
  it('all subclasses are instances of PlatformError', () => {
    const errors = [
      new PlatformAuthError('a', 'slack', 'c'),
      new PlatformNotFoundError('a', 'slack', 'c'),
      new PlatformRateLimitError('a', 'slack', 'c', 'exceeded', null),
      new PlatformValidationError('a', 'slack', 'c'),
      new PlatformUnavailableError('a', 'slack', 'c'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(PlatformError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('subclasses do not cross-match', () => {
    const authErr = new PlatformAuthError('a', 'slack', 'c');
    expect(authErr).not.toBeInstanceOf(PlatformNotFoundError);
    expect(authErr).not.toBeInstanceOf(PlatformRateLimitError);
    expect(authErr).not.toBeInstanceOf(PlatformValidationError);
    expect(authErr).not.toBeInstanceOf(PlatformUnavailableError);
  });
});
