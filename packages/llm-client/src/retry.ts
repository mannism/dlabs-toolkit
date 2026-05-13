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
 *
 * v1.2.0 additions (configurable retry strategy):
 *   RetryConfig            — full retry configuration type. Accepted by LlmClientConfig.retry.
 *   RetryStrategy          — 'exponential' | 'linear' | 'fixed' | 'decorrelated'
 *   computeStrategyDelayMs — strategy-aware delay computation.
 *   RetryOptions           — gains optional retryConfig field; when present, drives strategy
 *                            selection and retryOn filtering.
 *   withRetry              — honours retryConfig.retryOn filter and per-strategy delay.
 *
 * Decorrelated formula (AWS Architecture Blog, Marc Brooker):
 *   sleep = min(cap, random_between(base, prev_sleep * 3))
 * Per-attempt prev_sleep state breaks correlation between concurrent callers that
 * started retrying at the same moment (e.g. all hitting the same 429).
 *
 * respectRetryAfter: when true, the 429 Retry-After header (integer seconds) overrides the
 * computed delay. HTTP-date format is not parsed — a TODO comment is left in the code.
 */

import { cancellableSleep } from './abort.js';
import type { LlmErrorKind, RetryConfig, RetryStrategy } from './types.js';
import { LlmError } from './types.js';

// HTTP status codes that should trigger a retry
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);

// Network error codes that should trigger a retry
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);

// HTTP status codes that should never retry (fail immediately)
const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404]);

// Default kinds that are retried when no explicit retryOn config is set
const DEFAULT_RETRY_ON: ReadonlySet<LlmErrorKind> = new Set([
  'rate_limit',
  'server_error',
  'timeout',
  'network',
]);

/**
 * Classify an HTTP status code into the refined LlmErrorKind taxonomy.
 * Exported for use by provider normalizers.
 */
export function classifyHttpStatus(statusCode: number): LlmErrorKind {
  if (statusCode === 429) return 'rate_limit';
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 400) return 'bad_request';
  if (statusCode >= 500) return 'server_error';
  // Residual fallback for unclassified 4xx (402, 405, 408, etc.)
  return 'http';
}

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

// RetryConfig and RetryStrategy are defined in types.ts to avoid circular imports.
// They are re-exported from there and imported here via the type import above.

// ─── Delay computation ───────────────────────────────────────────────────────

/** Compute the delay in ms for attempt N (0-indexed). Full jitter. */
export function computeBackoffMs(attempt: number, baseDelayMs: number): number {
  const ceiling = baseDelayMs * 2 ** attempt;
  return Math.random() * ceiling;
}

/**
 * Compute the delay for a given strategy and attempt.
 *
 * @param strategy   Which strategy to apply.
 * @param attempt    0-indexed attempt number (0 = first retry after initial failure).
 * @param base       baseDelayMs from config.
 * @param cap        maxDelayMs from config.
 * @param prevDelayMs Previous delay in ms — used only by 'decorrelated'.
 */
export function computeStrategyDelayMs(
  strategy: RetryStrategy,
  attempt: number,
  base: number,
  cap: number,
  prevDelayMs: number
): number {
  switch (strategy) {
    case 'exponential': {
      // Full jitter: random in [0, base * 2^attempt], capped at maxDelayMs
      const ceiling = Math.min(cap, base * 2 ** attempt);
      return Math.random() * ceiling;
    }

    case 'linear': {
      // Linear growth: base * (attempt + 1), capped
      return Math.min(cap, base * (attempt + 1));
    }

    case 'fixed': {
      // Constant delay, always base (capped for safety)
      return Math.min(cap, base);
    }

    case 'decorrelated': {
      // AWS decorrelated jitter (Marc Brooker, AWS Architecture Blog):
      // sleep = min(cap, random_between(base, prev_sleep * 3))
      // On attempt 0, prev is base so the range is [base, base*3].
      const lo = base;
      const hi = Math.max(lo, prevDelayMs * 3);
      return Math.min(cap, lo + Math.random() * (hi - lo));
    }
  }
}

// ─── RetryOptions ────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum retries (maxAttempts - 1). Legacy field kept for backwards compat. */
  maxRetries: number;
  baseDelayMs: number;
  provider: string;
  /**
   * Optional caller-supplied signal. Checked before each attempt and during backoff sleep.
   * If aborted, withRetry throws immediately with kind:'cancelled', retryable:false.
   * This is an internal detail — not part of the public LlmCallOptions API.
   */
  signal?: AbortSignal;
  /**
   * Full retry configuration from LlmClientConfig.retry (v1.2.0+).
   * When present, drives strategy selection, maxDelayMs cap, respectRetryAfter,
   * and retryOn kind filtering.
   * When absent, legacy exponential + full-jitter behavior applies.
   */
  retryConfig?: RetryConfig;
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

// ─── withRetry ───────────────────────────────────────────────────────────────

