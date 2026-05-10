# @diabolicallabs/agent-sdk

## 0.1.3

### Patch Changes

- Updated dependencies [4cd925f]
- Updated dependencies [c5cb669]
  - @diabolicallabs/llm-client@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [517573a]
  - @diabolicallabs/llm-client@0.2.0

## 0.1.1

### Patch Changes

- 0ae6f0a: Adopt MIT license across all packages. Adds `LICENSE` at the monorepo root and sets `"license": "MIT"` in each package's `package.json`. Resolves the "no license granted" warning consumers see on npm.
- Updated dependencies [0ae6f0a]
  - @diabolicallabs/llm-client@0.1.1

## 0.1.0

### Minor Changes

- c719f86: Implement `instrumentClient()` — cost-tracking middleware for `@diabolicallabs/llm-client`.

  Intercepts `complete()`, `stream()`, and `structured()` calls to capture a `CallRecord` (agent_id, model, tokens, latency, timestamp, call_id UUID) and dispatch it asynchronously to a configurable ingestion endpoint. The LLM response is returned to the caller immediately — ingestion is non-blocking.

  - **Retry:** exponential backoff, configurable `maxIngestionRetries` (default 3)
  - **Exhaustion:** record dropped, structured warning logged (includes `call_id` for audit), never throws to LLM caller
  - **Stream passthrough:** tokens yield immediately without buffering; usage captured from final chunk
  - **Disabled mode:** `config.disabled: true` skips all instrumentation with zero overhead
  - **No new runtime dependencies:** `crypto.randomUUID()` (Node 20 built-in) for idempotency key; native `fetch` with `AbortController` timeout

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

- Updated dependencies [a39447f]
- Updated dependencies [2f1a706]
  - @diabolicallabs/llm-client@0.1.0
