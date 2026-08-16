/**
 * ioredis compatibility adapter for @diabolicallabs/rate-limiter.
 *
 * ioredis has no `scriptLoad()` method — only `.script("LOAD", script)` —
 * so a raw ioredis client does not structurally satisfy RedisExecutor
 * despite being the package's own documented/expected input. fromIoredis()
 * wraps a raw ioredis client into a conforming RedisExecutor by routing
 * scriptLoad() through `.script("LOAD", ...)`; eval/evalsha pass through
 * unchanged since ioredis implements both natively.
 */

import type { RedisExecutor } from './types.js';

/**
 * Structural type for the subset of ioredis's Redis client used here. Kept
 * local rather than `import type { Redis } from 'ioredis'` so this file
 * compiles without a hard type dependency on the ioredis package — matching
 * RedisExecutor's own peerDependency-only relationship to ioredis.
 */
export interface IoredisLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  script(subcommand: 'LOAD', script: string): Promise<unknown>;
}

/**
 * Wrap a raw ioredis client into a RedisExecutor conforming to this
 * package's interface.
 *
 * @example
 * import Redis from 'ioredis';
 * import { createRateLimiter, fromIoredis } from '@diabolicallabs/rate-limiter';
 *
 * const redis = new Redis(process.env.REDIS_URL);
 * const limiter = createRateLimiter({
 *   redis: fromIoredis(redis),
 *   windowMs: 60_000,
 *   maxRequests: 100,
 * });
 */
export function fromIoredis(client: IoredisLike): RedisExecutor {
  return {
    eval: (script, numKeys, ...args) => client.eval(script, numKeys, ...args),
    evalsha: (sha, numKeys, ...args) => client.evalsha(sha, numKeys, ...args),
    scriptLoad: async (script) => {
      const sha = await client.script('LOAD', script);
      return sha as string;
    },
  };
}
