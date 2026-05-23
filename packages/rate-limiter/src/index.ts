/**
 * @diabolicallabs/rate-limiter
 *
 * Redis sliding-window rate limiter. Atomic via Lua EVAL — never MULTI/EXEC.
 * ioredis is a peerDependency; caller provides the Redis singleton.
 *
 * Fail-closed by default: Redis errors are treated as limit exceeded.
 * Configure onRedisError: 'open' for general product APIs that prefer
 * fail-open during Redis blips.
 *
 * @example
 * import { createRateLimiter } from '@diabolicallabs/rate-limiter';
 * import Redis from 'ioredis';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const limiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 100 });
 *
 * // At request boundary:
 * await limiter.enforce(`user:${userId}`); // throws RateLimitError if over limit
 *
 * // Or check without throwing:
 * const { allowed, remaining, resetMs } = await limiter.check(`user:${userId}`);
 */

// Factory function
export { createRateLimiter } from './limiter.js';

// Logger
export { setRateLimiterLogger } from './logger.js';

// Types
export type {
  Logger,
  RateLimiter,
  RateLimiterConfig,
  RateLimitResult,
  RedisExecutor,
} from './types.js';

// Error class — exported as value (not just type) for instanceof checks
export { RateLimitError } from './types.js';
