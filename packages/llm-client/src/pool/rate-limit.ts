/**
 * Token-bucket rate limiter.
 *
 * Models a token bucket: the bucket fills at a constant rate (rpm converted to
 * tokens-per-ms) up to a capacity equal to the configured rpm value. Each call
 * consumes 1 token. If the bucket is empty, acquire() sleeps until enough tokens
 * have refilled to grant the request.
 *
 * This is proactive — it delays calls before they hit the provider, rather than
 * waiting for a 429 response. Pairs with the reactive retry/backoff in withRetry().
 *
 * Implementation notes:
 *  - No timer is kept open between calls; refill is computed lazily on acquire().
 *  - Fractional tokens are tracked to handle sub-ms fill rates correctly.
 *  - When rpm is 0, the rate limiter is unlimited (acquire() resolves immediately).
 */
export class TokenBucketRateLimiter {
  private readonly fillRatePerMs: number; // tokens added per millisecond
  private readonly capacity: number; // max tokens (= rpm)
  private tokens: number; // current token count (fractional)
  private lastRefillAt: number; // timestamp of last refill (ms since epoch)

  /**
   * @param rpm Requests per minute. Pass 0 for unlimited.
   */
  constructor(rpm: number) {
    this.capacity = rpm;
    this.fillRatePerMs = rpm / 60_000; // convert rpm → tokens per ms
    this.tokens = rpm; // start full
    this.lastRefillAt = Date.now();
  }

  /**
   * Acquire one token. Resolves immediately if a token is available.
   * If the bucket is empty, sleeps until one token refills.
   * Never throws.
   */
  async acquire(): Promise<void> {
    // Unlimited mode: resolve immediately
    if (this.capacity <= 0) return;

    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Compute how many ms until 1 token is available
    const msUntilToken = (1 - this.tokens) / this.fillRatePerMs;
    await sleep(msUntilToken);
    this.refill();
    this.tokens -= 1;
  }

  /**
   * Recompute token count based on elapsed time since last refill.
   * Caps at capacity to prevent burst accumulation beyond the configured limit.
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.fillRatePerMs);
    this.lastRefillAt = now;
  }
}

/** Promise-based sleep. Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
