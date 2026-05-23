/**
 * Core type definitions for @diabolicallabs/rate-limiter.
 * Sliding-window-log rate limiter backed by Redis sorted sets.
 * Atomic via Lua EVAL — not MULTI/EXEC (see §5.3 of brief-week5.md).
 */

/**
 * Pluggable logger interface — matches the toolkit-wide convention established
 * in @diabolicallabs/llm-pricing and @diabolicallabs/llm-client.
 *
 * Stable event names:
 *   RL_ALLOWED      — key admitted (DEBUG-level; optional in consumer)
 *   RL_REJECTED     — key over limit (INFO)
 *   RL_REDIS_ERROR  — Redis threw; records failBehavior applied (ERROR)
 */
export interface Logger {
  warn: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Structural interface declaring only the Redis commands the rate limiter uses.
 * Any ioredis Redis instance satisfies this structurally. Upstash REST adapters
 * and node-redis v4 shims can implement this for driver-swap without forcing a
 * major version bump on this package.
 *
 * The peerDependency on ioredis remains — this interface removes the hard type
 * dependency, not the operational default.
 */
export interface RedisExecutor {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  scriptLoad(script: string): Promise<string>;
}

/**
 * Configuration for createRateLimiter(). Supplies the Redis executor (caller-managed
 * singleton), the sliding window duration and request cap, an optional key prefix,
 * fail-behavior policy on Redis errors, and a pluggable logger.
 *
 * windowMs and maxRequests define the rate limit contract; the Redis instance is
 * not bundled — callers provide their existing connection.
 *
 * Multi-tier consumers: instantiate one RateLimiter per tier (free/paid/admin).
 * Tiers share the same Redis connection but have independent window/limit configs.
 */
export interface RateLimiterConfig {
  redis: RedisExecutor; // caller provides the ioredis singleton — not bundled
  keyPrefix?: string; // default: 'rl:'
  windowMs: number; // sliding window duration in milliseconds
  maxRequests: number; // max requests allowed within the window
  /**
   * Behavior when Redis throws during check()/enforce().
   *
   *   'closed' (default) — fail-closed: treat Redis error as limit exceeded.
   *     check() returns { allowed: false, remaining: 0, resetMs: windowMs }.
   *     enforce() throws RateLimitError({ kind: 'unavailable', ... }).
   *     Correct for: auth endpoints, payment flows — unmetered access during
   *     a Redis blip is a security risk.
   *
   *   'open' — fail-open: allow the request through; log RL_REDIS_ERROR.
   *     check() returns { allowed: true, remaining: 0, resetMs: 0 }.
   *     enforce() resolves (does not throw).
   *     Correct for: general product APIs where a Redis restart should not
   *     produce spurious 429s for users who are not actually rate-limited.
   */
  onRedisError?: 'closed' | 'open'; // default: 'closed'
  logger?: Logger; // pluggable logger — matches toolkit-wide convention
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
 * atomic Lua EVAL per check. Fail-closed by default: Redis errors are treated as
 * rate-limit exceeded unless onRedisError: 'open' is configured.
 */
export interface RateLimiter {
  // Check whether the key is within its rate limit.
  // Fail-closed by default: returns { allowed: false } if Redis throws.
  check(key: string): Promise<RateLimitResult>;

  // Convenience: throws RateLimitError if the key is over limit.
  // Fail-closed by default: throws RateLimitError({ kind: 'unavailable' }) if Redis throws.
  enforce(key: string): Promise<void>;
}

/**
 * Thrown by enforce() when the rate limit is exceeded or Redis is unavailable.
 *
 * kind discriminator (added v1.0.0 per §5.4 brief-week5.md):
 *   'exceeded'    — key is genuinely over its limit. Map to HTTP 429.
 *   'unavailable' — Redis threw; the request may not actually be rate-limited.
 *                   Map to HTTP 503 to avoid misrepresenting infrastructure
 *                   failure as a rate-limit event.
 *
 * remaining is always 0; resetMs indicates when capacity returns (windowMs when
 * unavailable, actual window tail when exceeded).
 */
export class RateLimitError extends Error {
  readonly kind: 'exceeded' | 'unavailable';
  readonly remaining: number;
  readonly resetMs: number;

  constructor(opts: {
    message: string;
    kind: 'exceeded' | 'unavailable';
    remaining: number;
    resetMs: number;
  }) {
    super(opts.message);
    this.name = 'RateLimitError';
    this.kind = opts.kind;
    this.remaining = opts.remaining;
    this.resetMs = opts.resetMs;
  }
}
