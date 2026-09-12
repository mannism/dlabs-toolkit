# @diabolicallabs/llm-pricing

## 1.6.0

### Minor Changes

- 48a8b93: feat(pricing): add claude-fable-5-1, claude-mythos-5-1, gpt-6-astra, gpt-5/mini/nano/pro rows; fix gpt-5.6-sol drift

  **New rows:**

  - `claude-fable-5-1` / `claude-mythos-5-1`: $10/$50 per 1M input/output, same tier as
    `claude-fable-5`/`claude-mythos-5`. Cache reads are priced at **0.25/1M — a 0.025x
    multiplier on base input**, not the standard 0.1x every other Claude model in this
    table uses. This is Anthropic's own documented rate (pricing page footnote), not an
    error — do not "correct" it toward `inputPer1M * 0.1`.
  - `gpt-6-astra`: $10/$50/$1.00 standard tier, reasoning model (invisible reasoning
    tokens like the rest of the o-series/gpt-5.6 family). Carries a long-context billing
    tier: prompts over 272K input tokens bill the **entire request** at 2x input/cache
    and 1.5x output rates (`longContextThreshold`/`longContextInputPer1M`/
    `longContextOutputPer1M`/`longContextCacheReadPer1M`).
  - `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`: coverage gap fill — these were live
    on OpenAI's pricing page but absent from the table entirely.

  **Correction — `gpt-5.6-sol` was mispriced by up to 33%.** The table had $5.00/$30.00/
  $0.50 (sourced from a secondary aggregator, `verifiedAt: 2026-07-25`). Live
  `developers.openai.com/api/docs/pricing` confirms **$4.00/$20.00/$0.40** — independently
  corroborated by `gpt-6-astra` pricing being exactly 2.5x this corrected rate.
  **Downstream consumers on caret ranges (GEOAudit is a confirmed live consumer) will see
  reported Sol output costs drop ~33% on upgrade. This is a correction of a pre-existing
  overcharge in cost reporting, not a regression — do not revert.**

  **Notes-only (no price change):** `gemini-3.6-flash`/`3.7-flash`/`3.8-flash` now carry a
  `notes` field flagging that current pricing is introductory through 2026-12-31, doubling
  to $1.50/$7.50 (cacheRead $0.15) from 2027-01-01 — so the January jump isn't mis-flagged
  as drift by the monthly n8n check.

  All figures live-verified against vendor primary sources on 2026-09-05 (see
  `proj-plan/dlabs-toolkit/research/mano-pricing-audit-2026-09-05.md`).

## 1.5.0

### Minor Changes

- 83d1398: feat(gemini): add gemini-3.8-flash pricing row

  `gemini-3.8-flash` (GA 2026-09-02) is now priced in `DEFAULT_PRICING_TABLE` at the same
  rate as `gemini-3.7-flash`: $0.75 / $3.75 / $0.075 per 1M input/output/cache-read tokens.

  **Promotional pricing ends 2027-01-01** for both `gemini-3.7-flash` and
  `gemini-3.8-flash` — Google's list price rises to $1.50 / $7.50 / $0.15 per 1M tokens
  from that date. Expect the January drift check to flag this as a pricing change on both
  models when it fires.

## 1.4.3

### Patch Changes

- a0684bf: fix(gemini): remove phantom gemini-3.1-pro pricing entry

  `pricing/table.json` carried a pricing row for the bare, non-preview `gemini-3.1-pro`
  model ID. A 2026-08-18 pricing-drift audit flagged it as a possible phantom entry;
  that has now been verified directly against `ai.google.dev/gemini-api/docs/models` —
  only `gemini-3.1-pro-preview` exists. Google never shipped a GA, non-preview
  `gemini-3.1-pro`.

  The entry is removed from `pricing/table.json` and `packages/llm-pricing/src/table.ts`
  (regenerated via `node pricing/sync-bundled.mjs`, not hand-edited).
  `computeCost({ provider: 'gemini', model: 'gemini-3.1-pro' })` now behaves like any
  other unknown model: zero cost, `isPartial: true`, `pricing_unknown_model` warning
  emitted.

  **Patch:** removes a data entry for a model that was never real — no consumer could
  have been correctly relying on pricing data for a nonexistent model ID. Callers
  should use `gemini-3.1-pro-preview` (real, unaffected) instead.

