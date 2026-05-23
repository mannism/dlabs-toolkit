/**
 * Placeholder test for @diabolicallabs/rate-limiter.
 *
 * Full unit test coverage ships in Week 5 alongside the RateLimiter
 * implementation. This file exists to:
 *  1. Satisfy passWithNoTests: false in vitest config
 *  2. Verify the package's public exports are present at the module level
 */

import { describe, expect, it } from 'vitest';
import { createRateLimiter, RateLimitError } from './index.js';

describe('@diabolicallabs/rate-limiter', () => {
  it('exports createRateLimiter as a function', () => {
    expect(typeof createRateLimiter).toBe('function');
  });

  it('exports RateLimitError as a class', () => {
    expect(typeof RateLimitError).toBe('function');
  });

  it('RateLimitError can be instantiated with correct fields', () => {
    const err = new RateLimitError({
      message: 'rate limited',
      kind: 'exceeded',
      remaining: 0,
      resetMs: 5000,
    });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RateLimitError');
    expect(err.message).toBe('rate limited');
    expect(err.kind).toBe('exceeded');
    expect(err.remaining).toBe(0);
    expect(err.resetMs).toBe(5000);
  });

  it('createRateLimiter returns a RateLimiter object', () => {
    // Provide a minimal RedisExecutor mock — no real Redis connection needed
    const mockRedis = {
      eval: () => Promise.resolve([1, 99, 0]),
      evalsha: () => Promise.resolve([1, 99, 0]),
      scriptLoad: () => Promise.resolve('mock-sha'),
    };
    const limiter = createRateLimiter({
      redis: mockRedis,
      windowMs: 60_000,
      maxRequests: 100,
    });
    expect(typeof limiter.check).toBe('function');
    expect(typeof limiter.enforce).toBe('function');
  });
});
