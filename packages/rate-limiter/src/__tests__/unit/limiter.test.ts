/**
 * Unit tests for createRateLimiter using a mock RedisExecutor.
 *
 * Tests:
 *   - check() returns correct RateLimitResult for allowed and rejected states
 *   - enforce() resolves when allowed, throws RateLimitError when rejected
 *   - Fail-closed behavior (onRedisError: 'closed') — default
 *   - Fail-open behavior (onRedisError: 'open')
 *   - Logger events (RL_REJECTED, RL_REDIS_ERROR)
 *   - RateLimitError.kind discriminator
 *   - RedisExecutor driver-swap smoke (AC #15): instantiate with plain object, no ioredis import
 */

import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../../limiter.js';
import type { RedisExecutor } from '../../types.js';
import { RateLimitError } from '../../types.js';

// ─── Mock RedisExecutor factory ───────────────────────────────────────────────

/**
 * Creates a minimal mock RedisExecutor that simulates Lua script results.
 * allowed=1 means admitted, 0 means rejected.
 */
function makeRedisExecutor(opts: {
  allowed: 0 | 1;
  remaining?: number;
  resetMs?: number;
  throwError?: Error;
  shaToReturn?: string;
}): RedisExecutor {
  const luaResult = [opts.allowed, opts.remaining ?? (opts.allowed ? 99 : 0), opts.resetMs ?? 0];

  return {
    eval: opts.throwError
      ? () => Promise.reject(opts.throwError)
      : () => Promise.resolve(luaResult),
    evalsha: opts.throwError
      ? () => Promise.reject(opts.throwError)
      : () => Promise.resolve(luaResult),
    scriptLoad: opts.throwError
      ? () => Promise.reject(opts.throwError)
      : () => Promise.resolve(opts.shaToReturn ?? 'mock-sha-abc123'),
  };
}

// ─── check() ──────────────────────────────────────────────────────────────────

describe('createRateLimiter — check()', () => {
  it('returns allowed:true with remaining when under limit', async () => {
    const redis = makeRedisExecutor({ allowed: 1, remaining: 42 });
    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
    const result = await limiter.check('user:123');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(42);
    expect(typeof result.resetMs).toBe('number');
  });

  it('returns allowed:false with remaining:0 when over limit', async () => {
    const redis = makeRedisExecutor({ allowed: 0, remaining: 0, resetMs: 30_000 });
    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
    const result = await limiter.check('user:123');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetMs).toBe(30_000);
  });

  it('respects keyPrefix in key construction', async () => {
    let capturedKey = '';
    const redis: RedisExecutor = {
      eval: (_script, _numKeys, key) => {
        capturedKey = String(key);
        return Promise.resolve([1, 99, 0]);
      },
      evalsha: (_sha, _numKeys, key) => {
        capturedKey = String(key);
        return Promise.resolve([1, 99, 0]);
      },
      scriptLoad: () => Promise.resolve('sha'),
    };
    const limiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 100,
      keyPrefix: 'api:',
    });
    await limiter.check('user:456');
    expect(capturedKey).toBe('api:user:456');
  });

  it('uses default keyPrefix "rl:" when not specified', async () => {
    let capturedKey = '';
    const redis: RedisExecutor = {
      eval: (_script, _numKeys, key) => {
        capturedKey = String(key);
        return Promise.resolve([1, 99, 0]);
      },
      evalsha: (_sha, _numKeys, key) => {
        capturedKey = String(key);
        return Promise.resolve([1, 99, 0]);
      },
      scriptLoad: () => Promise.resolve('sha'),
    };
    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
    await limiter.check('user:789');
    expect(capturedKey).toBe('rl:user:789');
  });

  describe('fail-closed behavior (onRedisError: "closed" default)', () => {
    it('returns { allowed: false, remaining: 0, resetMs: windowMs } on Redis error', async () => {
      const redis = makeRedisExecutor({ allowed: 0, throwError: new Error('Connection refused') });
      const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
      const result = await limiter.check('user:123');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetMs).toBe(60_000); // windowMs
    });

    it('logs RL_REDIS_ERROR on Redis error', async () => {
      const redis = makeRedisExecutor({ allowed: 0, throwError: new Error('Redis down') });
      const warnSpy = vi.fn();
      const limiter = createRateLimiter({
        redis,
        windowMs: 60_000,
        maxRequests: 100,
        logger: { warn: warnSpy },
      });
      await limiter.check('user:123');
      expect(warnSpy).toHaveBeenCalledWith(
        'RL_REDIS_ERROR',
        expect.objectContaining({ policy: 'closed' })
      );
    });
  });

  describe('fail-open behavior (onRedisError: "open")', () => {
    it('returns { allowed: true, remaining: 0, resetMs: 0 } on Redis error', async () => {
      const redis = makeRedisExecutor({ allowed: 0, throwError: new Error('Connection refused') });
      const limiter = createRateLimiter({
        redis,
        windowMs: 60_000,
        maxRequests: 100,
        onRedisError: 'open',
      });
      const result = await limiter.check('user:123');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
      expect(result.resetMs).toBe(0);
    });

    it('logs RL_REDIS_ERROR on Redis error with policy: open', async () => {
      const redis = makeRedisExecutor({ allowed: 0, throwError: new Error('Redis timeout') });
      const warnSpy = vi.fn();
      const limiter = createRateLimiter({
        redis,
        windowMs: 60_000,
        maxRequests: 100,
        onRedisError: 'open',
        logger: { warn: warnSpy },
      });
      await limiter.check('user:123');
      expect(warnSpy).toHaveBeenCalledWith(
        'RL_REDIS_ERROR',
        expect.objectContaining({ policy: 'open' })
      );
    });
  });
});

