---
"@diabolicallabs/llm-client": minor
---

Week 3: Gemini and DeepSeek provider implementations

- `gemini` provider: full implementation using `@google/genai` SDK v1.x. Supports `complete()`, `stream()`, and `structured()`. System instructions via `config.systemInstruction`. Token normalization via `usageMetadata`. Error normalization via the publicly-exported `ApiError` class (status always number). Network errors handled by `normalizeThrownError`.
- `deepseek` provider: OpenAI SDK with `baseURL: 'https://api.deepseek.com'`. Full `complete()`, `stream()`, and `structured()` support. Prompt-level JSON enforcement for structured output (DeepSeek does not guarantee `json_object` response_format support across all models).
- `stubs.ts`: Gemini and DeepSeek stubs removed. Perplexity stub retained.
- `client.ts`: Updated imports and JSDoc.
- Tests: `gemini.test.ts` (20 tests), `deepseek.test.ts` (22 tests), `error-normalize.test.ts` extended with Gemini + DeepSeek normalization tests (22 total). `client.test.ts` updated to mock all four providers and test only Perplexity as stub.
- `scripts/integration-test.ts`: Extended with Gemini and DeepSeek test sections (skipped when API keys absent).
