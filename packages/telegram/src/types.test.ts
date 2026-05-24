/**
 * Unit tests for @diabolicallabs/telegram error taxonomy.
 */

import { PlatformError } from '@diabolicallabs/notifier-core';
import { describe, expect, it } from 'vitest';
import {
  TelegramAuthError,
  TelegramChatNotFoundError,
  TelegramError,
  TelegramRateLimitError,
  TelegramUnavailableError,
  TelegramValidationError,
} from './types.js';

describe('TelegramError (base)', () => {
  it('sets platform to telegram', () => {
    const err = new TelegramError('something failed', 'generic_error');
    expect(err.platform).toBe('telegram');
    expect(err.name).toBe('TelegramError');
  });

  it('extends PlatformError and Error', () => {
    const err = new TelegramError('msg', 'code');
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('TelegramAuthError', () => {
  it('sets platform to telegram', () => {
    const err = new TelegramAuthError('Unauthorized', '401');
    expect(err.platform).toBe('telegram');
    expect(err.name).toBe('TelegramAuthError');
  });
});

describe('TelegramChatNotFoundError', () => {
  it('sets platform to telegram', () => {
    const err = new TelegramChatNotFoundError('chat not found', '400');
    expect(err.platform).toBe('telegram');
    expect(err.name).toBe('TelegramChatNotFoundError');
  });
});

describe('TelegramRateLimitError', () => {
  it('sets kind and retryAfterMs', () => {
    const err = new TelegramRateLimitError('rate limited', '429', 'exceeded', 30_000);
    expect(err.kind).toBe('exceeded');
    expect(err.retryAfterMs).toBe(30_000);
    expect(err.platform).toBe('telegram');
    expect(err.name).toBe('TelegramRateLimitError');
  });

  it('supports null retryAfterMs', () => {
    const err = new TelegramRateLimitError('rate limited', '429', 'exceeded', null);
    expect(err.retryAfterMs).toBeNull();
  });
});

describe('TelegramValidationError', () => {
  it('sets platform to telegram', () => {
    const err = new TelegramValidationError('bad request', '400');
    expect(err.platform).toBe('telegram');
    expect(err.name).toBe('TelegramValidationError');
  });
});

describe('TelegramUnavailableError', () => {
  it('sets platform to telegram', () => {
    const err = new TelegramUnavailableError('server error', '500');
    expect(err.platform).toBe('telegram');
    expect(err.name).toBe('TelegramUnavailableError');
  });
});

describe('inheritance chain', () => {
  it('all error classes extend PlatformError and Error', () => {
    const errors = [
      new TelegramError('a', 'b'),
      new TelegramAuthError('a', 'b'),
      new TelegramChatNotFoundError('a', 'b'),
      new TelegramRateLimitError('a', 'b', 'exceeded', null),
      new TelegramValidationError('a', 'b'),
      new TelegramUnavailableError('a', 'b'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(PlatformError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
