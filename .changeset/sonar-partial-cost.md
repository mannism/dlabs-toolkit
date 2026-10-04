---
'@diabolicallabs/llm-pricing': patch
---

Perplexity `sonar`, `sonar-pro`, and `sonar-reasoning-pro` now set `partialCostCoverage: true`, so `computeCost()` returns `cost.isPartial: true` for them. Per-request fees ($5-14 per 1K requests, by context size) are not modeled, so the token-cost total was always a floor; the flag now says so. Token rates and `cost.total` are unchanged. `sonar-deep-research` already carried the flag.
