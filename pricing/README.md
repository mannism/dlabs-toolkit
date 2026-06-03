# pricing/

Canonical pricing data for [`@diabolicallabs/llm-pricing`](../packages/llm-pricing/).

## Files

| File | Purpose |
|------|---------|
| `table.json` | Canonical remote pricing source — edit here to update prices without a code release |
| `table.schema.json` | JSON Schema for `table.json` — enables editor validation |
| `sync-bundled.mjs` | Regenerates `packages/llm-pricing/src/table.ts` from `table.json` — run after each edit |

## How pricing refresh works

### Without `remoteUrl` (default — bundled)
Consumers who do not set `pricing.remoteUrl` always use the bundled `DEFAULT_PRICING_TABLE`
that ships inside the npm package. Refreshing prices requires a new `llm-pricing` release.

### With `remoteUrl` (hybrid — opt-in)
Consumers who set `pricing.remoteUrl` to this file's raw GitHub URL get prices fetched once
per process, with a stale-while-revalidate cache (default TTL: 24 hours). A price fix
requires only a PR against `table.json` — no code change, no version bump, no consumer
redeploy. Consumers pick up the new prices on their next process restart (or next cache
expiry).

```ts
import { createClient } from '@diabolicallabs/llm-client';

const client = await createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  pricing: {
    remoteUrl: 'https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/table.json',
    cacheTtlMs: 24 * 60 * 60 * 1000, // 24 hours (default)
    computeOnEveryCall: true,
  },
});
```

### Drift detection (automation)

A monthly n8n workflow (`automation/llm-pricing-drift-check.n8n.json`) runs on the 1st of each month, fetches the live `table.json`, queries Perplexity for current prices and latest GA models, and writes a ✅/⚠️ row to the Scheduled Work Notion DB. It is the front-end that triggers the refresh flow documented above — it never edits `table.json` directly.

See [`automation/README.md`](automation/README.md) for install instructions and the full triage path.

## Editing prices

1. Edit `pricing/table.json` directly in GitHub or clone + edit locally.
2. Run `node pricing/sync-bundled.mjs` to regenerate `packages/llm-pricing/src/table.ts`.
3. Commit **both** files together: `chore(llm-pricing): refresh pricing — <provider> <date>`.
4. PR → merge → consumers using `remoteUrl` pick up the change on next process restart.

Consumers pinned to a specific npm version of `llm-pricing` continue using that version's
bundled table unaffected.

## Schema

`table.json` is validated against `table.schema.json` (JSON Schema draft-07). The schema
self-reference in `table.json` enables VS Code and other editors to show inline validation.

The remote-fetch path in `fetchRemoteTable()` also validates against this schema at runtime
and falls back to the bundled table if validation fails — pricing failures never crash LLM
calls.

## Bundled snapshot cadence

The bundled `DEFAULT_PRICING_TABLE` in `packages/llm-pricing/src/table.ts` is regenerated
from this file at build time via `sync-bundled.mjs`. It lags by the release cadence of the
npm package. The remote `table.json` is always the authoritative source.
