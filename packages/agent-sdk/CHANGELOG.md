# @diabolicallabs/agent-sdk

## 3.0.1

### Patch Changes

- 12f76a1: chore: remove redundant peerDependency on @diabolicallabs/llm-pricing. agent-sdk's only usage is type-only imports of LlmCost (compiled away at build time). The peer-dep was documentation-grade, not load-bearing. Removing it prevents the Changesets peer-cascade major-bump that fires every time llm-pricing crosses a pre-1.0 minor boundary. Runtime behavior unchanged.

## 3.0.0

### Patch Changes

- 4efe3a3: chore: peer dep range disjunction (`^0.1.0 || ^0.2.0`) for `@diabolicallabs/llm-pricing`. Pure manifest tweak — no API change, no behavior change. Explicit patch entry to override the default major-bump cascade that fires when a peer-dep pre-1.0 minor boundary is crossed.
- Updated dependencies [b121b60]
- Updated dependencies [13248b9]
  - @diabolicallabs/llm-client@1.7.0
  - @diabolicallabs/llm-pricing@0.2.0

## 2.0.0

### Major Changes

- 53b89d5: Architecture-migration complete (v2.0.0): stream() and streamStructured() bespoke usage-capture wrappers deleted from sdk.ts. All 5 call types now flow through a single buildAfterCallDispatch() function — no per-method ingestion closures remain. Public API unchanged. Requires llm-client@^1.6.0 (usage now surfaced in LlmAfterCallContext for streaming paths).

  BREAKING CHANGE: agent-sdk@2.0.0 completes the hooks-internal architecture migration from v1.4.0. Stream() and streamStructured() wrappers in sdk.ts are deleted; all 5 call types now flow uniformly through llm-client's afterCall hook. Public API unchanged. Peer-dep bumps to llm-client@^1.6.0 (required for usage in LlmAfterCallContext on streaming paths).

### Patch Changes

- Updated dependencies [5c019b5]
  - @diabolicallabs/llm-client@1.6.0

## 1.4.0

### Minor Changes

- 2826012: Internal refactor (v1.4.0): non-streaming paths now use a shared `buildAfterCallHandler()` instead of bespoke per-method closures. `stream()` and `streamStructured()` wrappers retained for usage capture. Public API unchanged.

### Patch Changes

- Updated dependencies [00c470b]
  - @diabolicallabs/llm-client@1.5.0

## 1.3.1

### Patch Changes

- Updated dependencies [3c8bce0]
- Updated dependencies [3f7c43e]
- Updated dependencies [29ff738]
  - @diabolicallabs/llm-client@1.4.0

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

### Patch Changes

- Updated dependencies [11f28f1]
  - @diabolicallabs/llm-client@1.3.0

## 1.2.0

### Minor Changes

- 9d0d999: feat(agent-sdk): propagate requestedModel to CallRecord for provider failover tracking

  **v1.2.0 — failover observability:**

  When `@diabolicallabs/llm-client` is configured with `model: string[]` and provider
  failover fires, `LlmResponse.requestedModel` carries the originally-requested primary
  model while `LlmResponse.model` holds the actually-serving fallback model.

  `CallRecord.requestedModel?: string` is now populated from `response.requestedModel`
  in `complete()`, `structured()`, and `withTools()` instrumentation paths. This lets the
  Agent Spend Dashboard distinguish "requested gpt-5.5, served gpt-4.1" from
  "requested gpt-4.1, served gpt-4.1."

  `stream()` does not propagate `requestedModel` — streaming always uses the primary
  model and mid-stream failover is not supported. The `model` field in the stream
  `CallRecord` uses the primary (config-level first element) as before.

### Patch Changes

- Updated dependencies [1b7c01d]
- Updated dependencies [74e6c21]
  - @diabolicallabs/llm-client@1.2.0

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
