/**
 * @diabolicallabs/rate-limiter
 *
 * Redis sliding-window rate limiter.
 * Implementation: sorted set per key — ZREMRANGEBYSCORE to evict expired
 * entries, ZCARD to count the window, ZADD to record the request.
 * All three ops in a single pipeline for atomicity.
 *
 * Fail-closed: if the Redis connection throws, check() returns
 * { allowed: false } and enforce() throws RateLimitError.
 * Never default to permissive on infrastructure failure.
 *
 * ioredis is a peerDependency — caller provides the Redis singleton.
 * This prevents duplicate Redis clients and makes the limiter testable
 * without mocking module resolution.
 *
 * Implementation begins Week 5 (parallel with @diabolicallabs/notion).
 * This file exports the public type surface only.
 */

// Factory function
export { createRateLimiter } from './limiter.js';

// Error class — exported as value
export { RateLimitError } from './types.js';

// Types
export type { RateLimiterConfig } from './types.js';
export type { RateLimitResult } from './types.js';
export type { RateLimiter } from './types.js';
