---
'@diabolicallabs/llm-client': patch
---

fix: OpenAI usage now splits cached input tokens out of `inputTokens`.

OpenAI's Responses API reports `usage.input_tokens` INCLUDING `input_tokens_details.cached_tokens`, and `normalizeUsage` previously dropped the cached detail. For OpenAI, `LlmUsage.inputTokens` now excludes cached tokens (`input_tokens - cached_tokens`, clamped at 0) and `LlmUsage.cacheReadTokens` is populated from `cached_tokens` when the API reports it. This matches the Anthropic/xAI convention `@diabolicallabs/llm-pricing` `computeCost` assumes, so cached input is billed at the cache-read rate and cost is no longer overstated. `totalTokens` is unchanged. Applies to `complete`, `stream` final usage, `structured`, `streamStructured`, and `withTools`. Consumers that display `inputTokens` for OpenAI will see a lower number on cache hits; add `cacheReadTokens` back for the full prompt size.
