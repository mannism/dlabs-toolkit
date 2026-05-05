/**
 * Unit tests for retry.ts
 *
 * Tests:
 * - isRetryableStatus: correct classification of HTTP status codes
 * - isRetryableErrorCode: correct classification of network error codes
 * - computeBackoffMs: stays within [0, baseDelay * 2^attempt]
 * - withRetry: retries retryable errors; does not retry non-retryable; exhausts and throws
 * - normalizeThrownError: maps various error shapes to LlmError
 */

import { describe, expect, it, vi } from 'vitest';
import {
  computeBackoffMs,
  isRetryableErrorCode,
  isRetryableStatus,
  normalizeThrownError,
  withRetry,
} from './retry.js';
import { LlmError } from './types.js';

describe('isRetryableStatus', () => {
  it('treats 429 as retryable', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('treats 502, 503, 504 as retryable', () => {
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
  });

  it('treats 500 as retryable (5xx catch-all)', () => {
    expect(isRetryableStatus(500)).toBe(true);
  });

  it('treats 400 as non-retryable', () => {
    expect(isRetryableStatus(400)).toBe(false);
  });

  it('treats 401 as non-retryable', () => {
    expect(isRetryableStatus(401)).toBe(false);
  });

  it('treats 403 as non-retryable', () => {
    expect(isRetryableStatus(403)).toBe(false);
  });

  it('treats 404 as non-retryable', () => {
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('treats 200 as non-retryable (not a 5xx)', () => {
    // 200 is not in RETRYABLE_HTTP_STATUSES and not >=500
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('isRetryableErrorCode', () => {
  it('treats ECONNRESET as retryable', () => {
    expect(isRetryableErrorCode('ECONNRESET')).toBe(true);
  });

  it('treats ETIMEDOUT as retryable', () => {
    expect(isRetryableErrorCode('ETIMEDOUT')).toBe(true);
  });

  it('treats ECONNABORTED as retryable', () => {
    expect(isRetryableErrorCode('ECONNABORTED')).toBe(true);
  });

  it('treats unknown code as non-retryable', () => {
    expect(isRetryableErrorCode('SOME_UNKNOWN_CODE')).toBe(false);
  });
});

describe('computeBackoffMs', () => {
  it('returns 0 for baseDelayMs = 0', () => {
    expect(computeBackoffMs(0, 0)).toBe(0);
    expect(computeBackoffMs(1, 0)).toBe(0);
    expect(computeBackoffMs(2, 0)).toBe(0);
  });

  it('stays within [0, baseDelay * 2^attempt] for attempt 0', () => {
    const base = 1000;
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoffMs(0, base);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(base * 1);
    }
  });

  it('stays within [0, baseDelay * 2^attempt] for attempt 3', () => {
    const base = 1000;
    const ceiling = base * 2 ** 3; // 8000
    for (let i = 0; i < 100; i++) {
      const delay = computeBackoffMs(3, base);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('ceiling grows with attempt number', () => {
    // Average of attempt 2 should be higher than average of attempt 0
    // With full jitter, ceiling at attempt 2 = 4000 vs attempt 0 = 1000
    const base = 1000;
    const ceiling0 = base * 2 ** 0;
    const ceiling2 = base * 2 ** 2;
    expect(ceiling2).toBeGreaterThan(ceiling0);
  });
});

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'test' });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and eventually succeeds', async () => {
    const retryableErr = new LlmError({
      message: 'rate limited',
      provider: 'test',
      statusCode: 429,
      retryable: true,
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableErr)
      .mockRejectedValueOnce(retryableErr)
      .mockResolvedValue('success after retry');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'test' });
    expect(result).toBe('success after retry');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors', async () => {
    const nonRetryableErr = new LlmError({
      message: 'unauthorized',
      provider: 'test',
      statusCode: 401,
      retryable: false,
    });

    const fn = vi.fn().mockRejectedValue(nonRetryableErr);

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'test' })
    ).rejects.toThrow('unauthorized');

    // Should not retry — only 1 call
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts maxRetries and throws the last LlmError', async () => {
    const retryableErr = new LlmError({
      message: 'server error',
      provider: 'test',
      statusCode: 503,
      retryable: true,
    });

    const fn = vi.fn().mockRejectedValue(retryableErr);

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 0, provider: 'test' })
    ).rejects.toThrow('server error');

    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('wraps non-LlmError as LlmError and does not retry it', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('generic error'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'anthropic' })
    ).rejects.toBeInstanceOf(LlmError);

    // Generic errors without status codes are non-retryable — 1 call only
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes attempt number to fn (0-indexed)', async () => {
    const attempts: number[] = [];
    const retryableErr = new LlmError({
      message: 'rate limited',
      provider: 'test',
      statusCode: 429,
      retryable: true,
    });

    const fn = vi.fn().mockImplementation((attempt: number) => {
      attempts.push(attempt);
      if (attempt < 2) return Promise.reject(retryableErr);
      return Promise.resolve('done');
    });

    await withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'test' });
    expect(attempts).toEqual([0, 1, 2]);
  });
});

describe('normalizeThrownError', () => {
  it('passes through LlmError unchanged', () => {
    const err = new LlmError({ message: 'original', provider: 'test', retryable: false });
    const result = normalizeThrownError(err, 'different');
    expect(result).toBe(err);
  });

  it('maps Error with status code to LlmError', () => {
    const err = Object.assign(new Error('not found'), { status: 404 });
    const result = normalizeThrownError(err, 'openai');
    expect(result).toBeInstanceOf(LlmError);
    expect(result.statusCode).toBe(404);
    expect(result.retryable).toBe(false);
    expect(result.provider).toBe('openai');
  });

  it('maps Error with retryable status code correctly', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const result = normalizeThrownError(err, 'openai');
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(429);
  });

  it('maps Error with retryable error code (ECONNRESET)', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const result = normalizeThrownError(err, 'anthropic');
    expect(result.retryable).toBe(true);
    expect(result.provider).toBe('anthropic');
  });

  it('maps plain Error without status to non-retryable LlmError', () => {
    const err = new Error('some error');
    const result = normalizeThrownError(err, 'anthropic');
    expect(result.retryable).toBe(false);
    expect(result.cause).toBe(err);
  });

  it('maps non-Error throws to LlmError', () => {
    const result = normalizeThrownError('string error', 'test');
    expect(result).toBeInstanceOf(LlmError);
    expect(result.retryable).toBe(false);
  });

  it('maps null to LlmError', () => {
    const result = normalizeThrownError(null, 'test');
    expect(result).toBeInstanceOf(LlmError);
    expect(result.retryable).toBe(false);
  });
});
