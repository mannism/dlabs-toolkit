---
'@diabolicallabs/llm-pricing': minor
---

Add long-context cache-write tier support. `ModelPricing` gains optional `longContextCacheWritePer1M` (5-minute write) and `longContextCacheWrite1hPer1M` (data only); `computeCost()` uses the former for cache-creation tokens when total prompt tokens exceed `longContextThreshold`, falling back to `cacheWritePer1M` when undefined. `claude-haiku-5-5` now prices correctly on both sides of its 100K-token threshold (input, output, cache read, cache write). No existing model's computed cost changes.
