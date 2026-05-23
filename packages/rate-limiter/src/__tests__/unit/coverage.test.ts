/**
 * Coverage gap tests for @diabolicallabs/rate-limiter.
 *
 * Covers edge cases not hit by the main unit tests:
 *   - NOSCRIPT error → EVAL fallback path
 *   - SHA update path (newSha !== luaSha)
 *   - parseLuaResult invalid shape error path
 *   - Pre-warm failure (scriptLoad throws at construction time)
 *   - SHA null initial state (sha is null, uses EVAL directly)
 */

import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../limiter.js';
import type { RedisExecutor } from '../../types.js';

// ─── NOSCRIPT fallback ────────────────────────────────────────────────────────

describe('EVALSHA → EVAL fallback on NOSCRIPT', () => {
  it('falls back to EVAL when evalsha throws NOSCRIPT, then reloads SHA', async () => {
    let evalCalled = false;
    let evalshaCalled = false;
    let scriptLoadCallCount = 0;

    // Sequence: scriptLoad (pre-warm) → evalsha (NOSCRIPT) → eval → scriptLoad (reload)
    const redis: RedisExecutor = {
      scriptLoad: () => {
        scriptLoadCallCount++;
        // First call is pre-warm, second is reload after NOSCRIPT
        return Promise.resolve(`sha-${scriptLoadCallCount}`);
      },
      evalsha: () => {
        evalshaCalled = true;
        // Simulate NOSCRIPT error
        return Promise.reject(new Error('NOSCRIPT No matching script'));
      },
      eval: () => {
        evalCalled = true;
        return Promise.resolve([1, 9, 0]);
      },
    };

    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 10 });
    // Wait for pre-warm to complete
    await new Promise((r) => setTimeout(r, 10));

    const result = await limiter.check('test-key');
    expect(result.allowed).toBe(true);
    expect(evalshaCalled).toBe(true);
    expect(evalCalled).toBe(true);
    // scriptLoad called twice: pre-warm + reload after NOSCRIPT
    expect(scriptLoadCallCount).toBeGreaterThanOrEqual(2);
  });

  it('propagates non-NOSCRIPT evalsha errors', async () => {
    const redis: RedisExecutor = {
      scriptLoad: () => Promise.resolve('sha-1'),
      evalsha: () =>
        Promise.reject(
          new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
        ),
      eval: () => Promise.resolve([1, 9, 0]),
    };

    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 10 });
    await new Promise((r) => setTimeout(r, 10));

    // Should fail-closed (not NOSCRIPT → throws, check() catches and returns fail-closed)
    const result = await limiter.check('test-key');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetMs).toBe(60_000);
  });
});

// ─── Initial SHA null (no pre-warm yet) ───────────────────────────────────────

describe('Initial SHA null — eval path', () => {
  it('uses eval directly and reloads SHA when pre-warm failure left SHA null', async () => {
    let evalCalled = false;
    let scriptLoadCount = 0;

    // First scriptLoad call (pre-warm) rejects; second call (inside evalWithFallback
    // after successful eval) succeeds. The check should succeed.
    const redis: RedisExecutor = {
      scriptLoad: () => {
        scriptLoadCount++;
        if (scriptLoadCount === 1) {
          // Pre-warm fails → luaSha stays null
          return Promise.reject(new Error('connection refused on prewarm'));
        }
        // Reload after eval succeeds
        return Promise.resolve('sha-reloaded');
      },
      evalsha: () => Promise.resolve([0, 0, 1000]), // unreachable — sha is null
      eval: () => {
        evalCalled = true;
        return Promise.resolve([1, 5, 0]);
      },
    };

    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 10 });
    // Wait for pre-warm failure to settle
    await new Promise((r) => setTimeout(r, 10));

    const result = await limiter.check('test-key');
    expect(result.allowed).toBe(true);
    expect(evalCalled).toBe(true);
    expect(scriptLoadCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── SHA update after EVAL fallback ──────────────────────────────────────────

describe('SHA cache update after EVAL reloads', () => {
  it('updates luaSha after EVAL reloads it on NOSCRIPT', async () => {
    let secondEvalshaSha = '';

    const redis: RedisExecutor = {
      scriptLoad: (_script) => Promise.resolve('new-sha-after-reload'),
      evalsha: (sha, _numKeys, _key) => {
        if (sha === 'pre-warm-sha') {
          // First call: NOSCRIPT
          return Promise.reject(new Error('NOSCRIPT'));
        }
        // Second call with reloaded SHA: succeed
        secondEvalshaSha = sha;
        return Promise.resolve([1, 3, 0]);
      },
      eval: () => Promise.resolve([1, 4, 0]),
    };

    // Override scriptLoad to return 'pre-warm-sha' on first call, 'new-sha-after-reload' on second
    let scriptLoadCount = 0;
    const redis2: RedisExecutor = {
      ...redis,
      scriptLoad: () => {
        scriptLoadCount++;
        return Promise.resolve(scriptLoadCount === 1 ? 'pre-warm-sha' : 'new-sha-after-reload');
      },
    };

    const limiter = createRateLimiter({ redis: redis2, windowMs: 60_000, maxRequests: 10 });
    await new Promise((r) => setTimeout(r, 10));

    // First check: evalsha throws NOSCRIPT → eval → scriptLoad → SHA updated
    await limiter.check('test-key');

    // Second check: should now use new SHA
    await limiter.check('test-key');
    expect(secondEvalshaSha).toBe('new-sha-after-reload');
  });
});

// ─── parseLuaResult invalid shape ────────────────────────────────────────────

describe('parseLuaResult edge cases', () => {
  it('fails-closed when Lua returns malformed result', async () => {
    const redis: RedisExecutor = {
      scriptLoad: () => Promise.resolve('sha'),
      evalsha: () => Promise.resolve(null), // malformed — not an array
      eval: () => Promise.resolve(null),
    };

    const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 10 });
    await new Promise((r) => setTimeout(r, 10));

    // parseLuaResult throws on null → check() catches → fail-closed
    const result = await limiter.check('bad-result-key');
    expect(result.allowed).toBe(false);
  });
});

// ─── RL_REJECTED log event ────────────────────────────────────────────────────

describe('RL_REJECTED log event', () => {
  it('emits RL_REJECTED when request is denied', async () => {
    const warnEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    const redis: RedisExecutor = {
      scriptLoad: () => Promise.resolve('sha'),
      evalsha: () => Promise.resolve([0, 0, 5000]),
      eval: () => Promise.resolve([0, 0, 5000]),
    };

    const limiter = createRateLimiter({
      redis,
      windowMs: 60_000,
      maxRequests: 10,
      logger: {
        warn: (event, data) => warnEvents.push({ event, data }),
      },
    });
    await new Promise((r) => setTimeout(r, 10));

    await limiter.check('rejected-key');
    const rejectedEvent = warnEvents.find((e) => e.event === 'RL_REJECTED');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent?.data['key']).toBe('rejected-key');
    expect(rejectedEvent?.data['kind']).toBe('exceeded');
  });
});
