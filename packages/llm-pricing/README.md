# @diabolicallabs/llm-pricing

Pricing table + cost computation for `@diabolicallabs/llm-client`. Converts `LlmUsage` token counts to per-call USD cost breakdowns across all five supported providers. © Diabolical Labs

**Stable since 1.0.0** (2026-05-18). The public API — `computeCost`, `resolveModelPricing`, `fetchRemoteTable`, `DEFAULT_PRICING_TABLE`, and the exported type shapes — is committed. Pricing-table refreshes and new model additions ship as minor releases. Breaking schema changes (e.g. multimodal billing extensions) will be flagged in advance and shipped as a major.

## Status

Default pricing table covers Anthropic, OpenAI (including GPT-5.x family), Gemini, DeepSeek, Perplexity. Remote table via `fetchRemoteTable()` with stale-while-revalidate cache. Pluggable diagnostic logger via `setPricingLogger()` — see [Logging](#logging).

## Install

```bash
pnpm add @diabolicallabs/llm-pricing
```

Public on npmjs.com — no `.npmrc` config required.

## Usage

```typescript
import { computeCost } from '@diabolicallabs/llm-pricing';

// After an LLM call via @diabolicallabs/llm-client:
const cost = computeCost({
  usage: response.usage,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
});

// cost.input    — USD input token cost
// cost.output   — USD output token cost
// cost.cacheRead  — USD cache read cost (Anthropic, Gemini)
// cost.cacheWrite — USD cache write cost (Anthropic ephemeral)
// cost.total    — sum of all components
// cost.currency — always 'USD'
// cost.isPartial — true when billing components exist that cannot be computed
//                  from token usage (o-series reasoning tokens, sonar-deep-research fees)
```

## Pricing table

The default table covers all five providers. Access it directly:

```typescript
import { DEFAULT_PRICING_TABLE } from '@diabolicallabs/llm-pricing';

console.log(DEFAULT_PRICING_TABLE.versionedAt); // '2026-05-18'

// Consumer override — merge your rates over the defaults
const cost = computeCost({
  usage: response.usage,
  provider: 'openai',
  model: 'gpt-5.5',
  pricingTable: {
    ...DEFAULT_PRICING_TABLE,
    openai: {
      'gpt-5.5': { inputPer1M: 4.5, outputPer1M: 28.0, verifiedAt: '2026-05-14', sourceUrl: 'internal' },
    },
  },
});
```

### `versionedAt` — staleness detection

`DEFAULT_PRICING_TABLE.versionedAt` is an ISO 8601 date string. Consumers who need freshness guarantees can check it at startup:

```typescript
import { DEFAULT_PRICING_TABLE } from '@diabolicallabs/llm-pricing';

const ageInDays =
  (Date.now() - new Date(DEFAULT_PRICING_TABLE.versionedAt).getTime()) / 86_400_000;

if (ageInDays > 90) {
  console.warn(
    `llm-pricing default table is ${Math.floor(ageInDays)} days old — consider updating @diabolicallabs/llm-pricing`
  );
}
```

The Agent Spend Dashboard surfaces `versionedAt` in its UI so operators can see when the table was last confirmed.

## Remote table (v0.2.0)

`fetchRemoteTable()` fetches a `PricingTable` from a URL (typically the canonical `pricing/table.json` in the dlabs-toolkit repo) with an in-memory stale-while-revalidate cache. It **never throws** — on any failure it returns the bundled `DEFAULT_PRICING_TABLE`.

```typescript
import { fetchRemoteTable, computeCost } from '@diabolicallabs/llm-pricing';

const CANONICAL_URL =
  'https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/table.json';

const result = await fetchRemoteTable(CANONICAL_URL);
// result.source — 'remote' | 'cache' | 'fallback'
// result.table  — the resolved PricingTable
// result.error  — set when source === 'fallback'

const cost = computeCost({
  usage: response.usage,
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  pricingTable: result.table,
});
```

When used with `@diabolicallabs/llm-client@^3.0.0`, set `pricing.remoteUrl` on `createClient()` to wire this automatically — you don't need to call `fetchRemoteTable()` directly.

### Precedence (highest → lowest)

| Source | How |
|---|---|
| `pricing.table` on `createClient()` | Consumer-explicit static override — always wins |
| `pricing.remoteUrl` on `createClient()` | Fetched once on init, cached per TTL |
| `DEFAULT_PRICING_TABLE` | Bundled fallback — always available |

### Cache TTL

Default: **24 hours** (`cacheTtlMs: 24 * 60 * 60 * 1000`).

Rationale: GitHub raw fetches are cheap but bounded. 24h matches the realistic provider-repricing cadence — faster wouldn't catch drift sooner; slower starts to lag noticeably. Override via `options.cacheTtlMs`.

### Fail-safe contract

On any failure (network error, HTTP non-2xx, JSON parse error, schema validation failure, 5s connect timeout), `fetchRemoteTable()` returns `{ source: 'fallback', table: DEFAULT_PRICING_TABLE }` and emits a `pricing_fetch_failed` event via the configured `PricingLogger`. With the default logger that materializes as:

```json
{ "level": "warn", "event": "pricing_fetch_failed", "url": "...", "error": "...", "fallback": "DEFAULT_PRICING_TABLE" }
```

written to stdout. See [Logging](#logging) below to override the logger.

Pricing failures never crash LLM requests — degraded mode (bundled table) is always preferable to an exception.

### Testing

Use `clearPricingCache(url?)` to reset the in-memory cache between tests:

```typescript
import { clearPricingCache } from '@diabolicallabs/llm-pricing';

beforeEach(() => clearPricingCache());
```

## Provider-specific behavior

### Anthropic — prompt cache

Anthropic has two cache write tiers. The toolkit's `providerOptions.promptCache: 'ephemeral'` wires the **5-minute tier**. Both rates are in the pricing table:

| Field | Applies to |
|---|---|
| `cacheWritePer1M` | 5-min ephemeral write (toolkit wired) |
| `cacheWrite1hPer1M` | 1-hr write (reserved for future `LlmUsage` field) |

`cacheCreationTokens` in `LlmUsage` maps to the 5-min write rate. The 1-hr rate is not applied until a `cacheWrite1hTokens` field ships.

### Gemini — long-context tiering

`gemini-3.1-pro-preview` and `gemini-2.5-pro` have two price tiers. `computeCost()` picks the tier automatically based on `usage.inputTokens`:

- `inputTokens ≤ 200 000` → standard rates (`inputPer1M`, `outputPer1M`)
- `inputTokens > 200 000` → elevated rates (`longContextInputPer1M`, `longContextOutputPer1M`)

`gemini-2.5-flash` has flat pricing — no tiering.

### OpenAI — reasoning models (`o3`, `o4-mini`)

O-series models bill reasoning tokens against `outputPer1M` but do not return them in the response. `usage.outputTokens` is therefore higher than visible output tokens. `computeCost()` returns the correct billing total but sets `isPartial: true` so consumers know the visible output cost is a floor, not the exact computation cost.

### DeepSeek — deprecated aliases

`deepseek-chat` and `deepseek-reasoner` are deprecated upstream — both now route to `deepseek-v4-flash` server-side. The pricing table includes them with the same rates as `deepseek-v4-flash`. `computeCost()` emits a `pricing_deprecated_alias` log event (via the configured `PricingLogger`, see [Logging](#logging)) when it resolves through a deprecated alias.

Use the canonical IDs:

| Canonical | Notes |
|---|---|
| `deepseek-v4-flash` | General + reasoning (thinking mode). Default. |
| `deepseek-v4-pro` | High-capability. Promotional discount expires 2026-05-31. |

### Perplexity — partial coverage

Perplexity bills token costs **plus** per-request fees based on search context size. `computeCost()` covers token costs only. `sonar-deep-research` additionally has citation token, search query, and reasoning token fees not in `LlmUsage`. For these models, `cost.isPartial` is always `true` — the total is a floor.

## Logging

`@diabolicallabs/llm-pricing` emits diagnostic events for four conditions:

| Event | When |
|---|---|
| `pricing_deprecated_alias` | A deprecated model alias resolved (e.g. `deepseek-chat` → `deepseek-v4-flash`) |
| `pricing_date_strip_fallback` | A dated model ID matched its base alias via date-strip (e.g. `gpt-5.4-mini-2026-03-17` → `gpt-5.4-mini`) |
| `pricing_unknown_model` | No pricing data for `(provider, model)` — returns zero cost with `isPartial: true` |
| `pricing_fetch_failed` | `fetchRemoteTable()` fell back to the bundled table |

Each event fires **once per unique key per process lifetime** so high-volume callers don't spam logs.

### Default behavior — structured JSON to stdout

The default logger writes one line per event to `stdout` using `console.log`:

```json
{ "level": "warn", "event": "pricing_date_strip_fallback", "provider": "openai", "model": "gpt-5.4-mini-2026-03-17", "alias": "gpt-5.4-mini" }
```

Stdout (not stderr) is deliberate — log ingesters that classify severity by stream (Railway, many GCP/AWS log routers) would otherwise label every warning as `severity: error`. The structured `level` field carries the intent without forcing a false-error classification on every consumer.

### Override — `setPricingLogger()`

Swap the logger at bootstrap to integrate with your app's logger or restore human-readable output:

```typescript
import { setPricingLogger } from '@diabolicallabs/llm-pricing';

// CLI tool — human-readable stderr
setPricingLogger({
  warn: (event, data) => console.warn(`[${event}]`, data),
});

// Pino / Winston / Datadog
setPricingLogger({
  warn: (event, data) => myAppLogger.warn({ event, ...data }, event),
});

// Reset to the default (structured JSON to stdout)
setPricingLogger(null);
```

The `PricingLogger` type is exported for typed implementations:

```typescript
import type { PricingLogger } from '@diabolicallabs/llm-pricing';
```

## Maintenance

This package uses a monthly Perplexity drift check + quarterly baseline refresh (Option D from the pricing maintenance brief).

### `pnpm pricing:verify`

Run this before merging a pricing table PR to confirm table values are in the expected ballpark:

```bash
set -a; source .env; set +a
pnpm pricing:verify
# Optional: custom threshold (default 10%)
pnpm pricing:verify --threshold=5
```

Requires `PERPLEXITY_API_KEY`. Queries Perplexity `sonar` once per provider, prints a diff table, and exits non-zero if any model's detected price differs by more than the threshold. **Never auto-updates the table** — detected drift triggers a human-verified research refresh.

### Monthly drift check (v0.2.0+ hybrid model)

A Routine running on the first of each month queries Perplexity `sonar` for all provider prices and diffs against `pricing/table.json`. Detection threshold: 5% on input or output. When drift is detected, the Routine opens a PR directly against `pricing/table.json` with the diffed price changes — no code change, no npm release needed.

**Refresh workflow (v0.2.0+):**
1. Routine detects drift → opens a PR with updated `pricing/table.json`.
2. Sable reviews + runs `pnpm pricing:verify`, then merges.
3. After merge: run `node pricing/sync-bundled.mjs` to regenerate `table.ts`, commit both files together.
4. Consumers using `pricing.remoteUrl` pick up the change on next process restart (no npm release needed).
5. When bundled table is stale enough to warrant a release, bump `llm-pricing` and publish normally.

This is lighter than the v0.1.0 flow which required a full release cycle per price fix.

### Reporting a pricing error

If you notice a rate that appears wrong:

1. Check the official provider pricing page (links in `ModelPricing.sourceUrl`).
2. Edit `pricing/table.json` directly via GitHub — or open an issue with label `pricing-drift`, title: `[pricing-drift] {provider} {model} — detected rate: {X}, table rate: {Y}`.
3. Tom will verify; Sable opens a PR against `pricing/table.json`.

## License

MIT — see [LICENSE](../../LICENSE)
