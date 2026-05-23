# @diabolicallabs/rate-limiter

## 1.0.0

### Major Changes

- 568539b: Implement @diabolicallabs/rate-limiter v1.0.0 — production Redis sliding-window rate limiter

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

## 0.0.2

### Patch Changes

- 0ae6f0a: Adopt MIT license across all packages. Adds `LICENSE` at the monorepo root and sets `"license": "MIT"` in each package's `package.json`. Resolves the "no license granted" warning consumers see on npm.

## 0.0.1

### Patch Changes

- a39447f: feat(llm-client): implement Anthropic and OpenAI providers with streaming, structured output, and retry logic

  - `createAnthropicProvider`: complete(), stream(), structured() with exponential backoff retry
  - `createOpenAIProvider`: complete(), stream(), structured() with exponential backoff retry
  - `createGeminiProvider`, `createDeepSeekProvider`, `createPerplexityProvider`: typed stubs (Week 3)
  - `createClient` factory: dispatches across all 5 providers
  - `createClientFromEnv`: env var resolution with fail-fast LlmError
  - Shared retry module: full jitter backoff, retryable status/error-code classification, normalizeThrownError
  - 101 unit tests, >80% coverage across all thresholds
  - passWithNoTests removed from all 4 package configs
  - CI: 80% coverage gate, Turbo remote cache (TURBO_TOKEN + TURBO_TEAM)
