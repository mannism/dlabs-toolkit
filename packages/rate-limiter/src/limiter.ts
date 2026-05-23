/**
 * createRateLimiter factory.
 *
 * Returns a RateLimiter backed by a Redis sorted set. Uses Lua EVAL for
 * atomic check-and-record — prevents race conditions that MULTI/EXEC cannot
 * (see lua-script.ts and brief-week5.md §5.3 for the full atomicity argument).
 *
 * Lua script is loaded once at construction via SCRIPT LOAD (EVALSHA optimisation).
 * Subsequent calls use EVALSHA; on NOSCRIPT (cache flushed), falls back to EVAL.
 *
 * Algorithm: sliding-window-log (sorted set per key).
 *   - ZREMRANGEBYSCORE evicts expired entries
 *   - ZCARD counts the window state before admission
 *   - ZADD records the request if admitted
 *   - EXPIRE prevents idle key memory leaks
 *   - Redis TIME provides the authoritative clock (no app-clock drift)
 *
 * Fail behaviour (per §5.5 of brief-week5.md):
 *   onRedisError: 'closed' (default) — Redis error → rejected (kind: 'unavailable')
 *   onRedisError: 'open'             — Redis error → allowed, logs RL_REDIS_ERROR
 */

import { v4 as uuidv4 } from 'uuid';
import { getLogger } from './logger.js';
import { SLIDING_WINDOW_LUA } from './lua-script.js';
import type { RateLimiter, RateLimiterConfig, RateLimitResult, RedisExecutor } from './types.js';
import { RateLimitError } from './types.js';

/**
 * Parse the Lua script return value into a typed RateLimitResult.
 * The script returns: [allowed(0|1), remaining, resetMs] as Redis bulk strings.
 */
function parseLuaResult(raw: unknown): RateLimitResult {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error(`[rate-limiter] Unexpected Lua result shape: ${JSON.stringify(raw)}`);
  }
  const [allowedRaw, remainingRaw, resetMsRaw] = raw;
  return {
    allowed: Number(allowedRaw) === 1,
    remaining: Number(remainingRaw),
    resetMs: Number(resetMsRaw),
  };
}

/**
 * Execute the Lua script via EVALSHA with EVAL fallback on NOSCRIPT.
 * The SHA is loaded lazily on first call to handle Redis restarts gracefully.
 */
async function evalWithFallback(
  redis: RedisExecutor,
  sha: string | null,
  key: string,
  windowMs: number,
  maxRequests: number,
  memberId: string
): Promise<{ result: unknown; newSha: string | null }> {
  const args: Array<string | number> = [windowMs, maxRequests, memberId];

  if (sha !== null) {
    try {
      const result = await redis.evalsha(sha, 1, key, ...args);
      return { result, newSha: sha };
    } catch (err) {
      // NOSCRIPT means the script was flushed from the cache — fall through to EVAL
      const isNoscript =
        err instanceof Error &&
        (err.message.includes('NOSCRIPT') || err.message.includes('No matching script'));

      if (!isNoscript) throw err;
      // Fall through to EVAL + re-load
    }
  }

  // EVAL (also re-loads the script SHA for next time)
  const result = await redis.eval(SLIDING_WINDOW_LUA, 1, key, ...args);
  // Reload the SHA for future calls
  const newSha = await redis.scriptLoad(SLIDING_WINDOW_LUA);
  return { result, newSha };
}

/**
 * Create a sliding-window rate limiter backed by Redis sorted sets.
 *
 * The caller provides the Redis executor (typically an ioredis Redis instance).
 * This package does not manage connections.
 *
 * @example
 * import { createRateLimiter } from '@diabolicallabs/rate-limiter';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
 *
 * // Multi-tier: instantiate one limiter per tier
 * const freeLimiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
 * const paidLimiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 1_000 });
 */
export function createRateLimiter(config: RateLimiterConfig): RateLimiter {
  const {
    redis,
    keyPrefix = 'rl:',
    windowMs,
    maxRequests,
    onRedisError = 'closed',
    logger: configLogger,
  } = config;

  const log = configLogger ?? getLogger();

  // Lua SHA cache — loaded lazily on first check()/enforce() call.
  // null = not yet loaded; we load it in a non-blocking way at construction
  // (best-effort pre-warm), then lazily on first actual call if pre-warm failed.
  let luaSha: string | null = null;
  let shaPromise: Promise<void> | null = null;

  // Pre-warm the script SHA. We don't block construction on this — it will
  // be retried lazily on first actual rate-limit check if it fails.
  function prewarmSha(): void {
    shaPromise = redis
      .scriptLoad(SLIDING_WINDOW_LUA)
      .then((sha) => {
        luaSha = sha;
      })
      .catch(() => {
        // Pre-warm failure is non-fatal — will retry lazily on first call
        luaSha = null;
      });
  }

  prewarmSha();

  /**
   * Internal implementation of the rate-limit check.
   * Returns RateLimitResult on success; throws the original Redis error if Redis fails.
   */
  async function runCheck(key: string): Promise<RateLimitResult> {
    const fullKey = `${keyPrefix}${key}`;
    const memberId = uuidv4();

    // Wait for any in-progress SHA pre-warm before our first call
    if (shaPromise !== null) {
      await shaPromise;
      shaPromise = null;
    }

    const { result, newSha } = await evalWithFallback(
      redis,
      luaSha,
      fullKey,
      windowMs,
      maxRequests,
      memberId
    );

    // Update SHA cache if it changed (e.g. after EVAL fallback reloaded it)
    if (newSha !== null && newSha !== luaSha) {
      luaSha = newSha;
    }

    return parseLuaResult(result);
  }

  return {
    async check(key): Promise<RateLimitResult> {
      try {
        const result = await runCheck(key);

        if (!result.allowed) {
          log.warn('RL_REJECTED', {
            key,
            remaining: result.remaining,
            resetMs: result.resetMs,
            kind: 'exceeded',
          });
        }

        return result;
      } catch (err) {
        // Redis error — apply fail policy
        log.warn('RL_REDIS_ERROR', {
          key,
          error: err instanceof Error ? err.message : String(err),
          policy: onRedisError,
        });

        if (onRedisError === 'open') {
          // Fail-open: allow through, log the error
          return { allowed: true, remaining: 0, resetMs: 0 };
        }

        // Fail-closed (default): treat as exceeded
        return { allowed: false, remaining: 0, resetMs: windowMs };
      }
    },

    async enforce(key): Promise<void> {
      try {
        const result = await runCheck(key);

        if (!result.allowed) {
          log.warn('RL_REJECTED', {
            key,
            remaining: result.remaining,
            resetMs: result.resetMs,
            kind: 'exceeded',
          });
          throw new RateLimitError({
            message: `Rate limit exceeded for key "${key}". Retry after ${result.resetMs}ms.`,
            kind: 'exceeded',
            remaining: 0,
            resetMs: result.resetMs,
          });
        }
      } catch (err) {
        // Re-throw our own RateLimitError unchanged
        if (err instanceof RateLimitError) throw err;

        // Redis error — apply fail policy
        log.warn('RL_REDIS_ERROR', {
          key,
          error: err instanceof Error ? err.message : String(err),
          policy: onRedisError,
        });

        if (onRedisError === 'open') {
          // Fail-open: resolve without throwing
          return;
        }

        // Fail-closed (default): throw as unavailable
        throw new RateLimitError({
          message: `Rate limiter unavailable (Redis error) for key "${key}".`,
          kind: 'unavailable',
          remaining: 0,
          resetMs: windowMs,
        });
      }
    },
  };
}
