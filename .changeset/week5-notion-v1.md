---
"@diabolicallabs/notion": major
---

Implement @diabolicallabs/notion v1.0.0 — full Notion REST client

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
