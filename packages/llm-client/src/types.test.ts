/**
 * Unit tests for types.ts — specifically LlmError, which has runtime behaviour.
 *
 * LlmMessage, LlmUsage, LlmResponse, etc. are pure interfaces with no runtime
 * behaviour to test — their correctness is enforced at compile time.
 */

import { describe, expect, it } from 'vitest';
import { LlmError } from './types.js';

describe('LlmError', () => {
  it('is an instance of Error', () => {
    const err = new LlmError({ message: 'test', provider: 'anthropic', retryable: false });
    expect(err).toBeInstanceOf(Error);
  });

  it('has name LlmError', () => {
    const err = new LlmError({ message: 'test', provider: 'openai', retryable: false });
    expect(err.name).toBe('LlmError');
  });

  it('stores provider, statusCode, retryable correctly', () => {
    const err = new LlmError({
      message: 'rate limited',
      provider: 'anthropic',
      statusCode: 429,
      retryable: true,
    });
    expect(err.provider).toBe('anthropic');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('rate limited');
  });

  it('statusCode is undefined when not provided', () => {
    const err = new LlmError({ message: 'network error', provider: 'openai', retryable: true });
    expect(err.statusCode).toBeUndefined();
  });

  it('stores cause', () => {
    const cause = new Error('root cause');
    const err = new LlmError({
      message: 'wrapped',
      provider: 'openai',
      retryable: false,
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it('retryable: false for auth errors', () => {
    const err = new LlmError({
      message: 'Unauthorized',
      provider: 'openai',
      statusCode: 401,
      retryable: false,
    });
    expect(err.retryable).toBe(false);
  });

  it('can be caught as instanceof LlmError after being thrown', () => {
    const err = new LlmError({ message: 'test', provider: 'test', retryable: false });
    let caught: unknown;
    try {
      throw err;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmError);
  });
});
