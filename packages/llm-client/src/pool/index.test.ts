/**
 * Unit tests for @diabolicallabs/llm-client/pool — createPool + runAll.
 *
 * Coverage:
 * - createPool: returns a Pool with runAll
 * - runAll: all tasks fulfilled → results array matches order
 * - runAll: individual task errors captured as rejected, pool continues
 * - runAll: AbortSignal fires before tasks → aborted results
 * - runAll: concurrency cap enforced — max N in-flight at once
 * - runAll: onProgress called correctly (done/total counts)
 * - runAll: empty task array → empty results
 */

import { describe, expect, it, vi } from 'vitest';
import type { PoolProvider, PoolTaskWithProvider } from './index.js';
import { createPool } from './index.js';

// Helper: create a simple fulfilled task thunk for a given provider
function makeTask<T>(
  value: T,
  provider: PoolProvider = 'anthropic',
  delayMs = 0
): PoolTaskWithProvider<T> {
  return {
    task: async () => {
      if (delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
      return value;
    },
    provider,
  };
}

// Helper: create a task thunk that rejects
function makeFailingTask(
  message: string,
  provider: PoolProvider = 'anthropic'
): PoolTaskWithProvider<never> {
  return {
    task: async () => {
      throw new Error(message);
    },
    provider,
  };
}

describe('createPool', () => {
  it('returns a Pool with runAll', () => {
    const pool = createPool({});
    expect(typeof pool.runAll).toBe('function');
  });
});

describe('runAll — basic execution', () => {
  it('returns fulfilled results for all successful tasks', async () => {
    const pool = createPool({});
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const results = await pool.runAll(tasks);

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'a' });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'b' });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'c' });
  });

  it('preserves result order regardless of completion order', async () => {
    const pool = createPool({});
    // Slow first, fast second — results should still be [0]=slow, [1]=fast
    const tasks = [makeTask(0, 'anthropic', 10), makeTask(1, 'anthropic', 0)];
    const results = await pool.runAll(tasks);

    expect(results[0]).toEqual({ status: 'fulfilled', value: 0 });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 1 });
  });

  it('captures individual task errors as rejected without aborting pool', async () => {
    const pool = createPool({});
    const tasks = [makeTask('ok'), makeFailingTask('boom'), makeTask('also-ok')];
    const results = await pool.runAll(tasks);

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.any(Error) });
    if (results[1].status === 'rejected') {
      expect((results[1].reason as Error).message).toBe('boom');
    }
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'also-ok' });
  });

  it('returns empty array for empty task list', async () => {
    const pool = createPool({});
    const results = await pool.runAll([]);
    expect(results).toHaveLength(0);
  });
});

describe('runAll — AbortSignal', () => {
  it('tasks skipped when signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort('cancelled');

    let executed = 0;
    const pool = createPool({});
    const tasks: PoolTaskWithProvider<string>[] = [
      {
        task: async () => {
          executed++;
          return 'result';
        },
        provider: 'anthropic',
      },
      {
        task: async () => {
          executed++;
          return 'result2';
        },
        provider: 'anthropic',
      },
    ];

    const results = await pool.runAll(tasks, { signal: ac.signal });

    // Both tasks should be aborted (signal was already fired)
    for (const r of results) {
      expect(r.status).toBe('aborted');
    }
    expect(executed).toBe(0);
  });
});

describe('runAll — concurrency cap', () => {
  it('enforces concurrencyPerProvider — max N concurrent tasks per provider', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const cap = 2;
    const pool = createPool({
      concurrencyPerProvider: { anthropic: cap },
    });

    // 6 tasks, each holds a slot for a short time
    const tasks: PoolTaskWithProvider<number>[] = Array.from({ length: 6 }, (_, i) => ({
      task: async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise<void>((r) => setTimeout(r, 5));
        currentConcurrent--;
        return i;
      },
      provider: 'anthropic',
    }));

    await pool.runAll(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(cap);
  });

  it('different providers use separate semaphores — anthropic cap does not limit openai', async () => {
    let maxOpenAI = 0;
    let currentOpenAI = 0;

    const pool = createPool({
      concurrencyPerProvider: { anthropic: 1, openai: 4 },
    });

    const tasks: PoolTaskWithProvider<number>[] = Array.from({ length: 4 }, (_, i) => ({
      task: async () => {
        currentOpenAI++;
        maxOpenAI = Math.max(maxOpenAI, currentOpenAI);
        await new Promise<void>((r) => setTimeout(r, 5));
        currentOpenAI--;
        return i;
      },
      provider: 'openai',
    }));

    await pool.runAll(tasks);
    // OpenAI cap is 4 — all 4 should have run concurrently
    expect(maxOpenAI).toBeGreaterThanOrEqual(2); // loose bound for timing variance
  });

  it('no concurrency config = unlimited concurrency (all tasks run simultaneously)', async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    const pool = createPool({}); // no cap

    const tasks: PoolTaskWithProvider<number>[] = Array.from({ length: 5 }, (_, i) => ({
      task: async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise<void>((r) => setTimeout(r, 5));
        currentConcurrent--;
        return i;
      },
      provider: 'anthropic',
    }));

    await pool.runAll(tasks);
    // All 5 tasks should start simultaneously with no cap
    expect(maxConcurrent).toBe(5);
  });
});

describe('runAll — onProgress', () => {
  it('calls onProgress once per completed task with correct counts', async () => {
    const pool = createPool({});
    const progress: Array<[number, number]> = [];

    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    await pool.runAll(tasks, {
      onProgress: (done, total) => {
        progress.push([done, total]);
      },
    });

    expect(progress).toHaveLength(3);
    // Total is always 3
    for (const [, total] of progress) {
      expect(total).toBe(3);
    }
    // Done counts are 1, 2, 3 (in some order since tasks are parallel)
    const doneCounts = progress.map(([done]) => done).sort((a, b) => a - b);
    expect(doneCounts).toEqual([1, 2, 3]);
  });

  it('onProgress not called when no tasks provided', async () => {
    const pool = createPool({});
    const onProgress = vi.fn();
    await pool.runAll([], { onProgress });
    expect(onProgress).not.toHaveBeenCalled();
  });
});
