---
"@diabolicallabs/llm-client": minor
---

Implement Perplexity provider — web-grounded responses with citations and search filters.

`createPerplexityProvider()` is now a real implementation (not a stub). All five toolkit providers are fully implemented.

**New features:**
- `complete()`, `stream()`, `structured()` against `https://api.perplexity.ai` via OpenAI SDK
- `LlmResponse.citations`: web source URLs returned by Perplexity, deduplicated by URL. `undefined` for all other providers.
- `LlmCallOptions.providerOptions`: generic escape hatch for provider-specific parameters. Perplexity reads `search_recency_filter` and `search_domain_filter`; unknown fields pass through unchanged; other providers ignore the field.
- Reasoning model support: `sonar-reasoning-pro` accepted as a model string; `structured()` strips `<think>` reasoning blocks before JSON parsing.

**Breaking changes:** None. All changes are additive. Existing provider implementations and tests are unaffected.
