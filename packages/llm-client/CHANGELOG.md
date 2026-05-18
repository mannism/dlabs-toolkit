# @diabolicallabs/llm-client

## 3.0.0

### Patch Changes

- Updated dependencies [82624de]
  - @diabolicallabs/llm-pricing@0.4.0

## 2.0.0

### Patch Changes

- Updated dependencies [8eec1a6]
  - @diabolicallabs/llm-pricing@0.3.0

## 1.7.0

### Minor Changes

- b121b60: feat: pricing.remoteUrl config wires fetchRemoteTable into createClient. Opt-in — bundled DEFAULT_PRICING_TABLE remains the floor. createClient is now async (awaits remote fetch on init when remoteUrl set). Logs structured pricing_source event on createClient init. Peer dep range bumped to @diabolicallabs/llm-pricing@^0.2.0.

### Patch Changes

- Updated dependencies [13248b9]
  - @diabolicallabs/llm-pricing@0.2.0

## 1.6.0

### Minor Changes

- 5c019b5: Streaming usage in afterCall context (v1.6.0): `LlmAfterCallContext` now carries a `usage?: LlmUsage` field populated for all five call types. Non-streaming paths (complete, structured, withTools) mirror `response.usage`. Streaming paths accumulate usage from the terminal chunk (`stream`) or the `done` event (`streamStructured`). This unblocks agent-sdk's stream/streamStructured wrappers from needing to maintain their own generators for usage capture.

## 1.5.0

### Minor Changes

- 00c470b: Pre-call hooks API (v1.5.0): `LlmHooks` with `beforeCall` and `afterCall` support on all five call types. Enables PII redaction, request mutation, short-circuit caching, and custom logging at the client level.

## 1.4.0

### Minor Changes

- 3c8bce0: feat(llm-client): provider capability matrix — getModelCapabilities() (Wave 3a §3.2)

  Adds `getModelCapabilities(provider, model): ModelCapabilities | null` — a static lookup
  that returns capability flags for any supported provider+model combination:

  - `contextWindow`, `maxOutputTokens` — token limits
  - `streaming`, `tools`, `parallelTools` — call surface support
  - `promptCache` — `'ephemeral'` for Anthropic; `null` for all others
  - `structuredOutput` — `'tool-use'` | `'json-schema'` | `'response-schema'` | `null`
  - `responseIds` — `'provider'` | `'synthesized'` (Gemini synthesizes UUID v7-style IDs)
  - `streamStructured` — `false` for Gemini and Perplexity

  Returns `null` for unknown models (never throws). Covers all five providers and all models
  in the DEFAULT_PRICING_TABLE. Versioned at `CAPABILITIES_VERSIONED_AT: '2026-05-13'`.

- 3f7c43e: feat(llm-client): linkedAbortController helper — fan-out with root signal + per-call timeouts (Wave 3a §3.3)

  Adds `linkedAbortController(parentSignal, { timeoutMs? }): LinkedAbortHandle` — a consumer-facing
  utility for parallel call patterns where a root signal cancels all in-flight calls and individual
  calls have their own per-call timeouts.

  Behaviour:

  - Parent abort forwards immediately to the child, preserving the parent's abort reason.
  - If the parent is already aborted when linkedAbortController() is called, the child aborts
    synchronously (before any API call is made).
  - Optional `timeoutMs` starts an independent timer that aborts the child after the elapsed time
    with a timeout reason string. Fires independently of the parent.
  - `dispose()` removes the parent listener and clears the timer without aborting the child.
    Call in the `finally` block of the consuming call to prevent listener leaks.
  - `abort()` aborts the child immediately and calls `dispose()`.

  Returns `{ signal, abort, dispose }`. Pass `signal` to `client.complete()`, `client.stream()`, etc.

