# @diabolicallabs/llm-pricing

## 1.2.0

### Minor Changes

- 6ef25a7: Add `gemini-3.5-flash` and `claude-opus-4-8` to the pricing table.

  **New models:**

  - `gemini-3.5-flash` (provider: `gemini`) — $1.50/$9.00/$0.15 (input/output/cacheRead per 1M tokens). GA 2026-05-19. Source: ai.google.dev/gemini-api/docs/pricing.
  - `claude-opus-4-8` (provider: `anthropic`) — pricing per the Anthropic API pricing page. Source URL recorded in `table.ts`.

  No API or behavioral changes. `computeCost` and `resolveModelPricing` return non-zero results for these models; previously they returned `isPartial: true, total: 0` (unknown model).

## 1.1.0

### Minor Changes

- cf4dcb2: Add pluggable `PricingLogger` for diagnostic events; default routes structured JSON to stdout.

  **Why.** `console.warn` writes to stderr, and Railway (plus most stream-classifying log ingesters) labels every stderr line as `severity: error`. The date-strip fallback path is a successful pricing resolution — emitting it as a "warning" produced 20–40 false errors per day across Railway-hosted consumers. Hard-coding a JSON-to-stdout format inside the library would solve that for Railway but force the choice on CLI/dev consumers who want human-readable stderr.

  **What.**

  - New `setPricingLogger(logger | null)` export and `PricingLogger` type. Pass an implementation to integrate with your app logger (pino, winston, Datadog, OpenTelemetry); pass `null` to restore the default.
  - New default logger emits `console.log(JSON.stringify({ level: 'warn', event, ...data }))` — structured JSON, written to stdout. Railway and similar ingesters classify by the `level` field, not by stream.
  - Four stable event names: `pricing_deprecated_alias`, `pricing_date_strip_fallback`, `pricing_unknown_model`, `pricing_fetch_failed`. Payload shapes documented in the README.

  **Behavior change to flag.**

  - The `fetchRemoteTable` fail event was previously emitted with `event: 'llm_pricing_fetch_failed'`. It is now `pricing_fetch_failed` (aligned with the rest of the namespace). Update any log alerts or dashboards keyed on the old name.
  - All four diagnostic types now land on **stdout** instead of stderr. Tooling that grep'd stderr to surface llm-pricing warnings should switch to grepping the event names, or call `setPricingLogger()` to route back to stderr.

  No code-change required for consumers. Existing callers automatically benefit from the Railway-friendly default after upgrade.

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
