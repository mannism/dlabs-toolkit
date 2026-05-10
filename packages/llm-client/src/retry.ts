/**
 * Exponential backoff with full jitter — shared across all providers.
 *
 * Formula: delay = random(0, baseDelayMs * 2^attempt)
 *
 * Retryable HTTP statuses: 429 (rate limit), 502/503/504 (server errors).
 * Retryable network codes: ECONNRESET, ETIMEDOUT.
 * Non-retryable: 400 (bad request), 401/403 (auth), 404.
 *
 * v0.3.0 additions:
 *   RetryOptions.signal    — passed through to abort the loop on caller cancellation.
 *   cancellableSleep       — sleep that resolves early when the signal fires.
 *   normalizeThrownError   — gains explicit AbortError branch → kind:'cancelled', retryable:false.
 *   withRetry              — checks signal before each attempt and during backoff.
 */

import { cancellableSleep } from './abort.js';
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
  /**
   * Optional caller-supplied signal. Checked before each attempt and during backoff sleep.
   * If aborted, withRetry throws immediately with kind:'cancelled', retryable:false.
   * This is an internal detail — not part of the public LlmCallOptions API.
   */
  signal?: AbortSignal;
}

/**
 * Merge base RetryOptions with an optional caller signal.
 * Uses conditional spread to satisfy exactOptionalPropertyTypes — avoids spreading
 * `{ signal: AbortSignal | undefined }` into the strictly-typed interface.
 */
export function mergeRetryOptsWithSignal(
  base: Omit<RetryOptions, 'signal'>,
  signal: AbortSignal | undefined
): RetryOptions {
  return signal !== undefined ? { ...base, signal } : { ...base };
}

/**
 * Execute `fn` with retry logic. Wraps the result in structured error normalization.
 * `fn` receives the current attempt number (0-indexed).
 *
 * If opts.signal is provided:
 *   - Checked before each attempt: throws kind:'cancelled', retryable:false immediately.
 *   - Passed to cancellableSleep during backoff so an abort cuts the wait short.
 *   - kind:'cancelled' errors thrown by fn are never retried regardless of signal state.
 *
 * Throws LlmError after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    // Pre-attempt abort check — fail immediately without calling fn.
    if (opts.signal?.aborted === true) {
      throw new LlmError({
        message: 'llm-client: cancelled by caller',
        provider: opts.provider,
        kind: 'cancelled',
        retryable: false,
        cause: opts.signal.reason,
      });
    }

    try {
      return await fn(attempt);
    } catch (err) {
      const llmErr = normalizeThrownError(err, opts.provider);

      // Cancelled errors are never retried — propagate immediately.
      if (llmErr.kind === 'cancelled') throw llmErr;

      if (!llmErr.retryable || attempt === opts.maxRetries) {
        throw llmErr;
      }

      lastError = llmErr;
      const delayMs = computeBackoffMs(attempt, opts.baseDelayMs);
      // cancellableSleep resolves early if signal fires during backoff.
      await cancellableSleep(delayMs, opts.signal);
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

/** Normalize any thrown value into an LlmError. */
export function normalizeThrownError(err: unknown, provider: string): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof Error) {
    // AbortError branch — must be checked before generic Error handling.
    // Covers both DOMException('AbortError') from browsers/jsdom and
    // plain Error({ name: 'AbortError' }) thrown by some SDK fetch layers.
    if (
      err.name === 'AbortError' ||
      (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError')
    ) {
      return new LlmError({
        message: err.message || 'llm-client: cancelled by caller',
        provider,
        kind: 'cancelled',
        retryable: false,
        cause: err,
      });
    }

    const errWithCode = err as Error & { status?: number; statusCode?: number; code?: string };
    const statusCode = errWithCode.status ?? errWithCode.statusCode;

    // Check for retryable network error codes
    if (errWithCode.code !== undefined && isRetryableErrorCode(errWithCode.code)) {
      if (statusCode !== undefined) {
        return new LlmError({
          message: err.message,
          provider,
          statusCode,
          kind: 'network',
          retryable: true,
          cause: err,
        });
      }
      return new LlmError({ message: err.message, provider, kind: 'network', retryable: true, cause: err });
    }

    // Check for retryable HTTP status codes
    if (statusCode !== undefined) {
      const retryable = isRetryableStatus(statusCode);
      return new LlmError({
        message: err.message,
        provider,
        statusCode,
        kind: retryable ? 'http' : 'http',
        retryable,
        cause: err,
      });
    }

    return new LlmError({
      message: err.message,
      provider,
      kind: 'unknown',
      retryable: false,
      cause: err,
    });
  }

  return new LlmError({
    message: String(err),
    provider,
    kind: 'unknown',
    retryable: false,
    cause: err,
  });
}

