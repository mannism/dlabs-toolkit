# @diabolicallabs/rate-limiter

Redis sliding-window rate limiter. Lua EVAL/EVALSHA atomicity, fail-closed on Redis outage. © Diabolical Labs

## Install

```bash
pnpm add @diabolicallabs/rate-limiter
# ioredis is a peerDependency — install separately if you don't have it
pnpm add ioredis
```

## Usage

```typescript
import Redis from 'ioredis';
import { createRateLimiter, RateLimitError } from '@diabolicallabs/rate-limiter';

// Provide your existing ioredis singleton — the limiter does not manage connections
const redis = new Redis(process.env['REDIS_URL']!);

const limiter = createRateLimiter({
  redis,
  windowMs: 60_000,     // 1-minute sliding window
  maxRequests: 100,     // 100 requests per window
  keyPrefix: 'rl:api:', // optional, default: 'rl:'
});

// Non-throwing check — returns RateLimitResult
const result = await limiter.check('user:abc123');
if (!result.allowed) {
  return Response.json(
    { error: 'Rate limit exceeded' },
    { status: 429, headers: { 'Retry-After': String(Math.ceil(result.resetMs / 1000)) } }
  );
}

// Throwing enforce — useful in middleware
try {
  await limiter.enforce('ip:1.2.3.4');
} catch (err) {
  if (err instanceof RateLimitError) {
    // err.kind: 'exceeded' | 'unavailable'
    // err.remaining, err.resetMs
  }
}
```

## Multi-tier usage

Instantiate one limiter per tier:

```typescript
const freeLimiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 10 });
const paidLimiter = createRateLimiter({ redis, windowMs: 60_000, maxRequests: 1_000 });
```

## Fail-closed behavior

If Redis is unreachable, the limiter **rejects the request** by default. This is the correct behavior for any public-facing API rate limiter.

Override with `onRedisError: 'open'` to allow requests through on Redis failure (and log `RL_REDIS_ERROR`):

```typescript
const limiter = createRateLimiter({
  redis,
  windowMs: 60_000,
  maxRequests: 100,
  onRedisError: 'open', // allow through on Redis failure
});
```

## API

### `createRateLimiter(config): RateLimiter`

| Config field | Type | Default | Description |
|---|---|---|---|
| `redis` | `RedisExecutor` | required | Any object with `eval`, `evalsha`, `scriptLoad` (ioredis satisfies this) |
| `windowMs` | `number` | required | Sliding window duration in milliseconds |
| `maxRequests` | `number` | required | Max requests allowed within the window |
| `keyPrefix` | `string` | `'rl:'` | Redis key prefix |
| `onRedisError` | `'closed' \| 'open'` | `'closed'` | Fail policy on Redis error |
| `logger` | `Logger` | stdout JSON | Pluggable structured logger |

### `RateLimiter` interface

| Method | Return | Description |
|---|---|---|
| `check(key)` | `Promise<RateLimitResult>` | Returns result. Never throws. |
| `enforce(key)` | `Promise<void>` | Throws `RateLimitError` if not allowed. |

### `RateLimitResult`

```typescript
interface RateLimitResult {
  allowed: boolean;
  remaining: number; // requests remaining in the current window
  resetMs: number;   // ms until the window resets
}
```

### `RateLimitError`

```typescript
class RateLimitError extends Error {
  readonly kind: 'exceeded' | 'unavailable'; // exceeded = limit hit; unavailable = Redis error
  readonly remaining: number; // always 0
  readonly resetMs: number;   // ms until window resets
}
```

### `setRateLimiterLogger(logger: Logger): void`

Override the module-level logger. Default: structured JSON to stdout.

## RedisExecutor interface

The `redis` config option accepts any object satisfying:

```typescript
interface RedisExecutor {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  evalsha(sha: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  scriptLoad(script: string): Promise<string>;
}
```

An `ioredis` `Redis` instance satisfies this interface directly.

## Implementation notes

**Algorithm:** sliding-window-log using a Redis sorted set per key. Each request is a member with score = timestamp. On each check:

1. `TIME` — get authoritative server-side timestamp (no app-clock drift)
2. `ZREMRANGEBYSCORE` — evict entries outside the window
3. `ZCARD` — count entries in the current window
4. `ZADD` — record the request if admitted
5. `EXPIRE` — prevent idle-key memory leaks

All five operations execute in a single Lua script via `EVAL`/`EVALSHA` — atomically, with no interleaving between concurrent clients. `MULTI/EXEC` cannot provide this guarantee.

**EVALSHA optimization:** The Lua script SHA is pre-warmed at construction via `SCRIPT LOAD`. Subsequent calls use the faster `EVALSHA`. On `NOSCRIPT` (Redis script cache flushed), the limiter falls back to `EVAL` and reloads the SHA transparently.