/**
 * Execute `fn` with retry logic. Wraps the result in structured error normalization.
 * `fn` receives the current attempt number (0-indexed).
 *
 * Strategy selection (v1.2.0):
 *   When opts.retryConfig is present:
 *     - opts.retryConfig.maxAttempts overrides opts.maxRetries (converted: maxRetries = maxAttempts - 1).
 *     - opts.retryConfig.strategy selects the delay formula.
 *     - opts.retryConfig.retryOn filters which error kinds are retried.
 *     - opts.retryConfig.respectRetryAfter reads Retry-After headers on rate_limit errors.
 *   When opts.retryConfig is absent, legacy exponential behavior applies (no change).
 *
 * Signal handling:
 *   If opts.signal is provided:
 *     - Checked before each attempt: throws kind:'cancelled', retryable:false immediately.
 *     - Passed to cancellableSleep during backoff so an abort cuts the wait short.
 *     - kind:'cancelled' errors thrown by fn are never retried regardless of signal state.
 *
 * Throws LlmError after all retries are exhausted.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  const cfg = opts.retryConfig;

  // Resolve effective maxRetries from RetryConfig.maxAttempts when present.
  // maxAttempts:1 means no retries; maxAttempts:4 means 3 retries.
  const effectiveMaxRetries =
    cfg?.maxAttempts !== undefined ? Math.max(0, cfg.maxAttempts - 1) : opts.maxRetries;

  const strategy: RetryStrategy = cfg?.strategy ?? 'exponential';
  const base = cfg?.baseDelayMs ?? opts.baseDelayMs;
  const cap = cfg?.maxDelayMs ?? 30_000;
  // retryOn filtering only applies when the caller has opted in via retryConfig.
  // In legacy mode (no retryConfig), the retryable flag alone controls retry — no kind filter.
  const retryOnSet: ReadonlySet<LlmErrorKind> | null =
    cfg !== undefined
      ? cfg.retryOn !== undefined
        ? new Set(cfg.retryOn)
        : DEFAULT_RETRY_ON
      : null;

  // Per-attempt previous delay — only used by 'decorrelated', starts at base.
  let prevDelayMs = base;

  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
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

      // RetryConfig.retryOn filter: if the kind is not in the allow-set, don't retry.
      // null = legacy mode (no retryConfig) — kind filter is bypassed, retryable flag only.
      const kindAllowed = retryOnSet === null || retryOnSet.has(llmErr.kind);

      if (!llmErr.retryable || !kindAllowed || attempt === effectiveMaxRetries) {
        throw llmErr;
      }

      lastError = llmErr;

      // Compute delay — check respectRetryAfter first for rate_limit errors.
      let delayMs: number;
      if (
        cfg?.respectRetryAfter === true &&
        llmErr.kind === 'rate_limit' &&
        llmErr.headers !== undefined
      ) {
        const retryAfterHeader = llmErr.headers['retry-after'];
        if (retryAfterHeader !== undefined) {
          const parsed = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsed) && parsed >= 0) {
            // Header is integer seconds — convert to ms and cap at maxDelayMs
            delayMs = Math.min(cap, parsed * 1000);
          } else {
            // TODO: parse HTTP-date format (RFC 7231) if encountered
            delayMs = computeStrategyDelayMs(strategy, attempt, base, cap, prevDelayMs);
          }
        } else {
          delayMs = computeStrategyDelayMs(strategy, attempt, base, cap, prevDelayMs);
        }
      } else {
        delayMs = computeStrategyDelayMs(strategy, attempt, base, cap, prevDelayMs);
      }

      prevDelayMs = delayMs;

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

// ─── normalizeThrownError ────────────────────────────────────────────────────

/** Normalize any thrown value into an LlmError. */
export function normalizeThrownError(err: unknown, provider: string): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof Error) {
    // AbortError branch — must be checked before generic Error handling.
    // Covers both DOMException('AbortError') from browsers/jsdom and
    // plain Error({ name: 'AbortError' }) thrown by some SDK fetch layers.
    if (
      err.name === 'AbortError' ||
      (typeof DOMException !== 'undefined' &&
        err instanceof DOMException &&
        err.name === 'AbortError')
    ) {
      return new LlmError({
        message: err.message || 'llm-client: cancelled by caller',
        provider,
        kind: 'cancelled',
        retryable: false,
        cause: err,
      });
    }

    const errWithCode = err as Error & {
      status?: number;
      statusCode?: number;
      code?: string;
      headers?: Record<string, string>;
    };
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
      return new LlmError({
        message: err.message,
        provider,
        kind: 'network',
        retryable: true,
        cause: err,
      });
    }

    // Check for HTTP status codes — classify to specific kind
    if (statusCode !== undefined) {
      return new LlmError({
        message: err.message,
        provider,
        statusCode,
        kind: classifyHttpStatus(statusCode),
        retryable: isRetryableStatus(statusCode),
        // Preserve headers for respectRetryAfter support.
        // Conditional spread avoids spreading `{ headers: undefined }` which
        // violates exactOptionalPropertyTypes.
        ...(errWithCode.headers !== undefined && { headers: errWithCode.headers }),
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
