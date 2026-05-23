---
"@diabolicallabs/rate-limiter": major
---

Implement @diabolicallabs/rate-limiter v1.0.0 — production Redis sliding-window rate limiter

Replaces the v0.0.2 stub with a production-ready implementation:

- `createRateLimiter` factory returning `check()` and `enforce()` methods
- Sliding-window-log algorithm using Redis sorted sets — atomic via Lua EVAL/EVALSHA
- Redis server-side `TIME` for authoritative clock (eliminates app-clock drift)
- EVALSHA optimization: SHA pre-warmed at construction via `SCRIPT LOAD`; NOSCRIPT fallback to `EVAL` + SHA reload on Redis cache flush
- Structural `RedisExecutor` interface — no hard ioredis import; any Redis client with `eval`, `evalsha`, `scriptLoad` satisfies it
- `onRedisError: 'closed' | 'open'` policy — fail-closed default (Redis down = request blocked)
- `RateLimitError` with `kind: 'exceeded' | 'unavailable'` discriminator
- Configurable `keyPrefix` for multi-tenant or multi-tier isolation
- Pluggable logger with structured stdout-JSON default
- `RL_REJECTED` and `RL_REDIS_ERROR` structured log events
- 40 unit tests, 89%+ branch coverage (all above 80% threshold), integration test suite gated by REDIS_URL
