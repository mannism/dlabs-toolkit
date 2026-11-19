---
'@diabolicallabs/llm-client': patch
---

Fix OpenAI usage normalization to report `input_tokens_details.cache_write_tokens` as `cacheCreationTokens` and subtract it from `inputTokens`, so cache writes are costed at the cache-write rate instead of the plain input rate. 12h-retention writes are still costed at the single write rate (no separate 12h usage field yet).
