/**
 * createRateLimiter factory.
 * Week 1 scaffold: stub only. Full implementation ships Week 5.
 *
 * The implementation will use:
 *   ZREMRANGEBYSCORE key 0 (now - windowMs)   — evict expired entries
 *   ZCARD key                                  — count current window
 *   ZADD key now now                           — record this request
 * All in a single redis.multi().exec() pipeline for atomicity.
 * If exec() throws: return { allowed: false, remaining: 0, resetMs: windowMs }.
 */

import type { RateLimiter, RateLimiterConfig } from './types.js';

/**
 * Create a sliding-window rate limiter backed by Redis sorted sets.
 * The caller provides the ioredis instance — this package does not manage connections.
 */
export function createRateLimiter(_config: RateLimiterConfig): RateLimiter {
  throw new Error(
    '[dlabs-toolkit] createRateLimiter is not yet implemented. Implementation ships Week 5.'
  );
}
