# llm-pricing drift-check automation

Monthly n8n workflow that detects price drift and new models in `@diabolicallabs/llm-pricing`'s default pricing table.

---

## What it is

An evergreen monthly workflow. On the 1st of each month at 07:30 SGT it:

1. Fetches the **live** `pricing/table.json` directly from GitHub — no price values are embedded in the workflow itself. Every run reflects the current state of the table.
2. Builds **one item per provider** and sends each provider to Perplexity (`sonar-pro`, `temperature: 0`) in two HTTP calls: a drift lookup (current standard list price plus lifecycle status and shutdown date for every model already in the table) and a new-models lookup (every currently offered model not in the table's known list). Both calls use `search_domain_filter`, built from the official pricing hosts for the provider plus the hostnames already cited in the table's own `sourceUrl` fields.
3. Compares results **deterministically** in a Code node — no LLM in the comparison step.
4. Writes a single ✅/⚠️ row to the **Scheduled Work** Notion database on every run, then appends the full report into the page body (see "Notion body paging" below). A `✅ Completed` row means no drift, no new models, no deprecations. A `⚠️ Pending` row means one or more models drifted, a new model was found, or a table model is deprecated or has a shutdown date. Cheaper-model recommendations inform triage but do not by themselves set the status to Pending.

**v2.1 prompt hardening (2026-10-06).** The drift prompt now requires the Standard tier (on-demand, synchronous, short-context, uncached) and an exact model-id match; Batch, Flex, Priority, cached-input, promotional and long-context prices must not be reported. This fixes the five false drifts of the first live run on 2026-10-05 (`o3`, `o4-mini`, `gemini-3-flash-preview`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`), which were Batch/Flex prices or another model's price. The Compare node adds the SUSPECT guard described below as a second line of defense. After merging, re-import the JSON into n8n in place.

**Detection only.** This workflow never edits `pricing/table.json`. It is the front-end that triggers the triage flow below.

**Evergreen design.** Providers, model ids and source domains are always derived from the fetched live table at runtime. When the table is updated, the workflow automatically checks the new set of models on the next run — no workflow edits required.

### What the Compare node reports

The Notion row body can contain these sections, in this order (each only when non-empty):

- **Coverage gaps** — provider lookups that failed or returned unparseable output. Absence of news for those providers means nothing that month.
- **New models + recommendations** — models the provider currently offers that are not in the table, with the predecessor (the provider-stated `replaces` if it is in the table, else the highest older version in the same family) and a recommendation based on **blended price** at a 3:1 input:output token mix, `(3 × input + 1 × output) / 4` per 1M tokens:
  - `CHEAPER` — blended price at least 10% below the predecessor.
  - `SAME PRICE` — within 10% either way.
  - `PRICIER` — at least 10% above the predecessor.
  - No predecessor found, or price missing, is stated as such (`NEW` / `PRICE UNVERIFIED`).
- **Cheaper successors already in the table** — the newest model in a family is at least 10% cheaper (blended) than the one before it.
- **Price drift** — input or output price differs from the table by 5% or more. Only counts lookups that pass the SUSPECT guard below.
- **SUSPECT DRIFT — NOT COUNTED** (v2.1) — drifts that look like a lookup error rather than a real price change: both prices are exactly 0.5x the table (the Batch/Flex tier) or the detected prices equal another model's table price from the same provider (a model-id mix-up). Listed for a spot-check but excluded from the DRIFT count and from the Pending/Completed decision, so a SUSPECT-only run stays `✅ Completed`. A genuine 50% price cut is possible, so the row asks for a spot-check against the official page.
- **Deprecated / retiring** — table models the provider now marks deprecated or retired, or gives a shutdown date for. Deprecated-alias entries (`deprecatedAliasFor`) are skipped.
- **Unverifiable** — no reliable price found for a table model.
- **Stale verification** — table entries whose `verifiedAt` is more than 90 days old (informational).

Limits and filters: at most **25** new-model candidates are listed (sorted cheapest-first, the overflow count is noted in the row); non-text models (embeddings, image, video, audio/speech, realtime, moderation, rerank) are ignored and counted. The row ends with a `NEXT STEP` line pointing at `/llm-pricing-triage` when there is anything to act on.

### Notion body paging

Notion caps a rich-text property at 2,000 characters, so the row's `Long form issue details` property carries only a short summary. The full report is chunked (at most 1,900 characters per chunk) by the Compare node, and the `Split body into blocks` and `Append blocks` nodes append one paragraph block per chunk to the created page.

---

## Flow (10 nodes)

```
Monthly 07:30 SGT
  → Fetch live table.json
    → Build queries              (one item per provider)
      → Perplexity — drift       (per provider)
        → Perplexity — new models (per provider)
          → Compare (deterministic)
            → Create Scheduled Work row
              → Split body into blocks
                → Append blocks
```

Plus a `Setup Notes` sticky note on the canvas (the tenth node), summarizing the v2 behavior.

| # | Node name | Type | Purpose |
|---|---|---|---|
| 1 | `Monthly 07:30 SGT` | Schedule Trigger | Fires on the 1st of each month at 07:30 (`Asia/Singapore`) — day-of-month and time are set explicitly |
| 2 | `Fetch live table.json` | HTTP Request | GETs the raw `pricing/table.json` from GitHub — the live source for all comparisons |
| 3 | `Build queries` | Code | Extracts providers and model keys from the fetched table; emits one item per provider with its drift prompt, new-models prompt and domain filter list |
| 4 | `Perplexity — drift` | HTTP Request | Per provider: `sonar-pro` lookup of current standard price and lifecycle status for every table model |
| 5 | `Perplexity — new models` | HTTP Request | Per provider: `sonar-pro` lookup of currently offered models not in the known list |
| 6 | `Compare (deterministic)` | Code | Diffs table vs. detected data, builds recommendations, the Notion summary and the chunked body |
| 7 | `Create Scheduled Work row` | Notion | Creates the ✅/⚠️ page in the Scheduled Work database |
| 8 | `Split body into blocks` | Code | Fans the chunked report out to one item per chunk |
| 9 | `Append blocks` | Notion | Appends each chunk as a paragraph block on the new page |
| 10 | `Setup Notes` | Sticky Note | In-canvas summary of behavior (not part of the data flow) |

The HTTP nodes and the Fetch node are set to continue on error, so a failed lookup is reported inside the row instead of aborting the run.

---

## Prerequisites

- **Self-hosted n8n** (tested on `wf.dianaismail.me`).
- A **Perplexity credential** configured in n8n (credential type `perplexityApi`). Used by nodes 4 and 5.
- A **Notion credential** configured in n8n (`notionApi`). Used by nodes 7 and 9.
- The Notion credential's integration must have access to the **Scheduled Work** database (see gotcha in step 3 below).

---

## Install

1. In n8n: **Workflows → Import from File** → select `llm-pricing-drift-check.n8n.json`.

   Or import from URL once merged:
   ```
   https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/automation/llm-pricing-drift-check.n8n.json
   ```

2. **Reattach credentials.** Imported workflows always land with placeholder credential IDs — the two `Perplexity — drift` / `Perplexity — new models` HTTP nodes and the two Notion nodes (`Create Scheduled Work row`, `Append blocks`) each need their credential selected from your n8n credential store.

3. **Notion connection gotcha.** The Notion *integration* used by the credential must be explicitly added to the Scheduled Work database. In Notion: open the Scheduled Work DB → `⋯` menu → **Connections** → add your integration. Without this step n8n shows "Error fetching options from Notion" and the create step will 403.

4. **Perplexity auth note.** The two HTTP nodes use `predefinedCredentialType: perplexityApi`. If your n8n instance does not expose that credential type, switch both nodes to **Generic Credential → Header Auth** with header `Authorization: Bearer <your-key>` — the endpoint URL and request body are identical.

5. **`Status` property type.** The Notion `Status` property on the Scheduled Work DB is a **status-type** property, not a select. If the property dropdown in the Notion node does not show it, upgrade the Notion node to v2.2+. `Job` and `Project Name` are selects and map cleanly.

6. **Manual test run.** Click **Execute Workflow** once to verify a row lands in Scheduled Work. Any expired-promo or changed models will appear under DRIFT in the row body.

7. **Enable the workflow** and confirm the schedule trigger is active. Timezone is baked in as `Asia/Singapore`. Check the trigger on import: the trigger is explicitly the 1st of the month at 07:30 SGT, but an earlier export of this workflow had 04:30 with no day of month set — confirm the imported node shows day 1, 07:30.

8. **Perplexity Sonar support.** Perplexity ended Sonar Chat Completions support on 2026-09-27 (see the `sonar` entries' notes in `table.json`). The `api.perplexity.ai/chat/completions` calls were still working on 2026-10-05. Watch for breakage: if both lookups start failing for every provider, the row becomes a single `Perplexity lookups failed` row and the nodes need migrating to the Agent API.

---

## How to update

### Pricing changes

No workflow edit needed. The workflow fetches `pricing/table.json` live on every run. When the table is updated (via the triage path below), the next scheduled run automatically uses the new values.

### Workflow logic changes

Edit the JSON in this directory, re-import into n8n (**Workflows → Import from File** → overwrite), and commit the updated JSON here. Keep the JSON file and the running workflow in sync.

### Detection-only + triage path

A `⚠️ Pending` row triggers the triage flow. Two routes, usable together:

- **`/llm-pricing-triage` (Claude Code skill, manual follow-up).** Reads the latest `llm-pricing drift` row from Scheduled Work, has **Tom** verify every flagged price, new model and deprecation against the official provider pages, drafts the `pricing/table.json` patch, and posts the result to fleet-console Updates. The skill is read-only on the table.
- **`pnpm pricing:verify`.** Run from `packages/llm-pricing/` with a live `PERPLEXITY_API_KEY`, then cross-reference each flagged model against the official provider pricing page (`ModelPricing.sourceUrl` in `packages/llm-pricing/src/table.ts`).

Then:

1. If confirmed: **Sable** opens a PR against `pricing/table.json` with corrected rates, new models and an updated `versionedAt`. Table edits always go via PR, never straight from the report.
2. After merge: run `node pricing/sync-bundled.mjs` to regenerate `packages/llm-pricing/src/table.ts`. Commit both files in a single `fix(pricing):` commit.
3. If unconfirmed (Perplexity false positive): Tom notes it in the Notion page — no PR opened.

### Back-compat guardrail

Table updates **never delete existing model keys**. Consumers may still call older models (e.g., `claude-haiku-3-5`, `gpt-4o`) and a missing key breaks their cost computation silently. When an older model's price changes, its rate is updated in place — the key is not removed.

---

## Failure modes

| Failure | Behavior | Action |
|---|---|---|
| `Fetch live table.json` fails (Node 2) | Run logs as failed or produces no usable table — no meaningful row | Absence of a monthly row is itself a health signal; retrigger manually via n8n dashboard |
| One provider's Perplexity lookup fails or returns unparseable JSON (Node 4 or 5) | Row still created; the provider appears under `COVERAGE GAPS` (price/lifecycle and new-model lookups are listed separately). It is not reported as per-model UNVERIFIABLE | Treat the provider as unchecked this month; run `/llm-pricing-triage` or `pnpm pricing:verify` for it, or retrigger |
| Perplexity parse failure on every provider | Single `⚠️ Pending` row titled `Perplexity lookups failed`; no comparison performed | Check Perplexity API status and the Sonar support note above; retrigger manually |
| Notion node fails (Node 7 or 9) | Comparison ran but row (or part of the body) not written | Check Notion credential expiry and integration connection; retrigger manually |
| Some models return UNVERIFIABLE | Listed in the row under UNVERIFIABLE, grouped by provider | Informational — quarterly baseline refresh catches persistent gaps |
| False positive DRIFT or new model | Row created: `⚠️ Pending` | Tom triage step catches before any PR is opened — false positives are cheap, a missed real drift is not |

---

## Links

- **Triage skill:** `/llm-pricing-triage` (Claude Code, `~/.claude/skills/llm-pricing-triage/SKILL.md`)
- **Narrative spec:** `/Users/mann/Claude/routines/llm-pricing-drift-check.md`
- **Brief:** `/Users/mann/Claude/proj-plan/dlabs-toolkit/briefs/brief-llm-pricing-drift-n8n.md`
- **Fleet scheduler registry:** `/Users/mann/Claude/schedulers.md` — the canonical entry for this job lives there
- **Pricing data + refresh workflow:** [`../README.md`](../README.md)
