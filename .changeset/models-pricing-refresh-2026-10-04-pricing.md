---
'@diabolicallabs/llm-pricing': minor
---

feat: models and pricing refresh (2026-10-04).

New rows: `claude-opus-5-5` ($4 / $20, cache read $0.20), `claude-sonnet-5-5` ($2 / $10), `gpt-6-sol` ($2 / $10), `gpt-6.1-sol` ($2 / $10, cache read $0.10, cache write $2.50), `gpt-6-luna` ($0.10 / $0.50), `deepseek-flash` ($0.15 / $0.60 / cache $0.003). OpenAI has not published a cache-write rate for `gpt-6-sol` or `gpt-6-luna`, so `cacheWritePer1M` is intentionally omitted on those two.

**Behavior change: OpenAI long-context pricing now applies.** `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna`, `gpt-5.6-sol/terra/luna`, `gpt-5.5`, `gpt-5.4` and `gpt-5.4-pro` now carry `longContext*` fields (threshold 272,000 prompt tokens: 2x input/cache, 1.5x output on the FULL request). `computeCost()` for any call on these models whose prompt (input + cache read + cache write tokens) exceeds 272K will now report a higher cost than before. The 5.6 trio also gains `cacheWritePer1M` (1.25x input).

**DeepSeek flash rates changed.** `deepseek-v4-flash` (legacy name, now served by `deepseek-flash`) re-rated from $0.22 / $0.66 / $0.007 to $0.15 / $0.60 / $0.003 and marked `deprecatedAliasFor: 'deepseek-flash'` (so `computeCost()` now emits the `pricing_deprecated_alias` warning for it). `deepseek-chat` / `deepseek-reasoner` alias target re-pointed to `deepseek-flash`; their stored historical rates are unchanged.

Other: `gpt-5.2-pro` `cacheReadPer1M` removed (OpenAI publishes no cached-input price for pro models; cached tokens on it now cost 0 instead of an aggregator guess). Corrected the wrong `gpt-4.1` "shutdown 2026-10-23" note (only `gpt-4.1-nano` shuts down that day). Added deprecation/retirement notes for Anthropic, OpenAI, Gemini and Perplexity rows. No model keys were removed and no existing price changed other than the DeepSeek flash row.
