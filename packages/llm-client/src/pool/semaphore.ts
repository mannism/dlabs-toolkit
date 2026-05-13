/**
 * Counting semaphore for concurrency control.
 *
 * acquire() returns a release function. The caller must invoke release() when
 * the guarded work completes (including on error — use try/finally).
 *
 * When concurrency is 0 or negative, the semaphore allows unlimited concurrent
 * callers (i.e., acquire() resolves immediately and release() is a no-op).
 *
 * Implementation: waiters are queued in a FIFO list. Each waiter is a resolve
 * function from a Promise; resolve() is called when a slot opens. No timers.
 * No dependencies outside Node built-ins.
 */
export class Semaphore {
  private readonly limit: number;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  /**
   * @param limit Maximum number of concurrent holders.
   *              Pass 0 (or negative) for unlimited — useful when no cap is configured.
   */
  constructor(limit: number) {
    this.limit = limit;
  }

  /**
   * Acquire a slot. Resolves when a slot is available.
   * Returns a release function — must be called (even on error) to free the slot.
   */
  acquire(): Promise<() => void> {
    // Unlimited mode: resolve immediately with a no-op release
    if (this.limit <= 0) {
      return Promise.resolve(() => {});
    }

    return new Promise<() => void>((resolve) => {
      const tryAcquire = (): void => {
        if (this.running < this.limit) {
          this.running++;
          resolve(() => this.release());
        } else {
          this.queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  /**
   * Release a slot. Dequeues the next waiter if one is waiting.
   * Private — callers use the release function returned by acquire().
   */
  private release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    }
  }

  /** Current number of active holders (for testing / observability). */
  get activeCount(): number {
    return this.running;
  }

  /** Current number of waiters in the queue (for testing / observability). */
  get pendingCount(): number {
    return this.queue.length;
  }
}
