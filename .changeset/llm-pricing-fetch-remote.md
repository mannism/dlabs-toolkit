---
"@diabolicallabs/llm-pricing": minor
---

feat: add fetchRemoteTable helper for opt-in remote pricing source. Stale-while-revalidate cache (24h default TTL), schema validation, fail-safe fallback to bundled DEFAULT_PRICING_TABLE. Never throws. Exports clearPricingCache() for testing.