- 29ff738: feat(llm-client): response IDs on all response types — id + idSource everywhere (Wave 3a §3.4)

  Adds `id: string` and `idSource: 'provider' | 'synthesized'` to all three response types:
  `LlmResponse`, `LlmStructuredResponse<T>`, and `LlmToolResponse`.

  Previously `id` was optional and absent from `LlmResponse` entirely. Now all response paths
  across all five providers always carry a non-undefined `id`.

  **Provider sources:**

  - Anthropic: `response.id` (message ID — provider-issued). `idSource: 'provider'`.
  - OpenAI: `rawResponse.id` (Responses API response ID — provider-issued). `idSource: 'provider'`.
  - DeepSeek: `rawResponse.id` (Chat Completions response ID — provider-issued). `idSource: 'provider'`.
  - Perplexity: `response.id` (Chat Completions response ID — provider-issued). `idSource: 'provider'`.
  - Gemini: synthesized UUID v7-style (time-derived prefix + random — time-sortable for trace correlation).
    `idSource: 'synthesized'`. Gemini does not issue native response IDs on generateContent calls.

  **UUID v4 vs v7 decision:** The toolkit uses a hand-rolled v7-style generator (time-derived prefix,
  no new dep). Time-sortability is useful for trace correlation without a separate timestamp field.
  `crypto.randomUUID()` (v4) would be fully random — no correlation by time. No `uuid` package needed.

  **Migration:** `id` is now required on all three response types. TypeScript consumers that were
  checking `if (result.id !== undefined)` may need to remove the null check. The `idSource` field
  lets trace systems distinguish durable provider IDs from toolkit-generated correlation IDs.

## 1.3.0

### Minor Changes

- 11f28f1: feat(llm-client): streamStructured() — token streaming + Zod-validated final output (v1.3.0)

  Adds `streamStructured<T>(messages, schema, options?)` to `LlmClient`. Emits
  `{ type: 'token', token }` events during generation and a single
  `{ type: 'done', data: T, usage }` event at the end after JSON.parse() and
  schema.parse() validation.

  Provider support:

  - **OpenAI (Responses API):** streams `output_text.delta` events. Zod 4 schemas
    enable `text.format.type = 'json_schema'` strict mode; plain `{ parse }` schemas
    use `json_object` mode.
  - **Anthropic:** forced tool-use path (same as `structured()`), streams
    `input_json_delta` events from `messages.stream()`. Validated at end.
  - **DeepSeek:** Chat Completions stream with `response_format: json_object`.
    Falls back to `parseJsonOrThrow` on `JSON.parse` failure to handle
    chain-of-thought preamble from `deepseek-reasoner`.
  - **Gemini:** throws `LlmError(kind: 'bad_request')` immediately. Gemini does
    not reliably support simultaneous `responseSchema` constraints and streaming.
  - **Perplexity:** throws `LlmError(kind: 'bad_request')` immediately. Search
    models do not return tool-validated JSON.

  Error path: `LlmError(kind: 'structured_parse_failed')` thrown if
  `JSON.parse()` or `schema.parse()` fails (no `done` event emitted).

  AbortSignal, `streamStallTimeoutMs`, and `timeoutMs` propagate to the
  underlying SDK stream unchanged.

  No failover support (mid-stream model switching is unsafe). No cost annotation
  (streaming does not produce a single accumulated response object).

  feat(agent-sdk): wrap streamStructured() in InstrumentedLlmClient (v1.3.0)

  `instrumentClient` wraps `streamStructured()` with a single `CallRecord`
  dispatch per call (not per chunk). Usage is taken from the final `done` event.
  No new fields on `CallRecord` — existing shape covers it.

  Peer dep on `@diabolicallabs/llm-client` tightened to `^1.3.0`.

## 1.2.0

### Minor Changes

