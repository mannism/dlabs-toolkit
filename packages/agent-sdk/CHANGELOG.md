# @diabolicallabs/agent-sdk

## 1.1.0

### Minor Changes

- 7731d8f: feat(agent-sdk): include cost in CallRecord when provided by llm-client

  CallRecord gains an optional `cost?: LlmCost` field (v1.1.0). When the wrapped LlmClient
  has `pricing` configured (via `@diabolicallabs/llm-client@^1.1.0`), cost is propagated
  from the response into the ingestion payload for `complete()`, `structured()`, and
  `withTools()`. Stream calls do not carry cost — there is no single response object to
  attach it to.

  `@diabolicallabs/llm-pricing` is declared as an optional peer dependency.

### Patch Changes

- Updated dependencies [0e4e895]
- Updated dependencies [6c477c9]
- Updated dependencies [968a9ec]
  - @diabolicallabs/llm-client@1.1.0
  - @diabolicallabs/llm-pricing@0.1.0

## 1.0.0

### Major Changes

- 7d3912a: v1.0.0: native tool calling, OpenAI Responses API, and expanded error taxonomy

  **@diabolicallabs/llm-client** breaking changes:

  - `LlmErrorKind` is now a closed union of 14 specific kinds (was narrow string union). `err.kind` is always defined (was `LlmErrorKind | undefined`). Consumers using `err.kind === 'http'` for retryable checks should migrate to `err.kind === 'rate_limit' || err.kind === 'server_error'`.
  - OpenAI provider migrated from Chat Completions to Responses API (`responses.create`). The `LlmClient` interface is unchanged — migration is transparent for `complete()`, `stream()`, and `structured()` callers.
  - `LlmClient` interface adds `withTools(messages, tools, options?)` — native tool calling across all five providers. Custom `LlmClient` implementations must add this method.

  New features:

  - `withTools()` — native tool calling on OpenAI (Responses API flat shape), Anthropic (`{ name, description, input_schema }`), Gemini (`parametersJsonSchema`), DeepSeek (Chat Completions nested shape). Perplexity throws `kind:'bad_request'` immediately.
  - `LlmTool`, `LlmToolCall`, `LlmToolResponse`, `LlmCallWithToolsOptions` types exported from the package root.
  - Gemini `structured()` fix: OBJECT schemas with empty `properties: {}` now auto-inject a `_placeholder` sentinel (stripped before Zod parse) to satisfy the Gemini API's rejection of empty-properties objects.

  **@diabolicallabs/agent-sdk** breaking changes:

  - `InstrumentedLlmClient` now requires `withTools()` on the underlying `LlmClient`. Consumers with custom `LlmClient` implementations must add `withTools()` before upgrading.
  - `CallRecord` gains optional `tool_calls?: LlmToolCall[]` — populated when `withTools()` produces at least one tool call. The Spend Dashboard ingestion endpoint should accept this additive field.

### Patch Changes

- Updated dependencies [7d3912a]
  - @diabolicallabs/llm-client@1.0.0

## 0.1.8

### Patch Changes

- Updated dependencies [21d5d23]
  - @diabolicallabs/llm-client@0.4.4

## 0.1.7

### Patch Changes

- Updated dependencies [3cbb234]
  - @diabolicallabs/llm-client@0.4.3

## 0.1.6

### Patch Changes

- Updated dependencies [f19d7a7]
  - @diabolicallabs/llm-client@0.4.2

## 0.1.5

### Patch Changes

- Updated dependencies [6b19f84]
  - @diabolicallabs/llm-client@0.4.1

## 0.1.4

### Patch Changes

- Updated dependencies [224ea05]
  - @diabolicallabs/llm-client@0.4.0

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
