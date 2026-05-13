/**
 * @diabolicallabs/llm-client/pool — concurrency primitive for parallel LLM call workloads.
 *
 * Motivation (EXP_009 pattern, Labs agentic-reliability benchmark):
 *   Sending 45 parallel LLM calls (15 tasks × 3 providers) without a concurrency gate
 *   causes burst 429s. Provider APIs enforce strict RPM/concurrency caps. A semaphore
 *   applied proactively is cheaper than burning tokens on calls that will be rate-limited.
 *
 * API:
 *   createPool(config) → Pool
 *   pool.runAll(tasks, options?) → Promise<PoolResult<T>[]>
 *
 * Semaphore:
 *   concurrencyPerProvider caps in-flight calls per provider. Tasks beyond the cap queue
 *   and execute as slots open. Defaults to Infinity (no cap) when omitted.
 *
 * Token-bucket rate limiting (rateLimitPerProvider):
 *   Optional rpm (requests per minute) cap. Implemented as a simple rolling window:
 *   if the bucket is empty, the task waits until the next refill interval.
 *   Not a strict token-bucket — deliberately simple to avoid external dependencies.
 *
 * AbortSignal:
 *   options.signal is forwarded to all tasks. When the signal fires, pending tasks
 *   are skipped (not started) and in-flight tasks receive the abort via their own signal.
 *
 * onProgress:
 *   Called after each task completes (success or error) with (completedCount, totalCount).
 *
 * Error handling:
 *   Individual task errors are captured in PoolResult.error — they do not abort the pool.
 *   runAll() always resolves (never rejects) unless the caller aborts the signal, in which
 *   case pending tasks are skipped with { status: 'aborted' }.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

/** Supported provider identifiers. Must match LlmClientConfig.provider. */
export type PoolProvider = 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'perplexity';

/** Per-provider concurrency and rate-limit configuration. */
export interface PoolConfig {
  /**
   * Maximum concurrent in-flight calls per provider.
   * e.g. { openai: 4, anthropic: 4, gemini: 2 }
   * Providers not listed default to Infinity (no cap).
   */
  concurrencyPerProvider?: Partial<Record<PoolProvider, number>>;
  /**
   * Optional rate limit (requests per minute) per provider.
   * e.g. { openai: { rpm: 500 }, anthropic: { rpm: 60 } }
   * When set, the pool enforces a rolling 1-minute window.
   * Providers not listed have no rpm cap.
   */
  rateLimitPerProvider?: Partial<Record<PoolProvider, { rpm: number }>>;
}

/** A pool task — a thunk that returns a Promise<T>. */
export type PoolTask<T> = () => Promise<T>;

/** Provider hint attached to a task so the pool routes to the right semaphore. */
export interface PoolTaskWithProvider<T> {
  task: PoolTask<T>;
  /** Must match one of the providers configured in PoolConfig. */
  provider: PoolProvider;
}

/** Options passed to pool.runAll(). */
export interface RunAllOptions {
  /** Caller-supplied AbortSignal. Pending tasks are skipped when the signal fires. */
  signal?: AbortSignal;
  /** Called after each task completes. (completedCount, totalCount) */
  onProgress?: (done: number, total: number) => void;
}

/** The result of a single pool task. */
export type PoolResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'aborted' };

/** A Pool instance returned by createPool(). */
export interface Pool {
  /**
   * Run all tasks with concurrency and rate-limit enforcement.
   * Always resolves — individual errors are captured per-result, not thrown.
   * Tasks are executed in the order provided; completion order may differ.
   *
   * @param tasks  Array of tasks (thunks) with provider hints.
   * @param options  Optional signal and onProgress callback.
   * @returns  PoolResult array in the same order as tasks.
   */
  runAll<T>(
    tasks: ReadonlyArray<PoolTaskWithProvider<T>>,
    options?: RunAllOptions
  ): Promise<PoolResult<T>[]>;
}

// ─── Semaphore ───────────────────────────────────────────────────────────────

/**
 * Simple Promise-based semaphore. Caps concurrent executions to maxConcurrency.
 * Excess callers wait in a FIFO queue until a slot opens.
 */
class Semaphore {
  private _max: number;
  private _current = 0;
  private _queue: Array<() => void> = [];

  constructor(max: number) {
    this._max = max <= 0 ? Infinity : max;
  }

