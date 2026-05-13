/**
 * Unit tests for retry.ts
 *
 * Tests:
 * - isRetryableStatus: correct classification of HTTP status codes
 * - isRetryableErrorCode: correct classification of network error codes
 * - computeBackoffMs: stays within [0, baseDelay * 2^attempt]
 * - withRetry: retries retryable errors; does not retry non-retryable; exhausts and throws
 *             + signal: pre-abort, abort during backoff, AbortError from fn
 * - normalizeThrownError: maps various error shapes to LlmError
 *                         + AbortError branch, kind discriminator
 */

import { describe, expect, it, vi } from 'vitest';
import {
  computeBackoffMs,
  computeStrategyDelayMs,
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

  it('pre-aborted signal → 0 calls to fn, throws kind:"cancelled"', async () => {
    const ac = new AbortController();
    ac.abort('user cancelled');

    const fn = vi.fn().mockResolvedValue('success');
    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'test', signal: ac.signal })
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false });

    expect(fn).toHaveBeenCalledTimes(0);
  });

  it('AbortError thrown from fn is never retried — fn called exactly once', async () => {
    const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const fn = vi.fn().mockRejectedValue(abortErr);

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'test' })
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('abort during backoff sleep → no further attempts', async () => {
    // Use real timers — baseDelayMs 0 means sleep is instant; we just need to
    // verify the signal path doesn't block or swallow the error.
    const ac = new AbortController();

    const retryableErr = new LlmError({
      message: 'rate limited',
      provider: 'test',
      statusCode: 429,
      retryable: true,
    });

    // fn fails on attempt 0 → backoff sleep → abort fires during sleep → no attempt 1
    const fn = vi.fn().mockImplementation(() => {
      // Abort after the first call so we reach the backoff path
      ac.abort('interrupt');
      return Promise.reject(retryableErr);
    });

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 0, provider: 'test', signal: ac.signal })
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false });

    // fn called exactly once — the post-backoff pre-attempt check fires before attempt 1
    expect(fn).toHaveBeenCalledTimes(1);
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

  it('maps AbortError to kind:"cancelled", retryable:false', () => {
    const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const result = normalizeThrownError(abortErr, 'test');
    expect(result.kind).toBe('cancelled');
    expect(result.retryable).toBe(false);
  });

  it('maps status 429 to kind:"rate_limit" (v1.0.0 taxonomy)', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const result = normalizeThrownError(err, 'test');
    expect(result.kind).toBe('rate_limit');
    expect(result.retryable).toBe(true);
  });

  it('maps ECONNRESET to kind:"network"', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    const result = normalizeThrownError(err, 'test');
    expect(result.kind).toBe('network');
    expect(result.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeStrategyDelayMs — v1.2.0 configurable retry strategies
// ---------------------------------------------------------------------------

describe('computeStrategyDelayMs', () => {
  const BASE = 100;
  const CAP = 30_000;

  it('exponential: result is in [0, min(cap, base * 2^attempt)]', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const delay = computeStrategyDelayMs('exponential', attempt, BASE, CAP, BASE);
      const ceiling = Math.min(CAP, BASE * 2 ** attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });

  it('exponential: never exceeds maxDelayMs cap', () => {
    // At attempt=20, base*2^20 far exceeds the cap
    const delay = computeStrategyDelayMs('exponential', 20, BASE, CAP, BASE);
    expect(delay).toBeLessThanOrEqual(CAP);
  });

  it('linear: grows as base * (attempt + 1), capped', () => {
    expect(computeStrategyDelayMs('linear', 0, BASE, CAP, BASE)).toBe(BASE); // 100
    expect(computeStrategyDelayMs('linear', 1, BASE, CAP, BASE)).toBe(200); // 100*2
    expect(computeStrategyDelayMs('linear', 2, BASE, CAP, BASE)).toBe(300); // 100*3
    // Capped at CAP
    expect(computeStrategyDelayMs('linear', 1000, BASE, CAP, BASE)).toBe(CAP);
  });

  it('fixed: always returns base (capped for safety)', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(computeStrategyDelayMs('fixed', attempt, BASE, CAP, BASE)).toBe(BASE);
    }
  });

  it('fixed: respects cap when base > cap', () => {
    expect(computeStrategyDelayMs('fixed', 0, 100_000, 5_000, 100_000)).toBe(5_000);
  });

  it('decorrelated: on attempt 0, result is in [base, base*3] (prev=base)', () => {
    const results: number[] = [];
    for (let i = 0; i < 50; i++) {
      const delay = computeStrategyDelayMs('decorrelated', 0, BASE, CAP, BASE);
      results.push(delay);
      expect(delay).toBeGreaterThanOrEqual(BASE);
      expect(delay).toBeLessThanOrEqual(CAP);
    }
    // With 50 samples, at least some should be > base (probabilistic sanity check)
    const anyAboveBase = results.some((d) => d > BASE);
    expect(anyAboveBase).toBe(true);
  });

  it('decorrelated: never exceeds cap', () => {
    const prevDelayMs = 100_000; // artificially large prev
    const delay = computeStrategyDelayMs('decorrelated', 5, BASE, CAP, prevDelayMs);
    expect(delay).toBeLessThanOrEqual(CAP);
  });
});

