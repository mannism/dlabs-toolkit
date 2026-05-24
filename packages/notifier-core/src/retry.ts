/**
 * retryWithJitter — full-jitter exponential backoff helper.
 *
 * Formula: delay = min(capDelayMs, baseDelayMs * 2^n) * random(0, 1)
 * (AWS "Full Jitter" recommendation — prevents thundering herd on concurrent failures)
 *
 * Used internally by @diabolicallabs/slack and @diabolicallabs/telegram. Also exported
 * for consumers who want to wrap their own async operations with the same pattern.
 */

/** Promisified sleep. Used by retryWithJitter. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute the next jittered delay for attempt n (0-indexed).
 * Exported for testing.
 */
export function computeJitter(attempt: number, baseDelayMs: number, capDelayMs: number): number {
  const ceiling = Math.min(capDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * ceiling;
}

/**
 * Retry an async operation with full-jitter exponential backoff.
 *
 * @param fn          - The async operation to retry.
 * @param options     - Retry configuration.
 * @returns           - The resolved value from the first successful call.
 * @throws            - The last error if maxRetries is exhausted, or any
 *                      error for which isRetryable returns false.
 *
 * @example
 * const result = await retryWithJitter(
 *   () => fetch('https://api.example.com/send', { method: 'POST' }),
 *   {
 *     maxRetries: 3,
 *     baseDelayMs: 250,
 *     capDelayMs: 2000,
 *     isRetryable: (err) => err instanceof NetworkError,
 *     onRetry: (err, attempt, delayMs) =>
 *       logger.warn('RETRY', { attempt, delayMs }),
 *   },
 * );
 */
export async function retryWithJitter<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number; // default: 3
    baseDelayMs: number; // default: 250
    capDelayMs: number; // default: 2000
    isRetryable: (err: unknown) => boolean;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  }
): Promise<T> {
  const { maxRetries, baseDelayMs, capDelayMs, isRetryable, onRetry } = options;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Never retry non-retryable errors, or once all attempts are spent
      if (!isRetryable(err) || attempt === maxRetries) {
        throw err;
      }

      const delayMs = computeJitter(attempt, baseDelayMs, capDelayMs);
      onRetry?.(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  // Unreachable, but satisfies the type-checker.
  throw lastErr;
}
