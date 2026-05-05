/**
 * Exponential backoff with full jitter — shared across all providers.
 *
 * Formula: delay = random(0, baseDelayMs * 2^attempt)
 *
 * Retryable HTTP statuses: 429 (rate limit), 502/503/504 (server errors).
 * Retryable network codes: ECONNRESET, ETIMEDOUT.
 * Non-retryable: 400 (bad request), 401/403 (auth), 404.
 */

import { LlmError } from './types.js';

// HTTP status codes that should trigger a retry
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

// Network error codes that should trigger a retry
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);

// HTTP status codes that should never retry (fail immediately)
const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404]);

/** Determine if an HTTP status code is retryable. */
export function isRetryableStatus(statusCode: number): boolean {
  if (RETRYABLE_HTTP_STATUSES.has(statusCode)) return true;
  if (NON_RETRYABLE_HTTP_STATUSES.has(statusCode)) return false;
  // Treat any 5xx not explicitly handled as retryable
  return statusCode >= 500;
}

/** Determine if a network error code is retryable. */
export function isRetryableErrorCode(code: string): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

/** Compute the delay in ms for attempt N (0-indexed). Full jitter. */
export function computeBackoffMs(attempt: number, baseDelayMs: number): number {
  const ceiling = baseDelayMs * 2 ** attempt;
  return Math.random() * ceiling;
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  provider: string;
}

/**
 * Execute `fn` with retry logic. Wraps the result in structured error normalisation.
 * `fn` receives the current attempt number (0-indexed).
 *
 * Throws LlmError after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const llmErr = normaliseThrownError(err, opts.provider);

      if (!llmErr.retryable || attempt === opts.maxRetries) {
        throw llmErr;
      }

      lastError = llmErr;
      const delayMs = computeBackoffMs(attempt, opts.baseDelayMs);
      await sleep(delayMs);
    }
  }

  // This path is unreachable — the loop always throws or returns.
  // TypeScript needs this for exhaustiveness.
  throw (
    lastError ??
    new LlmError({
      message: 'Unexpected retry exhaustion',
      provider: opts.provider,
      retryable: false,
    })
  );
}

/** Normalise any thrown value into an LlmError. */
export function normaliseThrownError(err: unknown, provider: string): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof Error) {
    const errWithCode = err as Error & { status?: number; statusCode?: number; code?: string };

    const statusCode = errWithCode.status ?? errWithCode.statusCode;

    // Check for retryable network error codes
    if (errWithCode.code !== undefined && isRetryableErrorCode(errWithCode.code)) {
      if (statusCode !== undefined) {
        return new LlmError({
          message: err.message,
          provider,
          statusCode,
          retryable: true,
          cause: err,
        });
      }
      return new LlmError({ message: err.message, provider, retryable: true, cause: err });
    }

    // Check for retryable HTTP status codes
    if (statusCode !== undefined) {
      return new LlmError({
        message: err.message,
        provider,
        statusCode,
        retryable: isRetryableStatus(statusCode),
        cause: err,
      });
    }

    return new LlmError({
      message: err.message,
      provider,
      retryable: false,
      cause: err,
    });
  }

  return new LlmError({
    message: String(err),
    provider,
    retryable: false,
    cause: err,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
