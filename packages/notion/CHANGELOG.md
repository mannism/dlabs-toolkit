# @diabolicallabs/notion

## 1.0.0

### Major Changes

- 568539b: Implement @diabolicallabs/notion v1.0.0 — full Notion REST client

  Replaces the v0.0.2 stub with a production-ready implementation:

  - `createNotionClient` and `createNotionClientFromEnv` factory functions
  - `createDatabasePage`, `queryDatabase`, `getPage`, `updatePage` methods
  - Auto-pagination via `collectPaginatedAPI` from @notionhq/client
  - Full property value serializer: 12 property types (title, rich_text, number, select, multi_select, date, checkbox, url, email, phone_number, relation, status)
  - Named error taxonomy: `NotionAuthError`, `NotionNotFoundError`, `NotionValidationError`, `NotionRateLimitError`, `NotionConflictError`, `NotionUnavailableError` — all extend `NotionError`
  - Error mapping from SDK `APIResponseError` codes to named classes
  - Pluggable logger with structured stdout-JSON default (same interface as llm-pricing, llm-client)
  - Conflict retry with full-jitter exponential backoff (configurable `maxRetries`, `retryDelayMs`)
  - Authorization header stripped from error logs — no secret leakage
  - Default Notion-Version: `2025-09-03` (aligned with @notionhq/client v5)
  - 64 unit tests, 85%+ branch coverage, integration test suite gated by NOTION_API_KEY

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
