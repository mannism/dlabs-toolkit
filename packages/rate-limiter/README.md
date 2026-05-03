# @diabolicallabs/rate-limiter

Redis sliding-window rate limiter. Sorted-set pipeline, fail-closed on Redis outage. © Diabolical Labs

## Status

**Scaffolded.** Types and public API surface are defined. Full implementation ships Week 5 (parallel with `@diabolicallabs/notion`).

## Install

```bash
pnpm add @diabolicallabs/rate-limiter
# ioredis is a peerDependency — install it separately if you don't have it
pnpm add ioredis
```

## Usage

```typescript
import Redis from 'ioredis';
import { createRateLimiter, RateLimitError } from '@diabolicallabs/rate-limiter';

// Provide your existing ioredis singleton — the limiter does not create connections
const redis = new Redis(process.env.REDIS_URL!);

const limiter = createRateLimiter({
  redis,
  windowMs: 60_000,    // 1-minute sliding window
  maxRequests: 100,    // 100 requests per window
  keyPrefix: 'rl:',   // optional, default: 'rl:'
});

// Check without throwing
const result = await limiter.check('user:abc123');
if (!result.allowed) {
  return Response.json(
    { error: 'Rate limit exceeded' },
    { status: 429, headers: { 'Retry-After': String(Math.ceil(result.resetMs / 1000)) } }
  );
}

// Check and throw — useful in middleware
try {
  await limiter.enforce('ip:1.2.3.4');
} catch (err) {
  if (err instanceof RateLimitError) {
    // err.remaining, err.resetMs
  }
}
```

## Fail-closed behaviour

If Redis is unreachable, the rate limiter **rejects the request** (never passes through). This is the correct behaviour for a public API endpoint.

- `check()` returns `{ allowed: false, remaining: 0, resetMs: windowMs }` on Redis error
- `enforce()` throws `RateLimitError` on Redis error

## API

### `createRateLimiter(config): RateLimiter`

| Config field | Type | Default | Description |
|---|---|---|---|
| `redis` | `Redis` | required | ioredis instance — caller provides the singleton |
| `windowMs` | `number` | required | Sliding window duration in milliseconds |
| `maxRequests` | `number` | required | Max requests allowed within the window |
| `keyPrefix` | `string` | `'rl:'` | Redis key prefix |

### `RateLimiter` interface

| Method | Description |
|---|---|
| `check(key)` | Returns `RateLimitResult`. Fail-closed on Redis error. |
| `enforce(key)` | Throws `RateLimitError` if not allowed or Redis error. |

### `RateLimitError`

```typescript
class RateLimitError extends Error {
  readonly remaining: number; // always 0
  readonly resetMs: number;   // ms until window resets
}
```

## Implementation notes

The sorted-set pipeline: `ZREMRANGEBYSCORE` (evict expired) + `ZCARD` (count) + `ZADD` (record) in a single `redis.multi().exec()` call. Atomicity is guaranteed at the Redis command level.
