# @diabolicallabs/llm-pricing

## 0.2.0

### Minor Changes

- 13248b9: feat: add fetchRemoteTable helper for opt-in remote pricing source. Stale-while-revalidate cache (24h default TTL), schema validation, fail-safe fallback to bundled DEFAULT_PRICING_TABLE. Never throws. Exports clearPricingCache() for testing.

## 0.1.0

### Minor Changes

- 968a9ec: Initial release of `@diabolicallabs/llm-pricing@0.1.0`. Ships default pricing table (Anthropic, OpenAI, Gemini, DeepSeek, Perplexity — verified 2026-05-13), `computeCost()` with Gemini long-context tiering, Anthropic cache math, deprecated DeepSeek alias resolution with console.warn, o-series and sonar-deep-research partial-cost flags, and `pnpm pricing:verify` diagnostic script against Perplexity sonar.