- 1b7c01d: feat(llm-client): concurrency pool at @diabolicallabs/llm-client/pool sub-path (Wave 2b)

  New export: `createPool(config)` — returns a `Pool` instance for managing parallel LLM
  call workloads with per-provider concurrency and optional rate limiting.

  **API:**

  - `createPool({ concurrencyPerProvider?, rateLimitPerProvider? })` — configure per-provider
    semaphore caps (e.g. `{ anthropic: 4, gemini: 2 }`) and optional rolling-window rpm limits.
  - `pool.runAll(tasks, { signal?, onProgress? })` — run all tasks concurrently within the
    configured caps. Returns `PoolResult<T>[]` in input order. Individual task errors are
    captured as `{ status: 'rejected' }` — pool always resolves.
  - `PoolResult<T>`: `'fulfilled' | 'rejected' | 'aborted'` discriminated union.
  - AbortSignal support: pending tasks are skipped when the signal fires.

  **Motivation:** EXP_009 (agentic-reliability benchmark) sends 45 parallel calls
  (15 tasks × 3 providers) and hand-rolled its own semaphore in `orchestrator.ts`.
  The pool primitive replaces that boilerplate and is available to all toolkit consumers.

- 74e6c21: feat(llm-client): configurable retry strategy and provider failover (Wave 2b)

  **Configurable retry (2.5):** `LlmClientConfig.retry` accepts a `RetryConfig` object
  with `maxAttempts`, `strategy` (`'exponential' | 'linear' | 'fixed' | 'decorrelated'`),
  `baseDelayMs`, `maxDelayMs`, `respectRetryAfter`, and `retryOn`. When omitted, legacy
  exponential + full-jitter behavior is preserved unchanged. The decorrelated strategy
  implements AWS Marc Brooker jitter to break correlation between concurrent callers.
  `respectRetryAfter` parses the `Retry-After` integer-seconds header on 429 responses.

  **Provider failover (2.4):** `LlmClientConfig.model` now accepts `string | string[]`.
  When an array is passed, the first element is the primary model. On errors whose kind
  appears in `fallbackOn` (default: `['not_found']`), retries are exhausted on the primary
  before falling through to the next model. `LlmResponse.requestedModel`,
  `LlmToolResponse.requestedModel`, and `LlmStructuredResponse.requestedModel` are all
  populated with the original primary model when failover fires.
  Streaming always uses the primary model — mid-stream failover is unsafe.

  New exports: `RetryConfig`, `RetryStrategy`.

## 1.1.0

### Minor Changes

- 6c477c9: Optional per-response cost computation via @diabolicallabs/llm-pricing. Pass `pricing: { computeOnEveryCall: true }` to `createClient()` to attach `cost?: LlmCost` on every `complete()`, `structured()`, and `withTools()` response. Requires the optional peer dep `@diabolicallabs/llm-pricing@^0.1.0`. Consumers who don't configure pricing see no cost field and incur no import overhead.

### Patch Changes

- 0e4e895: DeepSeek canonical model IDs are now `deepseek-v4-flash` and `deepseek-v4-pro` (V3/R1 IDs deprecated upstream and now alias to V4). Smoke script and README updated; no API surface change.
- Updated dependencies [968a9ec]
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

## 0.4.4

### Patch Changes

- 21d5d23: fix(llm-client): robust JSON extraction in structured() prompt-fallback

  Replaces naïve fence-strip + JSON.parse with a single-pass balanced-brace
  extractor (extractJsonBlock) that correctly handles:

  - JSON in fences with trailing prose (Perplexity citation notes — the GEOAudit
    Advanced audit failure from 2026-05-11)
  - Preamble prose before the fence
  - No closing fence (model truncation)
  - Braces/brackets inside double-quoted string values
  - <think>...</think> reasoning blocks (sonar-reasoning-pro and similar)

  All four prompt-fallback paths (Anthropic structuredPromptFallback, OpenAI
  structuredPromptFallback, Gemini structuredPromptFallback, Perplexity structured)
  now share parseJsonOrThrow from src/extract-json.ts. On extraction failure the
  error message includes a ≥500-char raw content slice (head 300 + tail 200 for
  long responses) instead of the previous 200-char head-only slice.

## 0.4.3

### Patch Changes

