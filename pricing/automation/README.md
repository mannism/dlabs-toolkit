# llm-pricing drift-check automation

Monthly n8n workflow that detects price drift and new models in `@diabolicallabs/llm-pricing`'s default pricing table.

---

## What it is

An evergreen monthly workflow. On the 1st of each month at 07:30 SGT it:

1. Fetches the **live** `pricing/table.json` directly from GitHub — no price values are embedded in the workflow itself. Every run reflects the current state of the table.
2. Sends the full model list to Perplexity (`sonar`) in two HTTP calls: one asking for current per-token prices for every model already in the table (drift check), one asking for all currently GA flagship and workhorse models from the same providers (new-model detection).
3. Compares results **deterministically** in a Code node — no LLM in the comparison step. Threshold: 5% on either input or output price triggers a DRIFT classification.
4. Writes a single ✅/⚠️ row to the **Scheduled Work** Notion database on every run. A `✅ Completed` row means no drift and no new candidates. A `⚠️ Pending` row means one or more models drifted or a new GA model was detected.

**Detection only.** This workflow never edits `pricing/table.json`. It is the front-end that triggers the triage flow documented in `../README.md`.

**Evergreen design.** The model list and price values are always derived from the fetched live table at runtime. When the table is updated, the workflow automatically checks the new set of models on the next run — no workflow edits required.

---

## Flow (7 nodes)

```
Monthly 07:30 SGT
  → Fetch live table.json
    → Build queries
      → Perplexity — drift
        → Perplexity — new models
          → Compare (deterministic)
            → Create Scheduled Work row
```

| # | Node name | Type | Purpose |
|---|---|---|---|
| 1 | `Monthly 07:30 SGT` | Schedule Trigger | Fires on the 1st of each month at 07:30 (`Asia/Singapore`) |
| 2 | `Fetch live table.json` | HTTP Request | GETs the raw `pricing/table.json` from GitHub — the live source for all comparisons |
| 3 | `Build queries` | Code | Extracts provider/model keys from the fetched table; builds the two Perplexity prompt strings at runtime |
| 4 | `Perplexity — drift` | HTTP Request | Asks Perplexity for current per-token prices for every model already in the table |
| 5 | `Perplexity — new models` | HTTP Request | Asks Perplexity for all currently GA flagship/workhorse models across the same providers |
| 6 | `Compare (deterministic)` | Code | Diffs table vs. detected prices (5% threshold); identifies model keys absent from the table; builds the Notion row content |
| 7 | `Create Scheduled Work row` | Notion | Creates the ✅/⚠️ page in the Scheduled Work database |

---

## Prerequisites

- **Self-hosted n8n** (tested on `wf.dianaismail.me`).
- A **Perplexity credential** configured in n8n (credential type `perplexityApi`). Used by nodes 4 and 5.
- A **Notion credential** configured in n8n (`notionApi`). Used by node 7.
- The Notion credential's integration must have access to the **Scheduled Work** database (see gotcha in step 3 below).

---

## Install

1. In n8n: **Workflows → Import from File** → select `llm-pricing-drift-check.n8n.json`.

   Or import from URL once merged:
   ```
   https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/automation/llm-pricing-drift-check.n8n.json
   ```

2. **Reattach credentials.** Imported workflows always land with placeholder credential IDs — the two `Perplexity — drift` / `Perplexity — new models` HTTP nodes and the `Create Scheduled Work row` Notion node each need their credential selected from your n8n credential store.

3. **Notion connection gotcha.** The Notion *integration* used by the credential must be explicitly added to the Scheduled Work database. In Notion: open the Scheduled Work DB → `⋯` menu → **Connections** → add your integration. Without this step n8n shows "Error fetching options from Notion" and the create step will 403.

4. **Perplexity auth note.** The two HTTP nodes use `predefinedCredentialType: perplexityApi`. If your n8n instance does not expose that credential type, switch both nodes to **Generic Credential → Header Auth** with header `Authorization: Bearer <your-key>` — the endpoint URL and request body are identical.

5. **`Status` property type.** The Notion `Status` property on the Scheduled Work DB is a **status-type** property, not a select. If the property dropdown in the Notion node does not show it, upgrade the Notion node to v2.2+. `Job` and `Project Name` are selects and map cleanly.

6. **Manual test run.** Click **Execute Workflow** once to verify a row lands in Scheduled Work. Any expired-promo or changed models will appear under DRIFT in the row body.

7. **Enable the workflow** and confirm the schedule trigger is active. Timezone is baked in as `Asia/Singapore` — 07:30 SGT.

---

## How to update

### Pricing changes

No workflow edit needed. The workflow fetches `pricing/table.json` live on every run. When the table is updated (via the triage path below), the next scheduled run automatically uses the new values.

### Workflow logic changes

Edit the JSON in this directory, re-import into n8n (**Workflows → Import from File** → overwrite), and commit the updated JSON here. Keep the JSON file and the running workflow in sync.

### Detection-only + triage path

A `⚠️ Pending` row triggers the local triage flow:

1. **Tom** verifies: runs `pnpm pricing:verify` from `packages/llm-pricing/` with a live `PERPLEXITY_API_KEY`, then cross-references each DRIFT model against the official provider pricing page (`ModelPricing.sourceUrl` in `packages/llm-pricing/src/table.ts`).
2. If confirmed: **Sable** opens a PR against `pricing/table.json` with corrected rates and an updated `versionedAt`.
3. After merge: run `node pricing/sync-bundled.mjs` to regenerate `packages/llm-pricing/src/table.ts`. Commit both files in a single `fix(pricing):` commit.
4. If unconfirmed (Perplexity false positive): Tom notes it in the Notion page — no PR opened.

### Back-compat guardrail

Table updates **never delete existing model keys**. Consumers may still call older models (e.g., `claude-haiku-3-5`, `gpt-4o`) and a missing key breaks their cost computation silently. When an older model's price changes, its rate is updated in place — the key is not removed.

---

## Failure modes

| Failure | Behavior | Action |
|---|---|---|
| `Fetch live table.json` fails (Node 2) | Run logs as failed — no Notion row created | Absence of a monthly row is itself a health signal; retrigger manually via n8n dashboard |
| Perplexity node fails (Node 4 or 5) | Same — no row created | Check Perplexity API status; retrigger manually |
| Notion node fails (Node 7) | Comparison ran but row not written | Check Notion credential expiry and integration connection; retrigger manually |
| All models return UNVERIFIABLE | Row created: `✅ Completed` with all-unverifiable body | Informational only — quarterly baseline refresh catches persistent gaps |
| False positive DRIFT | Row created: `⚠️ Pending` | Tom triage step catches before any PR is opened — false positives are cheap, a missed real drift is not |

---

## Links

- **Narrative spec:** `/Users/mann/Documents/Claude/routines/llm-pricing-drift-check.md`
- **Brief:** `/Users/mann/Documents/Claude/proj-plan/dlabs-toolkit/briefs/brief-llm-pricing-drift-n8n.md`
- **Fleet scheduler registry:** `/Users/mann/Documents/Claude/schedulers.md` — the canonical entry for this job lives there
- **Pricing data + refresh workflow:** [`../README.md`](../README.md)