## 1.4.2

### Patch Changes

- 5c4248f: Pricing drift correction sweep (Anthropic, OpenAI, DeepSeek, xAI) — 2026-08-18

  - `claude-sonnet-5`: Anthropic cancelled the planned 2026-08-31 increase to $3/$15 — the
    $2/$10 rate is now permanent standard pricing. Updated input/output/cache rates accordingly.
  - `claude-haiku-3`, `claude-haiku-3-5`: added retirement notes (first-party API retired
    2026-04-20 and 2026-02-19 respectively; `claude-haiku-3-5` remains live on Bedrock/GCP).
    No price change — retained for historical cost calculations.
  - `gpt-5.6-terra`: corrected — table was 25% overpriced ($2.5/$15 → $2.0/$12).
  - `gpt-5.6-luna`: corrected — table was 5x overpriced ($1.0/$6.0 → $0.20/$1.20).
  - `gpt-4.1`, `o1`, `o3`, `o3-mini`, `o4-mini`: added scheduled-shutdown notes
    (2026-10-23, except `o3` at 2026-12-11) per OpenAI's deprecations page.
  - `deepseek-chat`, `deepseek-reasoner`: notes updated — fully retired 2026-07-24, no longer
    a live alias despite the `deprecatedAliasFor` field; API calls now error.
  - `deepseek-v4-flash`, `deepseek-v4-pro`: repriced to the new off-peak baseline rate
    following DeepSeek's introduction of peak/off-peak differential pricing (peak windows
    01:00-04:00 and 06:00-10:00 UTC, ~2x off-peak). Added notes warning `computeCost()`
    does not model time-of-day pricing.
  - Added `grok-4.6` (xAI's new flagship, launched 2026-08-12). Same headline input/output
    rate as `grok-4.5` ($2.0/$6.0) but cached-input pricing is ~67% higher ($0.50 vs $0.30
    base tier, $1.00 vs $0.60 long-context). Verified directly against
    https://docs.x.ai/developers/models/grok-4.6.

  All changes verified against live provider docs 2026-08-18 (4-agent research sweep,
  Owner-approved scope). `pricing:verify` is clean except for the expected `deepseek-v4-flash`/
  `deepseek-v4-pro` peak/off-peak gap (Owner-approved: table holds off-peak baseline, matching
  the existing convention for Gemini's future-dated rate hikes).

## 1.4.1

### Patch Changes

- 062e46f: Add `gemini-3.7-flash` pricing, reprice `gemini-3.6-flash` to match introductory rate

  Google shipped `gemini-3.7-flash` (stable GA) on 2026-08-13 and repriced `gemini-3.6-flash`
  down to match its introductory rate ($0.75/$3.75/$0.075 per 1M input/output/cache-read tokens,
  in effect through 2026-12-31). Verified against https://ai.google.dev/gemini-api/docs/pricing.

## 1.4.0

### Minor Changes

- a1da2a9: Add `xai` as a first-class provider. `Provider` union now includes `'xai'`, `PricingTable` gains an `xai: Record<string, ModelPricing>` key, and the bundled table ships one model: `grok-4.5` ($2/$6 per 1M input/output, sub-200K tier; $4/$12 long-context tier above 200K input tokens, same threshold shape as `gemini-3.1-pro`). Verified live against `docs.x.ai/developers/models/grok-4.5` 2026-07-25.

  Updated every site in the package that enumerates all providers to include `xai`: `PricingTable`/`Provider` in `types.ts`, `REQUIRED_PROVIDERS` in `fetch-remote.ts` (remote-table schema validation), and the canonical `pricing/table.json` + `pricing/table.schema.json` + `pricing/sync-bundled.mjs` codegen pipeline that regenerates `src/table.ts`.

  This is additive only — no existing provider's shape or any exported function signature changed. **Downstream flag:** any consumer doing an exhaustive `switch`/if-chain over `Provider` without a `default` case will now fail to typecheck until it adds an `'xai'` arm. This is intentional — TypeScript should catch the gap at compile time, not at runtime. No currently known downstream consumer (GEOAudit, FitCheckerApp, labs) does this today per a repo grep at the time of writing, but caret-range consumers should re-typecheck after upgrading.

## 1.3.0

### Minor Changes

- 32badb3: Add 9 new model pricing entries and reconcile the Notion drift-check flag (id `3a31040c1cf481518f7eee67b8a16206`) against official provider pricing pages, verified live 2026-07-25.

  **New models:**

  - `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5`, `claude-mythos-5` (provider: `anthropic`) — $10/$50 (Fable, Mythos), $5/$25 (Opus), $3/$15 (Sonnet), input/output per 1M tokens, with matching 5-min/1-hour cache rates. `claude-sonnet-5` is priced at the standard rate, not the temporary $2/$10 introductory rate active through 2026-08-31 — intentional, future-safe choice.
  - `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (provider: `openai`) — $5/$30, $2.5/$15, $1/$6 respectively. All carry `hasInvisibleReasoningTokens: true`. No long-context tier added for `gpt-5.6-sol` — the >272K-token rate seen on third-party trackers is unconfirmed on the official page.
  - `gemini-3.6-flash`, `gemini-3.5-flash-lite` (provider: `gemini`) — $1.5/$7.5 and $0.3/$2.5 respectively.

  **Metadata cleanup (no price changes on existing entries):**

  - Re-verified live and refreshed `verifiedAt` to 2026-07-25 for all Anthropic, Gemini, and Perplexity entries, plus OpenAI `gpt-5.5`/`gpt-5.5-pro`/`gpt-5.4`/`gpt-5.4-mini`/`gpt-5.4-nano`/`gpt-5.4-pro`/`gpt-5.3-codex` and DeepSeek `deepseek-v4-flash`/`deepseek-v4-pro`. Zero price drift found on any existing entry.
  - Removed the stale header note claiming `deepseek-v4-pro` has an active promotional discount — that promo expired 2026-05-31 and the table price already reflects the no-promo rate. The note lived in `pricing/sync-bundled.mjs`'s generated-header template, not in `src/table.ts` directly.
  - All data changes (new entries + `verifiedAt` refreshes + `versionedAt` bump) were applied to `pricing/table.json`, the real canonical source, and `src/table.ts` was regenerated via `node pricing/sync-bundled.mjs`. An earlier commit on this branch had incorrectly hand-edited `src/table.ts` directly and rewritten its header to falsely claim there was no pipeline — that was based on incomplete exploration that missed `pricing/table.json` + `pricing/sync-bundled.mjs` at the monorepo root. This commit corrects it: `src/table.ts` is auto-generated again, `pricing/table.json` is the source of truth, and `node pricing/sync-bundled.mjs --check` passes. No numeric drift between the mistaken hand-edit and the newly-generated data.
  - `versionedAt` bumped 2026-06-04 → 2026-07-25.

  **False positives from the automated drift check, not acted on:** `claude-opus-4-8`/`claude-sonnet-4-6`/`claude-haiku-4-5` were already present in the table. "Sol" and "Luna" turned out to be GPT-5.6 tiers, not standalone models, and are captured above. `deepseek-chat-v3-1` does not exist — V4 superseded V3.1, and `deepseek-chat`/`deepseek-reasoner` were themselves deprecated 2026-07-24 (already reflected via existing `deprecatedAliasFor: 'deepseek-v4-flash'`).

  **Schema addition:** Added an optional `notes?: string` field to `ModelPricing` (`packages/llm-pricing/src/types.ts`) and to the corresponding sub-schema in `pricing/table.schema.json`, so per-model editorial annotations (e.g. "this is the standard rate, not the temporary intro rate") survive `table.json` edits instead of living only as source comments that get lost on regeneration. `pricing/sync-bundled.mjs` passes unknown-to-it fields through transparently (no allowlist), so no generator change was needed. Populated for the 3 entries where a comment was previously lost during this branch's table.json migration: `claude-mythos-5`, `claude-sonnet-5`, `gpt-5.6-luna`. Purely additive, optional field — not consumed by `computeCost()` or any runtime logic.

  No existing model key was deleted or renamed; no breaking type changes. Purely additive — flagging for downstream consumers on caret ranges (GEOAudit, FitCheckerApp, labs) since this ships as a minor bump per this toolkit's Changesets convention.

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