- 3cbb234: feat(llm-client): opt-in Anthropic prompt cache via providerOptions.promptCache

  Pass `providerOptions: { promptCache: 'ephemeral' }` on any Anthropic call to inject
  `cache_control: { type: 'ephemeral' }` on the system message block (and on the tool
  definition in strict structured mode). Anthropic caches the block for 5 minutes;
  reads cost 0.10× and writes cost 1.25× normal input price.

  All four code paths covered: complete(), stream(), structured() strict tool-use, and
  structuredPromptFallback() (via delegation to complete()). Non-Anthropic providers
  ignore the option — no behavioral change for existing callers.

  Cache tokens surface in LlmUsage.cacheCreationTokens and LlmUsage.cacheReadTokens,
  which were already mapped by normalizeUsage() but now have explicit test coverage.

## 0.4.2

### Patch Changes

- f19d7a7: Fix per-call `timeoutMs` to extend the SDK socket deadline; classify `APIConnectionTimeoutError` as `kind: 'timeout'`.

  **Fix A — per-call timeoutMs now propagates to the SDK socket.** Previously, `LlmCallOptions.timeoutMs` only fed the toolkit's `AbortController`. The SDK socket was fixed at `createClient()` time (`config.timeoutMs ?? 30_000`), so long calls (>30 s) hit the SDK socket first, threw, and retry-exhausted at ~121 s — the per-call budget of 300 s never had a chance to take effect. Now `timeout: effectiveTimeoutMs` is passed in the per-call RequestOptions second argument at every call site across all three providers (OpenAI: `complete`, `stream`, `structured` strict, `structuredPromptFallback`; Anthropic: `complete`, `stream`, `structured` strict — `structuredPromptFallback` delegates to `complete`; Perplexity: `complete`, `stream`, `structured`). The constructor-level `timeout` stays as the floor for callers who do not pass a per-call override. This unblocks GEOAudit PR #171: `gpt-5.5` and `claude-sonnet-4-6` were failing A1 at exactly the retry-exhaustion latency (validated 2026-05-11 against `proj-plan/dlabs-toolkit/research/owner-geoaudit-use-case-validation-2026-05-11.md`).

  **Fix B — `APIConnectionTimeoutError` now maps to `kind: 'timeout'`.** Both OpenAI and Anthropic SDKs throw `APIConnectionTimeoutError` (a subclass of `APIConnectionError`) when the socket timeout fires. The existing normalizers checked `instanceof APIConnectionError` first — the timeout subclass matched but emitted no `kind` discriminator, leaving `kind: undefined`. An `instanceof APIConnectionTimeoutError` branch is now inserted _before_ the `instanceof APIConnectionError` branch in `normalizeOpenAIError`, `normalizeAnthropicError`, and `normalizePerplexityError`. All three map to `{ kind: 'timeout', retryable: true }`. Callers who branch on `LlmError.kind` can now distinguish SDK socket timeouts from other connection errors.

  `LlmCallOptions` shape is unchanged — this is a non-breaking patch.

## 0.4.1

### Patch Changes

