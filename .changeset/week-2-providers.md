---
"@diabolicallabs/llm-client": minor
"@diabolicallabs/agent-sdk": patch
"@diabolicallabs/notion": patch
"@diabolicallabs/rate-limiter": patch
---

feat(llm-client): implement Anthropic and OpenAI providers with streaming, structured output, and retry logic

- `createAnthropicProvider`: complete(), stream(), structured() with exponential backoff retry
- `createOpenAIProvider`: complete(), stream(), structured() with exponential backoff retry
- `createGeminiProvider`, `createDeepSeekProvider`, `createPerplexityProvider`: typed stubs (Week 3)
- `createClient` factory: dispatches across all 5 providers
- `createClientFromEnv`: env var resolution with fail-fast LlmError
- Shared retry module: full jitter backoff, retryable status/error-code classification, normaliseThrownError
- 101 unit tests, >80% coverage across all thresholds
- passWithNoTests removed from all 4 package configs
- CI: 80% coverage gate, Turbo remote cache (TURBO_TOKEN + TURBO_TEAM)
