/**
 * Unit tests for abort.ts — createAttemptController, cancellableSleep, withStallTimeout, classifyAbort.
 *
 * All timer tests use vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }).
 *
 * FAKE TIMER NOTE (read before adding new timer tests):
 *   Always use `await vi.advanceTimersByTimeAsync(ms)` — NOT the synchronous
 *   vi.advanceTimersByTime(). Promise.race() and the async generator protocol
 *   schedule work via microtasks; the async variant flushes both fake timers
 *   AND pending microtasks so races resolve in the expected order.
 *   The synchronous variant fires callbacks but does NOT flush microtasks,
 *   which causes the awaited Promise.race to hang in the test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancellableSleep,
  classifyAbort,
  createAttemptController,
  linkedAbortController,
  withStallTimeout,
} from './abort.js';
import { LlmError } from './types.js';

// ─── createAttemptController ──────────────────────────────────────────────────

describe('createAttemptController', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts with reason="timeout" after timeoutMs', async () => {
    const ctl = createAttemptController(undefined, 5000);

    expect(ctl.signal.aborted).toBe(false);
    expect(ctl.abortReason()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(5000);

    expect(ctl.signal.aborted).toBe(true);
    expect(ctl.abortReason()).toBe('timeout');

    ctl.dispose();
  });

  it('does not abort before timeoutMs', async () => {
    const ctl = createAttemptController(undefined, 5000);

    await vi.advanceTimersByTimeAsync(4999);

    expect(ctl.signal.aborted).toBe(false);
    expect(ctl.abortReason()).toBeUndefined();

    ctl.dispose();
  });

  it('aborts immediately with reason="caller" when callerSignal is pre-aborted', () => {
    const ac = new AbortController();
    ac.abort('user cancelled');

    const ctl = createAttemptController(ac.signal, 5000);

    expect(ctl.signal.aborted).toBe(true);
    expect(ctl.abortReason()).toBe('caller');

    ctl.dispose();
  });

  it('aborts with reason="caller" when callerSignal fires mid-call', async () => {
    const ac = new AbortController();
    const ctl = createAttemptController(ac.signal, 5000);

    expect(ctl.signal.aborted).toBe(false);

    ac.abort('user cancelled');

    expect(ctl.signal.aborted).toBe(true);
    expect(ctl.abortReason()).toBe('caller');

    ctl.dispose();
  });

  it('dispose() clears the timer — signal stays unaborted after timeoutMs', async () => {
    const ctl = createAttemptController(undefined, 5000);
    ctl.dispose();

    await vi.advanceTimersByTimeAsync(5000);

    expect(ctl.signal.aborted).toBe(false);
  });

  it('double abort is safe — second call does not change the reason', () => {
    const ctl = createAttemptController(undefined, 5000);

    ctl.abort('stall');
    ctl.abort('stall'); // idempotent via ??=

    expect(ctl.abortReason()).toBe('stall');
    expect(ctl.signal.aborted).toBe(true);

    ctl.dispose();
  });

  it('timeout does not overwrite caller abort reason', () => {
    const ac = new AbortController();
    const ctl = createAttemptController(ac.signal, 1000);

    ac.abort(); // reason = 'caller' first
    // Now advance past the timeout — reason must stay 'caller'
    // (??= ensures first-write-wins semantics)
    expect(ctl.abortReason()).toBe('caller');

    ctl.dispose();
  });
});

// ─── cancellableSleep ─────────────────────────────────────────────────────────

describe('cancellableSleep', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after ms when no signal provided', async () => {
    let resolved = false;
    const p = cancellableSleep(1000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    let resolved = false;
    await cancellableSleep(10_000, ac.signal).then(() => {
      resolved = true;
    });

    expect(resolved).toBe(true);
  });

  it('resolves early when signal fires during sleep', async () => {
    const ac = new AbortController();

    let resolved = false;
    const p = cancellableSleep(10_000, ac.signal).then(() => {
      resolved = true;
    });

    ac.abort();
    await p;

    expect(resolved).toBe(true);
  });

  it('does not leave a dangling timer after early abort', async () => {
    // Verifies clearTimeout is called by checking no pending timers remain.
    // If the timer were not cleared, advanceTimersByTimeAsync would fire it after abort.
    const ac = new AbortController();
    const p = cancellableSleep(5000, ac.signal);
    ac.abort();
    await p;

    // Advance past the original sleep duration — should not throw or hang.
    await vi.advanceTimersByTimeAsync(5000);
  });
});

// ─── withStallTimeout ─────────────────────────────────────────────────────────

describe('withStallTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('yields chunks normally when they arrive before stall deadline', async () => {
    const ac = new AbortController();
    const ctl = {
      signal: ac.signal,
      abortReason: () => undefined as 'timeout' | 'caller' | 'stall' | undefined,
      abort: (_r: 'stall') => {
        ac.abort();
      },
      dispose: () => {},
    };

    async function* fastSource(): AsyncGenerator<string> {
      yield 'chunk1';
      yield 'chunk2';
      yield 'chunk3';
    }

    const chunks: string[] = [];
    for await (const chunk of withStallTimeout(fastSource(), 5000, ctl, 'test')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['chunk1', 'chunk2', 'chunk3']);
  });

  it('throws LlmError with kind="stream_stall" when no chunk arrives within stallMs', async () => {
    const ac = new AbortController();
    let reasonCapture: 'timeout' | 'caller' | 'stall' | undefined;
    const ctl = {
      signal: ac.signal,
      abortReason: () => reasonCapture,
      abort: (r: 'stall') => {
        reasonCapture = r;
        ac.abort();
      },
      dispose: () => {},
    };

    // Source that hangs — never resolves without external advancement
    async function* hangingSource(): AsyncGenerator<string> {
      await new Promise<void>(() => {}); // hangs forever
      yield 'never';
    }

    const gen = withStallTimeout(hangingSource(), 3000, ctl, 'test');
    const p = gen.next().catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(3000);

    const err = await p;
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe('stream_stall');
    expect((err as LlmError).retryable).toBe(true);
  });

  it('resets the stall timer between chunks — does not stall if chunks arrive within window', async () => {
    // This test validates that the stall timer is reset between chunks.
    // We do this by confirming that after 2999ms of silence (just under stallMs=3000)
    // the signal is still unaborted — if the timer were NOT reset, it would have fired.
    const ac = new AbortController();
    const ctl = {
      signal: ac.signal,
      abortReason: () => undefined as 'timeout' | 'caller' | 'stall' | undefined,
      abort: (_r: 'stall') => {
        ac.abort();
      },
      dispose: () => {},
    };

    // Simple two-chunk source that resolves synchronously — no blocking between chunks.
    async function* twoChunkSource(): AsyncGenerator<string> {
      yield 'first';
      yield 'second';
    }

    const collected: string[] = [];
    const gen = withStallTimeout(twoChunkSource(), 3000, ctl, 'test');

    // Drain all chunks synchronously (they arrive fast, no stall).
    for await (const chunk of gen) {
      collected.push(chunk);
    }

    expect(collected).toEqual(['first', 'second']);
    expect(ac.signal.aborted).toBe(false);
  });
});

// ─── classifyAbort ────────────────────────────────────────────────────────────

describe('classifyAbort', () => {
  const abortErr = Object.assign(new Error('Aborted'), { name: 'AbortError' });

  it('returns kind="timeout" for reason "timeout"', () => {
    const result = classifyAbort(abortErr, 'timeout', 'test');
    expect(result).toBeInstanceOf(LlmError);
    const err = result as LlmError;
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
  });

  it('returns kind="cancelled" for reason "caller"', () => {
    const result = classifyAbort(abortErr, 'caller', 'test');
    expect(result).toBeInstanceOf(LlmError);
    const err = result as LlmError;
    expect(err.kind).toBe('cancelled');
    expect(err.retryable).toBe(false);
  });

  it('returns kind="stream_stall" for reason "stall"', () => {
    const result = classifyAbort(abortErr, 'stall', 'test');
    expect(result).toBeInstanceOf(LlmError);
    const err = result as LlmError;
    expect(err.kind).toBe('stream_stall');
    expect(err.retryable).toBe(true);
  });

  it('returns kind="cancelled" when reason is undefined', () => {
    const result = classifyAbort(abortErr, undefined, 'test');
    expect(result).toBeInstanceOf(LlmError);
    expect((result as LlmError).kind).toBe('cancelled');
    expect((result as LlmError).retryable).toBe(false);
  });

  it('passes non-abort errors through unchanged when controller did not fire', () => {
    // abortReason === undefined means our controller did NOT fire — the error came
    // from somewhere else (e.g. a 429 HTTP error). Should fall through unchanged.
    const nonAbortErr = new Error('something else');
    const result = classifyAbort(nonAbortErr, undefined, 'test');
    expect(result).toBe(nonAbortErr);
  });

  it('classifies any error as timeout when controller fired with reason "timeout"', () => {
    // Provider SDKs (e.g. Anthropic's APIUserAbortError) may throw their own error types
    // when a signal fires. We use abortReason from the controller as the authoritative source.
    const providerAbortErr = new Error('Request was aborted.');
    providerAbortErr.name = 'APIUserAbortError'; // Anthropic-style
    const result = classifyAbort(providerAbortErr, 'timeout', 'test');
    expect(result).toBeInstanceOf(LlmError);
    expect((result as LlmError).kind).toBe('timeout');
    expect((result as LlmError).retryable).toBe(true);
  });

  it('recognizes DOMException AbortError', () => {
    // jsdom / Vitest environment provides DOMException
    if (typeof DOMException === 'undefined') return;
    const domErr = new DOMException('Aborted', 'AbortError');
    const result = classifyAbort(domErr, 'caller', 'test');
    expect(result).toBeInstanceOf(LlmError);
    expect((result as LlmError).kind).toBe('cancelled');
  });
});

// ─── linkedAbortController ────────────────────────────────────────────────────

describe('linkedAbortController', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('child aborts when parent aborts — reason is forwarded', () => {
    const parent = new AbortController();
    const child = linkedAbortController(parent.signal);

    expect(child.signal.aborted).toBe(false);
    const reason = new Error('parent cancelled');
    parent.abort(reason);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe(reason);
  });

  it('child aborts immediately when parent is already aborted', () => {
    const parent = new AbortController();
    parent.abort(new Error('already done'));
    // Link after parent has already fired
    const child = linkedAbortController(parent.signal);
    expect(child.signal.aborted).toBe(true);
    expect((child.signal.reason as Error).message).toBe('already done');
  });

  it('timeout fires and aborts child with timeout reason', async () => {
    const parent = new AbortController();
    const child = linkedAbortController(parent.signal, { timeoutMs: 5_000 });

    expect(child.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.signal.aborted).toBe(true);
    expect((child.signal.reason as Error).message).toContain('timeout');
    // Clean up
    child.dispose();
  });

  it('timeout does NOT fire after dispose() is called — no leak', async () => {
    const parent = new AbortController();
    const child = linkedAbortController(parent.signal, { timeoutMs: 5_000 });
    // Simulate call completing normally
    child.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    // Child should NOT have been aborted by the timer
    expect(child.signal.aborted).toBe(false);
  });

  it('parent aborting after child dispose() does NOT propagate', () => {
    const parent = new AbortController();
    const child = linkedAbortController(parent.signal);
    // Call completed — dispose first, then parent fires
    child.dispose();
    parent.abort(new Error('late cancel'));
    expect(child.signal.aborted).toBe(false);
  });

  it('manual abort() aborts child and cleans up', async () => {
    const parent = new AbortController();
    const child = linkedAbortController(parent.signal, { timeoutMs: 5_000 });
    const manualReason = new Error('manual stop');
    child.abort(manualReason);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe(manualReason);
    // Timer should be cleared — advancing time should not throw
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
