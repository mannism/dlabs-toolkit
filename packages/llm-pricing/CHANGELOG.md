# @diabolicallabs/llm-pricing

## 1.0.0

### Major Changes

- 7ac1d59: Graduate to 1.0.0. No API or behavioral changes — `computeCost`, `resolveModelPricing`, `fetchRemoteTable`, `DEFAULT_PRICING_TABLE`, and the `LlmCost` / `PricingTable` / `Provider` type exports are all stable since 0.3.0. This release shifts semver discipline from pre-1.0 (where Changesets treats every minor as breaking for peer-dep consumers) to stable 1.x. Future pricing-table refreshes and model additions ship as 1.x minors with no consumer cascade.

## 0.4.0

### Minor Changes

- 82624de: Add 7 new OpenAI 5.1/5.2/5.3 family models to the pricing table.

  **New models:**

  - `gpt-5.1` — $1.25/$10.00/$0.125 (input/output/cacheRead per 1M tokens)
  - `gpt-5.1-codex-mini` — $0.25/$2.00/$0.025
  - `gpt-5.2` — $1.75/$14.00/$0.175
  - `gpt-5.2-pro` — $21.00/$168.00/$2.10
  - `gpt-5.2-codex` — $1.75/$14.00/$0.175
  - `gpt-5.3-chat-latest` — $1.75/$14.00/$0.175 (canonical API ID; no bare `gpt-5.3` in `/v1/models`)
  - `gpt-5.3-codex` — $1.75/$14.00/$0.175

  Model IDs empirically confirmed via OpenAI `/v1/models` on 2026-05-18. Dated variants
  (`gpt-5.1-2025-11-13`, `gpt-5.2-2025-12-11`, `gpt-5.2-pro-2025-12-11`) resolve via the
  existing date-strip fallback in `resolveModelPricing`.

  Pricing source: portkey.ai/models/openai — multi-aggregator convergence (portkey.ai, tldl.io,
  inworld.ai, helicone.ai), cross-referenced against OpenAI pricing page. Confidence: Medium.

## 0.3.0

### Minor Changes

- 8eec1a6: Add 13 missing models to the pricing table and fix dated model ID cost-tracking leak.

  **New models:**

  - Anthropic: `claude-opus-4-5`, `claude-sonnet-4-5`
  - OpenAI: `gpt-5.4-nano`, `gpt-5.4-pro`, `o3-mini`, `o3-pro`, `o1`, `o1-mini`, `gpt-4o`, `gpt-4o-mini`
  - Gemini: `gemini-3.1-pro` (non-preview), `gemini-3-flash-preview`, `gemini-2.5-flash-lite`

  **Date-strip fallback in `resolveModelPricing`:** When an exact model ID lookup fails, strips trailing date suffixes (`-YYYY-MM-DD`, `-YYYYMMDD`, `-YYYY-MM`) and retries with the base alias. Fixes a production cost-tracking leak where the OpenAI Responses API returns dated model IDs (e.g. `gpt-5.4-mini-2026-03-17`) that previously fell through to `{ total: 0, isPartial: true }`.

  **Warn-once for noisy paths:** All three console.warn paths (deprecated alias, unknown model, date-strip fallback) now fire at most once per unique `(provider, model)` pair per process lifetime. Prevents log spam in high-volume callers.

  **Follow-up (out of scope):** DeepSeek cache-read price change from 2026-04-26 — tracked separately. `@diabolicallabs/llm-client` has no source change in this release; the `^0.2.0` optional peer-dep range does not include `0.3.0` (pre-1.0 caret behaviour). GEOAudit's direct `@diabolicallabs/llm-pricing: "^0.2.0"` dependency will also need a manual bump to `^0.3.0` to pick up this fix.

## 0.2.0

### Minor Changes

- 13248b9: feat: add fetchRemoteTable helper for opt-in remote pricing source. Stale-while-revalidate cache (24h default TTL), schema validation, fail-safe fallback to bundled DEFAULT_PRICING_TABLE. Never throws. Exports clearPricingCache() for testing.

## 0.1.0

### Minor Changes

- 968a9ec: Initial release of `@diabolicallabs/llm-pricing@0.1.0`. Ships default pricing table (Anthropic, OpenAI, Gemini, DeepSeek, Perplexity — verified 2026-05-13), `computeCost()` with Gemini long-context tiering, Anthropic cache math, deprecated DeepSeek alias resolution with console.warn, o-series and sonar-deep-research partial-cost flags, and `pnpm pricing:verify` diagnostic script against Perplexity sonar.
