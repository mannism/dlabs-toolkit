/**
 * Abort machinery for @diabolicallabs/llm-client.
 *
 * Provides per-attempt cancellation combining:
 *   - An internal AbortController per attempt (fresh deadline each retry)
 *   - Optional caller-supplied AbortSignal forwarded into the internal controller
 *   - Explicit reason tracking ('timeout' | 'caller' | 'stall') so errors can be
 *     classified before they reach normalizeThrownError
 *
 * Three primary exports:
 *   createAttemptController — combine caller signal + timeout into one AbortSignal
 *   cancellableSleep        — sleep that aborts early on signal
 *   withStallTimeout        — async-iterator wrapper that fires on chunk silence
 *   classifyAbort           — map an AbortError to LlmError with the right kind
 *
 * Design: hand-rolled signal composition (no AbortSignal.any) to avoid requiring
 * Node ≥ 22.0.0 where AbortSignal.any first appeared.
 */

import { LlmError } from './types.js';

// ─── AttemptController ──────────────────────────────────────────────────────

export interface AttemptController {
  /** Combined signal to pass to SDK calls. Aborts when timeout fires or caller cancels. */
  signal: AbortSignal;
  /** Returns the abort reason once the signal fires, or undefined if still live. */
  abortReason: () => 'timeout' | 'caller' | 'stall' | undefined;
  /** Abort from the stream-stall wrapper. */
  abort: (reason: 'stall') => void;
  /** Cancel the timeout timer and remove the caller-signal listener. Call in finally. */
  dispose: () => void;
}

/**
 * Construct a per-attempt AbortController that fires after timeoutMs, or immediately
 * if the caller's signal is already aborted, or whenever the caller's signal fires.
 *
 * Call dispose() in the finally block of every attempt to avoid timer leaks.
 */
export function createAttemptController(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number
): AttemptController {
  const internal = new AbortController();
  let reason: 'timeout' | 'caller' | 'stall' | undefined;

  // Timeout fires after timeoutMs. unref() so the timer does not prevent Node exit.
  const timer = setTimeout(() => {
    reason ??= 'timeout';
    internal.abort(new Error('llm-client: timeout'));
  }, timeoutMs);
  // Node.js Timer has unref(); browser setTimeout does not — guard safely.
  (timer as unknown as { unref?: () => void }).unref?.();

  // Forward the caller signal into our internal controller.
  const onCallerAbort = (): void => {
    reason ??= 'caller';
    internal.abort(callerSignal!.reason);
  };

  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      // Already aborted — fire synchronously so the check-before-SDK-call path works.
      onCallerAbort();
    } else {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
  }

  return {
    signal: internal.signal,
    abortReason: () => reason,
    abort: (r) => {
      reason ??= r;
      internal.abort();
    },
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

// ─── cancellableSleep ────────────────────────────────────────────────────────

/**
 * Sleep for ms milliseconds. Rejects early (without error — just resolves early)
 * if signal fires. Timer is always cleared on resolution to avoid leaks.
 *
 * Used by withRetry backoff so a cancelled request does not burn delay time.
 */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── withStallTimeout ────────────────────────────────────────────────────────

/**
 * Wrap an async iterable with a per-chunk stall timer. If no chunk arrives within
 * stallMs, the controller is aborted (which propagates to the SDK and frees its
 * socket) and an LlmError with kind:'stream_stall' is thrown.
 *
 * The stall timer is reset on each successful yield so reasoning-model think-pauses
 * do not trip the detector as long as chunks keep arriving before the deadline.
 *
 * Stream stall is NOT retried — partial output is unsafe to re-issue. The caller
 * receives kind:'stream_stall' and must decide how to recover.
 *
 * @param source    The SDK async iterator to wrap.
 * @param stallMs   Milliseconds of silence before declaring a stall.
 * @param ctl       The AttemptController for this stream attempt.
 * @param provider  Provider name for error classification.
 */
export async function* withStallTimeout<T>(
  source: AsyncIterable<T>,
  stallMs: number,
  ctl: AttemptController,
  provider: string
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();

  while (true) {
    // Race the next chunk against a stall timer.
    // Important: we must use vi.advanceTimersByTimeAsync in tests, not the sync variant,
    // because Promise.race() involves microtask scheduling — the async variant flushes both
    // timers and pending microtasks so the race resolves correctly in fake-timer environments.
    let stallTimer!: ReturnType<typeof setTimeout>;

    const stallPromise = new Promise<never>((_, reject) => {
      stallTimer = setTimeout(() => {
        ctl.abort('stall');
        reject(
          new LlmError({
            provider,
            kind: 'stream_stall',
            retryable: true,
            message: `llm-client: no chunk for ${stallMs}ms`,
          })
        );
      }, stallMs);
    });

    try {
      const next = await Promise.race([it.next(), stallPromise]);
      clearTimeout(stallTimer);
      if (next.done) return;
      yield next.value;
    } catch (err) {
      clearTimeout(stallTimer);
      throw err;
    }
  }
}

// ─── classifyAbort ───────────────────────────────────────────────────────────

/**
 * Map a thrown error to an LlmError with the right kind discriminator.
 *
 * If the error is an AbortError (name === 'AbortError' or DOMException with
 * AbortError name OR any error thrown when the controller's signal is already
 * aborted), we look up the abort reason from the AttemptController:
 *   'timeout' → kind:'timeout', retryable:true
 *   'caller'  → kind:'cancelled', retryable:false
 *   'stall'   → kind:'stream_stall', retryable:true
 *   undefined → kind:'cancelled', retryable:false (unknown abort)
 *
 * Note: provider SDKs may throw their own error types (e.g. Anthropic's
 * APIUserAbortError) when a signal fires. We use the controller's abortReason
 * as the authoritative source rather than relying solely on error.name.
 *
 * Non-abort errors where the signal has NOT fired fall through unchanged so
 * existing normalization paths handle them.
 */
export function classifyAbort(
  err: unknown,
  abortReason: ReturnType<AttemptController['abortReason']>,
  provider: string
): unknown {
  // Primary check: our controller fired — use the reason regardless of error type.
  // This handles provider-specific abort errors (e.g. Anthropic APIUserAbortError).
  const controllerFired = abortReason !== undefined;
  if (!controllerFired && !isAbortError(err)) return err;

  switch (abortReason) {
    case 'timeout':
      return new LlmError({
        message: 'llm-client: request timed out',
        provider,
        kind: 'timeout',
        retryable: true,
        cause: err,
      });
    case 'stall':
      return new LlmError({
        message: 'llm-client: stream stalled',
        provider,
        kind: 'stream_stall',
        retryable: true,
        cause: err,
      });
    case 'caller':
    default:
      return new LlmError({
        message: 'llm-client: cancelled by caller',
        provider,
        kind: 'cancelled',
        retryable: false,
        cause: err,
      });
  }
}

/** Returns true if the thrown value is a DOM/Node AbortError. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError')
    return true;
  return false;
}
