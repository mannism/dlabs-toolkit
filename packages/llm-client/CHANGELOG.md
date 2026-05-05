# @diabolicallabs/llm-client

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