- 6b19f84: Fix OpenAI provider to use `max_completion_tokens` instead of legacy `max_tokens`. Reasoning models in the gpt-5.x family (`gpt-5.5`, `gpt-5.4-mini`) reject `max_tokens` outright with HTTP 400 ("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), and the OpenAI SDK does not auto-translate. The provider now emits `max_completion_tokens` from `complete()`, `stream()`, and both `structured()` paths (strict and prompt-fallback). Universally accepted by all current OpenAI chat models — no `LlmCallOptions` API change.

  Reasoning-model semantics to be aware of: on gpt-5.x, o1, and o3, `max_completion_tokens` is the combined budget for invisible reasoning tokens AND visible output tokens. Setting `maxTokens: 50` on `gpt-5.5` can yield empty visible content because the model spends the full budget on reasoning. Set `maxTokens` ≥ 1024 against reasoning models to leave headroom for visible output.

## 0.4.0

### Minor Changes

- 224ea05: Add native strict structured outputs (v0.4.0). Pass a Zod 4 schema to `structured()` to automatically trigger the strictest native path per provider: OpenAI `json_schema` strict mode, Anthropic tool-use with forced `tool_choice`, Gemini `responseSchema`. DeepSeek and Perplexity remain prompt-only (API limitation) but gain return-shape parity. `LlmStructuredResponse` gains `model` (always present), `id?` (provider request ID), and `citations?` (Perplexity). Opt out per-call with `providerOptions.structuredMode = 'prompt'`.

## 0.3.0

### Minor Changes

- 4cd925f: Add per-call timeout override (`LlmCallOptions.timeoutMs`), caller `AbortSignal` support (`LlmCallOptions.signal`), and per-chunk stream stall detection (`LlmCallOptions.streamStallTimeoutMs`) across all 5 providers (Anthropic, OpenAI, DeepSeek, Perplexity, Gemini). New `LlmError.kind` discriminator: `cancelled | timeout | stream_stall | http | network | unknown`. Gemini uses `Promise.race` with documented socket-leak caveat.
- c5cb669: Implement Perplexity provider — web-grounded responses with citations and search filters.

  `createPerplexityProvider()` is now a real implementation (not a stub). All five toolkit providers are fully implemented.

  **New features:**

  - `complete()`, `stream()`, `structured()` against `https://api.perplexity.ai` via OpenAI SDK
  - `LlmResponse.citations`: web source URLs returned by Perplexity, deduplicated by URL. `undefined` for all other providers.
  - `LlmCallOptions.providerOptions`: generic escape hatch for provider-specific parameters. Perplexity reads `search_recency_filter` and `search_domain_filter`; unknown fields pass through unchanged; other providers ignore the field.
  - Reasoning model support: `sonar-reasoning-pro` accepted as a model string; `structured()` strips `<think>` reasoning blocks before JSON parsing.

  **Breaking changes:** None. All changes are additive. Existing provider implementations and tests are unaffected.

## 0.2.0

### Minor Changes

- 517573a: Implement Perplexity provider — web-grounded responses with citations and search filters.

  `createPerplexityProvider()` is now a real implementation (not a stub). All five toolkit providers are fully implemented.

  **New features:**

  - `complete()`, `stream()`, `structured()` against `https://api.perplexity.ai` via OpenAI SDK
  - `LlmResponse.citations`: web source URLs returned by Perplexity, deduplicated by URL. `undefined` for all other providers.
  - `LlmCallOptions.providerOptions`: generic escape hatch for provider-specific parameters. Perplexity reads `search_recency_filter` and `search_domain_filter`; unknown fields pass through unchanged; other providers ignore the field.
  - Reasoning model support: `sonar-reasoning-pro` accepted as a model string; `structured()` strips `<think>` reasoning blocks before JSON parsing.

  **Breaking changes:** None. All changes are additive. Existing provider implementations and tests are unaffected.

## 0.1.1

### Patch Changes

- 0ae6f0a: Adopt MIT license across all packages. Adds `LICENSE` at the monorepo root and sets `"license": "MIT"` in each package's `package.json`. Resolves the "no license granted" warning consumers see on npm.

## 0.1.0

### Minor Changes

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

- 2f1a706: Week 3: Gemini and DeepSeek provider implementations

  - `gemini` provider: full implementation using `@google/genai` SDK v1.x. Supports `complete()`, `stream()`, and `structured()`. System instructions via `config.systemInstruction`. Token normalization via `usageMetadata`. Error normalization via the publicly-exported `ApiError` class (status always number). Network errors handled by `normalizeThrownError`.
  - `deepseek` provider: OpenAI SDK with `baseURL: 'https://api.deepseek.com'`. Full `complete()`, `stream()`, and `structured()` support. Prompt-level JSON enforcement for structured output (DeepSeek does not guarantee `json_object` response_format support across all models).
  - `stubs.ts`: Gemini and DeepSeek stubs removed. Perplexity stub retained.
  - `client.ts`: Updated imports and JSDoc.
  - Tests: `gemini.test.ts` (20 tests), `deepseek.test.ts` (22 tests), `error-normalize.test.ts` extended with Gemini + DeepSeek normalization tests (22 total). `client.test.ts` updated to mock all four providers and test only Perplexity as stub.
  - `scripts/integration-test.ts`: Extended with Gemini and DeepSeek test sections (skipped when API keys absent).
