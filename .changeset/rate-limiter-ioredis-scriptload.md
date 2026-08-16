---
"@diabolicallabs/rate-limiter": patch
---

Fix `RedisExecutor` incompatibility with `ioredis`: `createRateLimiter()` calls `redis.scriptLoad(...)` directly, but ioredis has no `scriptLoad()` method — only `.script("LOAD", script)` — so passing a raw `ioredis` client the way the package's own README documents threw `TypeError: redis.scriptLoad is not a function` synchronously on construction, before any request was ever rate-limited.

Adds an exported `fromIoredis(client)` factory that wraps a raw `ioredis` client into a conforming `RedisExecutor`, routing `scriptLoad()` through `.script("LOAD", ...)` and passing `eval`/`evalsha` through unchanged. Consumers who already supply their own correct `RedisExecutor` (e.g. a hand-rolled `node-redis` adapter) are unaffected — this is additive, not a signature change.

```typescript
import Redis from 'ioredis';
import { createRateLimiter, fromIoredis } from '@diabolicallabs/rate-limiter';

const redis = new Redis(process.env.REDIS_URL);
const limiter = createRateLimiter({ redis: fromIoredis(redis), windowMs: 60_000, maxRequests: 100 });
```

README usage example, config table, and `RedisExecutor` section corrected to match — the previous claim that "an `ioredis` `Redis` instance satisfies this interface directly" was false.