// ─── enforce() ────────────────────────────────────────────────────────────────

describe('createRateLimiter — enforce()', () => {
  it('resolves when allowed', async () => {
    const redis = makeRedisExecutor({ allowed: 1, remaining: 99 });
    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
    await expect(limiter.enforce('user:123')).resolves.toBeUndefined();
  });

  it('throws RateLimitError when over limit', async () => {
    const redis = makeRedisExecutor({ allowed: 0, remaining: 0, resetMs: 30_000 });
    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
    await expect(limiter.enforce('user:123')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('RateLimitError.kind is "exceeded" when over limit', async () => {
    const redis = makeRedisExecutor({ allowed: 0, remaining: 0, resetMs: 15_000 });
    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
    try {
      await limiter.enforce('user:123');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      if (err instanceof RateLimitError) {
        expect(err.kind).toBe('exceeded');
        expect(err.remaining).toBe(0);
        expect(err.resetMs).toBe(15_000);
      }
    }
  });

  describe('fail-closed behavior (default) on Redis error', () => {
    it('throws RateLimitError({ kind: "unavailable" })', async () => {
      const redis = makeRedisExecutor({ allowed: 0, throwError: new Error('Redis down') });
      const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
      try {
        await limiter.enforce('user:123');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        if (err instanceof RateLimitError) {
          expect(err.kind).toBe('unavailable');
        }
      }
    });
  });

  describe('fail-open behavior on Redis error', () => {
    it('resolves without throwing when onRedisError: "open"', async () => {
      const redis = makeRedisExecutor({ allowed: 0, throwError: new Error('Redis unavailable') });
      const limiter = createRateLimiter({
        redis,
        windowMs: 60_000,
        maxRequests: 100,
        onRedisError: 'open',
      });
      await expect(limiter.enforce('user:123')).resolves.toBeUndefined();
    });
  });
});

// ─── RateLimitError class ──────────────────────────────────────────────────────

describe('RateLimitError', () => {
  it('is an Error subclass', () => {
    const err = new RateLimitError({
      message: 'limit exceeded',
      kind: 'exceeded',
      remaining: 0,
      resetMs: 5000,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('name is "RateLimitError"', () => {
    const err = new RateLimitError({ message: 'test', kind: 'exceeded', remaining: 0, resetMs: 0 });
    expect(err.name).toBe('RateLimitError');
  });

  it('kind: exceeded', () => {
    const err = new RateLimitError({
      message: 'over limit',
      kind: 'exceeded',
      remaining: 0,
      resetMs: 1000,
    });
    expect(err.kind).toBe('exceeded');
  });

  it('kind: unavailable', () => {
    const err = new RateLimitError({
      message: 'redis down',
      kind: 'unavailable',
      remaining: 0,
      resetMs: 60_000,
    });
    expect(err.kind).toBe('unavailable');
  });
});

// ─── RedisExecutor driver-swap smoke (AC #15) ─────────────────────────────────

describe('RedisExecutor driver-swap smoke (AC #15)', () => {
  it('works with a plain object mock — no ioredis import needed', async () => {
    // This test verifies the structural interface: a plain object with eval/evalsha/scriptLoad
    // satisfies RedisExecutor without importing ioredis at all.
    let scriptLoadCalled = false;

    const plainObjectExecutor: RedisExecutor = {
      eval: (_script: string, _numKeys: number, ..._args: Array<string | number>) => {
        // Simulate: admitted, 4 remaining, resetMs=30000
        return Promise.resolve([1, 4, 30_000]);
      },
      evalsha: (_sha: string, _numKeys: number, ..._args: Array<string | number>) => {
        return Promise.resolve([1, 4, 30_000]);
      },
      scriptLoad: (_script: string) => {
        scriptLoadCalled = true;
        return Promise.resolve('driver-swap-sha');
      },
    };

    // Instantiate the limiter with the plain object — no ioredis dependency
    const limiter = createRateLimiter({
      redis: plainObjectExecutor,
      windowMs: 60_000,
      maxRequests: 5,
    });

    const result = await limiter.check('smoke-key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.resetMs).toBe(30_000);

    // Verify scriptLoad was called (SHA pre-warm)
    expect(scriptLoadCalled).toBe(true);
  });

  it('enforce() works with the plain object executor', async () => {
    const executor: RedisExecutor = {
      eval: () => Promise.resolve([1, 9, 0]),
      evalsha: () => Promise.resolve([1, 9, 0]),
      scriptLoad: () => Promise.resolve('sha'),
    };
    const limiter = createRateLimiter({ redis: executor, windowMs: 60_000, maxRequests: 10 });
    await expect(limiter.enforce('test-key')).resolves.toBeUndefined();
  });
});

// ─── Fail-behaviour matrix (§5.5) ─────────────────────────────────────────────

describe('Fail-behaviour matrix (§5.5 of brief-week5.md)', () => {
  it('[check] under limit: allowed:true, remaining:N', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 1, remaining: 7 }),
      windowMs: 60_000,
      maxRequests: 8,
    });
    const r = await limiter.check('k');
    expect(r).toMatchObject({ allowed: true, remaining: 7 });
  });

  it('[check] over limit: allowed:false, remaining:0', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 0, remaining: 0, resetMs: 5000 }),
      windowMs: 60_000,
      maxRequests: 8,
    });
    const r = await limiter.check('k');
    expect(r).toMatchObject({ allowed: false, remaining: 0, resetMs: 5000 });
  });

  it('[check] Redis error + closed: allowed:false, resetMs=windowMs', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 0, throwError: new Error('redis err') }),
      windowMs: 45_000,
      maxRequests: 100,
    });
    const r = await limiter.check('k');
    expect(r).toMatchObject({ allowed: false, remaining: 0, resetMs: 45_000 });
  });

  it('[check] Redis error + open: allowed:true, remaining:0, resetMs:0', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 0, throwError: new Error('redis err') }),
      windowMs: 45_000,
      maxRequests: 100,
      onRedisError: 'open',
    });
    const r = await limiter.check('k');
    expect(r).toMatchObject({ allowed: true, remaining: 0, resetMs: 0 });
  });

  it('[enforce] under limit: resolves', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 1, remaining: 3 }),
      windowMs: 60_000,
      maxRequests: 4,
    });
    await expect(limiter.enforce('k')).resolves.toBeUndefined();
  });

  it('[enforce] over limit: throws RateLimitError({kind: exceeded})', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 0, remaining: 0, resetMs: 10_000 }),
      windowMs: 60_000,
      maxRequests: 4,
    });
    await expect(limiter.enforce('k')).rejects.toMatchObject({
      kind: 'exceeded',
      remaining: 0,
      resetMs: 10_000,
    });
  });

  it('[enforce] Redis error + closed: throws RateLimitError({kind: unavailable})', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 0, throwError: new Error('redis err') }),
      windowMs: 60_000,
      maxRequests: 100,
    });
    await expect(limiter.enforce('k')).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('[enforce] Redis error + open: resolves', async () => {
    const limiter = createRateLimiter({
      redis: makeRedisExecutor({ allowed: 0, throwError: new Error('redis err') }),
      windowMs: 60_000,
      maxRequests: 100,
      onRedisError: 'open',
    });
    await expect(limiter.enforce('k')).resolves.toBeUndefined();
  });
});
