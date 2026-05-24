/**
 * Unit tests for retryWithJitter.
 *
 * Covers:
 *  - Happy path: resolves on first try
 *  - isRetryable: false short-circuit (throws immediately, no retry)
 *  - Retry exhaustion: throws last error after maxRetries attempts
 *  - onRetry callback called with correct attempt/delayMs
 *  - Passes errors that are retryable through the full retry loop
 *  - computeJitter: output is within the expected range
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeJitter, retryWithJitter } from './retry.js';

// Use fake timers to make setTimeout resolve instantly
// (vitest fake timers don't work well with async/await + setTimeout chain;
// we mock sleep by mocking setTimeout so it fires synchronously)
vi.useFakeTimers();

describe('computeJitter', () => {
  it('returns a value between 0 and capDelayMs', () => {
    // Run 100 samples — all should be within [0, capDelayMs]
    for (let i = 0; i < 100; i++) {
      const delay = computeJitter(0, 250, 2000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(2000);
    }
  });

  it('respects the exponential cap: cap applied at attempt 4 with base=250, cap=2000', () => {
    // At attempt 4: ceiling = min(2000, 250 * 16) = min(2000, 4000) = 2000
    // So delay should be in [0, 2000]
    const delay = computeJitter(4, 250, 2000);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(2000);
  });

  it('respects the exponential growth before cap: attempt 0 capped at base', () => {
    // At attempt 0: ceiling = min(2000, 250 * 1) = 250
    // delay in [0, 250]
    const delay = computeJitter(0, 250, 2000);
    expect(delay).toBeLessThanOrEqual(250);
  });
});

describe('retryWithJitter', () => {
  beforeEach(() => {
    vi.clearAllTimers();
  });

  it('resolves immediately when fn succeeds on first call', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = retryWithJitter(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      capDelayMs: 100,
      isRetryable: () => true,
    });
    vi.runAllTimersAsync();
    expect(await result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry when isRetryable returns false (short-circuit)', async () => {
    const cause = new Error('non-retryable');
    const fn = vi.fn().mockRejectedValue(cause);
    const isRetryable = vi.fn().mockReturnValue(false);

    const promise = retryWithJitter(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      capDelayMs: 100,
      isRetryable,
    });
    vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow('non-retryable');
    // fn called once, isRetryable called once, no sleeps needed
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRetryable).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries and throws last error on exhaustion', async () => {
    const cause = new Error('always fails');
    const fn = vi.fn().mockRejectedValue(cause);
    const onRetry = vi.fn();

    const promise = retryWithJitter(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      capDelayMs: 10,
      isRetryable: () => true,
      onRetry,
    });
    // Let all timers fire so retries proceed
    vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow('always fails');
    // maxRetries=3 means 4 total calls (attempt 0, 1, 2, 3)
    expect(fn).toHaveBeenCalledTimes(4);
    // onRetry called for attempts 0, 1, 2 (not on final throw)
    expect(onRetry).toHaveBeenCalledTimes(3);
  });

  it('succeeds on third attempt after two failures', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) return Promise.reject(new Error('transient'));
      return Promise.resolve('ok');
    });
    const onRetry = vi.fn();

    const promise = retryWithJitter(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      capDelayMs: 10,
      isRetryable: () => true,
      onRetry,
    });
    vi.runAllTimersAsync();

    expect(await promise).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('calls onRetry with (err, attempt, delayMs)', async () => {
    const cause = new Error('fail');
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 2) return Promise.reject(cause);
      return Promise.resolve('done');
    });

    const onRetryArgs: Array<[unknown, number, number]> = [];
    const promise = retryWithJitter(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      capDelayMs: 10,
      isRetryable: () => true,
      onRetry: (err, attempt, delayMs) => {
        onRetryArgs.push([err, attempt, delayMs]);
      },
    });
    vi.runAllTimersAsync();

    await promise;
    expect(onRetryArgs).toHaveLength(1);
    expect(onRetryArgs[0]?.[0]).toBe(cause);
    expect(onRetryArgs[0]?.[1]).toBe(0); // first retry = attempt 0
    expect(typeof onRetryArgs[0]?.[2]).toBe('number');
  });

  it('works when onRetry is not provided', async () => {
    let callCount = 0;
    const fn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 2) return Promise.reject(new Error('transient'));
      return Promise.resolve('result');
    });

    const promise = retryWithJitter(fn, {
      maxRetries: 3,
      baseDelayMs: 1,
      capDelayMs: 10,
      isRetryable: () => true,
      // no onRetry
    });
    vi.runAllTimersAsync();

    expect(await promise).toBe('result');
  });

  it('maxRetries: 0 — tries once, throws immediately on failure', async () => {
    const cause = new Error('one-shot failure');
    const fn = vi.fn().mockRejectedValue(cause);

    const promise = retryWithJitter(fn, {
      maxRetries: 0,
      baseDelayMs: 1,
      capDelayMs: 10,
      isRetryable: () => true,
    });
    vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow('one-shot failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