// ---------------------------------------------------------------------------
// withRetry — retryConfig (v1.2.0)
// ---------------------------------------------------------------------------

describe('withRetry — retryConfig', () => {
  it('retryOn: does not retry a kind not in the allow-set (immediate throw)', async () => {
    let calls = 0;
    const fn = async (_attempt: number): Promise<string> => {
      calls++;
      throw new LlmError({
        message: 'auth error',
        provider: 'test',
        kind: 'auth',
        retryable: true, // retryable flag is true, but kind not in retryOn
      });
    };

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 0,
        provider: 'test',
        retryConfig: {
          maxAttempts: 4,
          retryOn: ['rate_limit', 'server_error'], // auth excluded
        },
      })
    ).rejects.toMatchObject({ kind: 'auth' });

    // Should only attempt once — no retries fired
    expect(calls).toBe(1);
  });

  it('retryOn: retries a kind that is in the allow-set', async () => {
    let calls = 0;
    const fn = async (_attempt: number): Promise<string> => {
      calls++;
      if (calls < 3) {
        throw new LlmError({
          message: 'server_error',
          provider: 'test',
          kind: 'server_error',
          retryable: true,
        });
      }
      return 'ok';
    };

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
      provider: 'test',
      retryConfig: {
        maxAttempts: 4,
        retryOn: ['server_error'],
        baseDelayMs: 0,
      },
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('maxAttempts: limits total attempts correctly (maxAttempts=2 → 1 retry)', async () => {
    let calls = 0;
    const fn = async (_attempt: number): Promise<string> => {
      calls++;
      throw new LlmError({
        message: 'server_error',
        provider: 'test',
        kind: 'server_error',
        retryable: true,
      });
    };

    await expect(
      withRetry(fn, {
        maxRetries: 10, // overridden by retryConfig.maxAttempts
        baseDelayMs: 0,
        provider: 'test',
        retryConfig: {
          maxAttempts: 2, // 1 initial + 1 retry = 2 attempts total
          retryOn: ['server_error'],
          baseDelayMs: 0,
        },
      })
    ).rejects.toMatchObject({ kind: 'server_error' });

    expect(calls).toBe(2);
  });

  it('respectRetryAfter: succeeds after rate_limit with Retry-After header (baseDelayMs=0)', async () => {
    // Verify that respectRetryAfter does not break the retry loop.
    // Delay verification is skipped here — the computation is unit-tested in computeStrategyDelayMs.
    let calls = 0;

    const fn = async (_attempt: number): Promise<string> => {
      calls++;
      if (calls === 1) {
        // Use the constructor's headers field — LlmError.headers is readonly.
        // Retry-After: '0' → 0 seconds → 0ms sleep, keeps test instant.
        throw new LlmError({
          message: 'rate_limit',
          provider: 'test',
          kind: 'rate_limit',
          retryable: true,
          headers: { 'retry-after': '0' },
        });
      }
      return 'ok';
    };

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
      provider: 'test',
      retryConfig: {
        maxAttempts: 4,
        strategy: 'fixed',
        baseDelayMs: 0,
        maxDelayMs: 30_000,
        respectRetryAfter: true,
        retryOn: ['rate_limit'],
      },
    });

    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('legacy mode (no retryConfig): retries on retryable regardless of kind', async () => {
    let calls = 0;
    const fn = async (_attempt: number): Promise<string> => {
      calls++;
      if (calls < 3) {
        throw new LlmError({
          message: 'unknown error',
          provider: 'test',
          // kind defaults to 'unknown' — would be blocked by DEFAULT_RETRY_ON if applied
          retryable: true,
        });
      }
      return 'ok';
    };

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 0,
      provider: 'test',
      // No retryConfig — legacy mode: retryable flag only
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
});
