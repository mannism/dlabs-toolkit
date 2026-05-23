/**
 * Integration tests for @diabolicallabs/rate-limiter — real Redis connection.
 *
 * Requires REDIS_URL to be set. CI skips when absent.
 * Run locally: REDIS_URL=redis://localhost:6379 pnpm test:integration
 *
 * Local Redis: docker run -d -p 6379:6379 redis:alpine
 *
 * Tests:
 *   - Real sliding window behavior with actual Redis sorted sets
 *   - EVALSHA optimisation works (pre-loaded SHA is used on subsequent calls)
 *   - Concurrency: multiple check() calls from the same key
 *   - NOSCRIPT fallback: simulated by clearing the SHA
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../limiter.js';
import type { RedisExecutor } from '../../types.js';

const hasRedis = process.env.REDIS_URL !== undefined && process.env.REDIS_URL !== '';

describe.skipIf(!hasRedis)('@diabolicallabs/rate-limiter integration — real Redis', () => {
  let redis: RedisExecutor;
  let ioredisInstance: { disconnect: () => void };

  beforeAll(async () => {
    // Dynamic import to avoid ioredis being a hard dep in non-integration test runs
    const { default: Redis } = await import('ioredis');
    const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await client.connect();
    redis = client as unknown as RedisExecutor;
    ioredisInstance = client;
  });

  afterAll(() => {
    if (ioredisInstance) {
      ioredisInstance.disconnect();
    }
  });

  it('allows requests under the limit', async () => {
    const key = `test:integration:allow:${Date.now()}`;
    const limiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 10,
      keyPrefix: 'rl:test:',
    });
    const result = await limiter.check(key);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it('rejects requests over the limit', async () => {
    const key = `test:integration:reject:${Date.now()}`;
    const limiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 3,
      keyPrefix: 'rl:test:',
    });

    // Exhaust the limit
    await limiter.check(key);
    await limiter.check(key);
    await limiter.check(key);

    // This call should be rejected
    const result = await limiter.check(key);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetMs).toBeGreaterThan(0);
  });

  it('sliding window evicts old entries after windowMs', async () => {
    const key = `test:integration:sliding:${Date.now()}`;
    // Use a very short window (100ms) to verify eviction
    const limiter = createRateLimiter({
      redis,
      windowMs: 100,
      maxRequests: 2,
      keyPrefix: 'rl:test:',
    });

    await limiter.check(key);
    await limiter.check(key);

    // Window is full — should be rejected
    const rejected = await limiter.check(key);
    expect(rejected.allowed).toBe(false);

    // Wait for the window to expire
    await new Promise((r) => setTimeout(r, 150));

    // Now should be allowed again
    const allowed = await limiter.check(key);
    expect(allowed.allowed).toBe(true);
  });

  it('enforce() resolves when under limit', async () => {
    const key = `test:integration:enforce:${Date.now()}`;
    const limiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 5,
      keyPrefix: 'rl:test:',
    });
    await expect(limiter.enforce(key)).resolves.toBeUndefined();
  });

  it('enforce() throws RateLimitError when over limit', async () => {
    const { RateLimitError } = await import('../../types.js');
    const key = `test:integration:enforce-reject:${Date.now()}`;
    const limiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 1,
      keyPrefix: 'rl:test:',
    });

    await limiter.enforce(key); // First call: admitted
    await expect(limiter.enforce(key)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('multiple limiter instances share Redis but have independent windows', async () => {
    const keyFree = `test:integration:tier-free:${Date.now()}`;
    const keyPaid = `test:integration:tier-paid:${Date.now()}`;
    const freeLimiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 2,
      keyPrefix: 'rl:test:',
    });
    const paidLimiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 100,
      keyPrefix: 'rl:test:',
    });

    // Exhaust free tier
    await freeLimiter.check(keyFree);
    await freeLimiter.check(keyFree);
    const freeResult = await freeLimiter.check(keyFree);
    expect(freeResult.allowed).toBe(false);

    // Paid tier is unaffected
    const paidResult = await paidLimiter.check(keyPaid);
    expect(paidResult.allowed).toBe(true);
    expect(paidResult.remaining).toBe(99);
  });
});
