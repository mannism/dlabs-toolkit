/**
 * Regression test for the ioredis/RedisExecutor scriptLoad incompatibility
 * (proj-plan/dlabs-toolkit/briefs/brief-rate-limiter-redis-executor-fix.md).
 *
 * ioredis has no scriptLoad() method — only .script("LOAD", script). Every
 * other test in this suite mocks RedisExecutor with a hand-supplied
 * scriptLoad(), which sidesteps the bug entirely and never exercises a
 * real ioredis client shape. This file uses an ioredis-*shaped* mock
 * (implements .script("LOAD", ...), deliberately has no .scriptLoad()) and
 * routes it through fromIoredis() — the fix — to prove a raw ioredis client
 * now works with createRateLimiter() without a consumer-side adapter.
 */

import { describe, expect, it } from 'vitest';
import { fromIoredis, type IoredisLike } from '../../ioredis-adapter.js';
import { createRateLimiter } from '../../limiter.js';

/**
 * Minimal mock matching ioredis's actual client shape: eval/evalsha are
 * native; scriptLoad does NOT exist — only script("LOAD", ...), exactly
 * like the real ioredis.Redis class.
 */
function makeIoredisShapedMock(): IoredisLike & { scriptLoadCallCount: number } {
  const mock = {
    scriptLoadCallCount: 0,
    script(subcommand: 'LOAD', _script: string): Promise<unknown> {
      if (subcommand !== 'LOAD') throw new Error(`unexpected subcommand: ${subcommand}`);
      mock.scriptLoadCallCount++;
      return Promise.resolve('mock-ioredis-sha');
    },
    eval(_script: string, _numKeys: number, ..._args: Array<string | number>): Promise<unknown> {
      return Promise.resolve([1, 9, 0]);
    },
    evalsha(_sha: string, _numKeys: number, ..._args: Array<string | number>): Promise<unknown> {
      return Promise.resolve([1, 9, 0]);
    },
  };
  return mock;
}

describe('fromIoredis() — ioredis-shaped client compatibility', () => {
  it('sanity: the mock has no scriptLoad method, matching real ioredis', () => {
    const mock = makeIoredisShapedMock();
    expect('scriptLoad' in mock).toBe(false);
    expect('script' in mock).toBe(true);
  });

  it('createRateLimiter does not throw when given fromIoredis(ioredisShapedClient)', () => {
    const mock = makeIoredisShapedMock();
    expect(() =>
      createRateLimiter({ redis: fromIoredis(mock), windowMs: 60_000, maxRequests: 10 })
    ).not.toThrow();
  });

  it('check() resolves correctly, routing scriptLoad through .script("LOAD", ...)', async () => {
    const mock = makeIoredisShapedMock();
    const limiter = createRateLimiter({
      redis: fromIoredis(mock),
      windowMs: 60_000,
      maxRequests: 10,
    });

    const result = await limiter.check('user:ioredis-shaped');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(mock.scriptLoadCallCount).toBeGreaterThan(0);
  });

  it('enforce() resolves without throwing against an ioredis-shaped client', async () => {
    const mock = makeIoredisShapedMock();
    const limiter = createRateLimiter({
      redis: fromIoredis(mock),
      windowMs: 60_000,
      maxRequests: 10,
    });

    await expect(limiter.enforce('user:ioredis-shaped')).resolves.toBeUndefined();
  });
});