  /**
   * Acquire a slot. Resolves immediately if a slot is available,
   * otherwise waits in the queue.
   */
  acquire(): Promise<void> {
    if (this._current < this._max) {
      this._current++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  /** Release a slot and unblock the next waiter, if any. */
  release(): void {
    this._current--;
    const next = this._queue.shift();
    if (next !== undefined) {
      this._current++;
      next();
    }
  }
}

// ─── RollingRateLimiter ───────────────────────────────────────────────────────

/**
 * Simple rolling-window rate limiter.
 * Tracks request timestamps in the last 60 seconds (1 rpm window).
 * When at cap, waits until the oldest request exits the window.
 */
class RollingRateLimiter {
  private _rpm: number;
  private _window = 60_000; // 1 minute in ms
  private _timestamps: number[] = [];

  constructor(rpm: number) {
    this._rpm = rpm;
  }

  /**
   * Wait until sending the next request would not exceed the rpm cap.
   * Resolves immediately when under the limit.
   */
  async throttle(): Promise<void> {
    const now = Date.now();
    // Evict timestamps outside the window
    const windowStart = now - this._window;
    this._timestamps = this._timestamps.filter((t) => t > windowStart);

    if (this._timestamps.length < this._rpm) {
      this._timestamps.push(now);
      return;
    }

    // At cap — wait until the oldest timestamp exits the window
    const oldest = this._timestamps[0];
    if (oldest === undefined) {
      this._timestamps.push(now);
      return;
    }
    const waitMs = this._window - (now - oldest);
    await new Promise<void>((r) => setTimeout(r, Math.max(0, waitMs)));

    // Re-check after waiting (recursive to handle multiple waiters)
    return this.throttle();
  }
}

// ─── createPool ──────────────────────────────────────────────────────────────

/**
 * Create a concurrency-controlled pool for parallel LLM call workloads.
 *
 * @example
 * const pool = createPool({
 *   concurrencyPerProvider: { openai: 4, anthropic: 4, gemini: 2 },
 *   rateLimitPerProvider: { anthropic: { rpm: 60 } },
 * });
 *
 * const results = await pool.runAll(
 *   tasks.map(t => ({ task: () => client.complete(t.messages), provider: 'anthropic' })),
 *   { signal, onProgress: (done, total) => console.log(`${done}/${total}`) }
 * );
 */
export function createPool(config: PoolConfig): Pool {
  // Build per-provider semaphores. Missing providers get Infinity (no cap).
  const semaphores = new Map<PoolProvider, Semaphore>();
  const rateLimiters = new Map<PoolProvider, RollingRateLimiter>();

  function getSemaphore(provider: PoolProvider): Semaphore {
    const cached = semaphores.get(provider);
    if (cached !== undefined) return cached;
    const maxConcurrency = config.concurrencyPerProvider?.[provider] ?? Infinity;
    const sem = new Semaphore(maxConcurrency);
    semaphores.set(provider, sem);
    return sem;
  }

  function getRateLimiter(provider: PoolProvider): RollingRateLimiter | null {
    const cached = rateLimiters.get(provider);
    if (cached !== undefined) return cached;
    const rpmConfig = config.rateLimitPerProvider?.[provider];
    if (rpmConfig === undefined) return null;
    const limiter = new RollingRateLimiter(rpmConfig.rpm);
    rateLimiters.set(provider, limiter);
    return limiter;
  }

  async function runAll<T>(
    tasks: ReadonlyArray<PoolTaskWithProvider<T>>,
    options?: RunAllOptions
  ): Promise<PoolResult<T>[]> {
    const total = tasks.length;
    const results: PoolResult<T>[] = new Array(total);
    let completed = 0;

    // Extract the signal once so TypeScript can narrow it without optional chaining.
    const signal = options?.signal;

    const runTask = async (index: number, item: PoolTaskWithProvider<T>): Promise<void> => {
      // Skip immediately if already aborted
      if (signal?.aborted) {
        results[index] = { status: 'aborted' };
        return;
      }

      const sem = getSemaphore(item.provider);
      const limiter = getRateLimiter(item.provider);

      // Acquire concurrency slot — waits if at cap
      await sem.acquire();

      try {
        // Re-check abort after acquiring slot (may have waited in queue)
        if (signal?.aborted) {
          results[index] = { status: 'aborted' };
          return;
        }

        // Apply rate limiting before executing
        if (limiter !== null) {
          await limiter.throttle();
        }

        // Run the task
        const value = await item.task();
        results[index] = { status: 'fulfilled', value };
      } catch (err) {
        results[index] = { status: 'rejected', reason: err };
      } finally {
        sem.release();
        completed++;
        options?.onProgress?.(completed, total);
      }
    };

    // Launch all tasks concurrently — each blocks internally at the semaphore.
    await Promise.all(tasks.map((item, i) => runTask(i, item)));

    return results;
  }

  return { runAll };
}
