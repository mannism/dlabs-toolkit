/**
 * Core type definitions for @diabolicallabs/rate-limiter.
 * Matches the spec in briefs/brief-platform.md §4.4.
 */

import type { Redis } from 'ioredis';

export interface RateLimiterConfig {
  redis: Redis; // caller provides the ioredis singleton — not bundled
  keyPrefix?: string; // default: 'rl:'
  windowMs: number; // sliding window duration in milliseconds
  maxRequests: number; // max requests allowed within the window
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number; // requests remaining in the current window
  resetMs: number; // ms until the oldest entry expires from the window
}

export interface RateLimiter {
  // Check whether the key is within its rate limit.
  // Fail-closed: returns { allowed: false } if Redis throws.
  check(key: string): Promise<RateLimitResult>;

  // Convenience: throws RateLimitError if the key is over limit.
  // Fail-closed: throws RateLimitError if Redis throws.
  enforce(key: string): Promise<void>;
}

// Error thrown by enforce() when the rate limit is exceeded or Redis is unavailable
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
