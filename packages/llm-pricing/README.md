# @diabolicallabs/llm-pricing

Pricing table + cost computation for `@diabolicallabs/llm-client`. Converts `LlmUsage` token counts to per-call USD cost breakdowns across all five supported providers. © Diabolical Labs

## Status

**v0.1.0** — Default pricing table verified 2026-05-13. Covers Anthropic, OpenAI, Gemini, DeepSeek, Perplexity.

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

console.log(DEFAULT_PRICING_TABLE.versionedAt); // '2026-05-13'

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

`deepseek-chat` and `deepseek-reasoner` are deprecated upstream — both now route to `deepseek-v4-flash` server-side. The pricing table includes them with the same rates as `deepseek-v4-flash`. `computeCost()` emits a `console.warn` when it resolves through a deprecated alias.

Use the canonical IDs:

| Canonical | Notes |
|---|---|
| `deepseek-v4-flash` | General + reasoning (thinking mode). Default. |
| `deepseek-v4-pro` | High-capability. Promotional discount expires 2026-05-31. |

### Perplexity — partial coverage

Perplexity bills token costs **plus** per-request fees based on search context size. `computeCost()` covers token costs only. `sonar-deep-research` additionally has citation token, search query, and reasoning token fees not in `LlmUsage`. For these models, `cost.isPartial` is always `true` — the total is a floor.

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

### Monthly drift check

A Routine running on the first of each month queries Perplexity `sonar` for all provider prices and diffs against the current table values. Detection threshold: 5% on input or output. When drift is detected, the Routine posts an alert to the `#repos` Slack channel. Tom triages within 48 hours and determines whether a full research refresh is warranted.

The Routine is detection only — it never auto-updates the table. All table changes require human-verified research before any PR is opened.

### Reporting a pricing error

If you notice a rate that appears wrong:

1. Check the official provider pricing page (links in `ModelPricing.sourceUrl`).
2. Open a GitHub issue in `dlabs-toolkit` with label `pricing-drift`, title: `[pricing-drift] {provider} {model} — detected rate: {X}, table rate: {Y}`.
3. Tom will run a full research refresh; Sable will open a PR.

## License

MIT — see [LICENSE](../../LICENSE)
