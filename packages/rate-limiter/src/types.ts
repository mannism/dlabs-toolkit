/**
 * Core type definitions for @diabolicallabs/rate-limiter.
 * Matches the spec in briefs/brief-platform.md §4.4.
 */

import type { Redis } from 'ioredis';

/**
 * Configuration for createRateLimiter(). Supplies the ioredis client (caller-managed
 * singleton), the sliding window duration and request cap, and an optional key prefix.
 * windowMs and maxRequests define the rate limit contract; the ioredis instance is
 * not bundled — callers provide their existing connection.
 */
export interface RateLimiterConfig {
  redis: Redis; // caller provides the ioredis singleton — not bundled
  keyPrefix?: string; // default: 'rl:'
  windowMs: number; // sliding window duration in milliseconds
  maxRequests: number; // max requests allowed within the window
}

/**
 * Result returned by check(). When allowed is false, remaining is 0 and resetMs
 * indicates how many milliseconds until the oldest recorded request exits the window,
 * freeing capacity. Carry resetMs into a Retry-After response header when rejecting
 * clients at the API boundary.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number; // requests remaining in the current window
  resetMs: number; // ms until the oldest entry expires from the window
}

/**
 * The rate limiter interface — what consumers program against. Obtain an instance
 * via createRateLimiter(). Uses a Redis sorted-set sliding window with a single
 * atomic pipeline per check. Fail-closed: Redis errors are treated as rate-limit
 * exceeded, never as permissive pass-through.
 */
export interface RateLimiter {
  // Check whether the key is within its rate limit.
  // Fail-closed: returns { allowed: false } if Redis throws.
  check(key: string): Promise<RateLimitResult>;

  // Convenience: throws RateLimitError if the key is over limit.
  // Fail-closed: throws RateLimitError if Redis throws.
  enforce(key: string): Promise<void>;
}

/**
 * Thrown by enforce() when the rate limit is exceeded or Redis is unavailable.
 * remaining is always 0 on a limit-exceeded error; resetMs indicates how long
 * until capacity returns. Catch this class at the request boundary to return
 * a 429 response — never swallow it silently.
 */
export class RateLimitError extends Error {
  override readonly name = 'RateLimitError';
  readonly remaining: number;
  readonly resetMs: number;

  constructor(opts: { message: string; remaining: number; resetMs: number }) {
    super(opts.message);
    this.remaining = opts.remaining;
    this.resetMs = opts.resetMs;
  }
}
