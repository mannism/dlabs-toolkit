# @diabolicallabs/llm-client

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
