---
"@diabolicallabs/llm-pricing": minor
---

Add 9 new model pricing entries and reconcile the Notion drift-check flag (id `3a31040c1cf481518f7eee67b8a16206`) against official provider pricing pages, verified live 2026-07-25.

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

No existing model key was deleted or renamed; no breaking type changes. Purely additive — flagging for downstream consumers on caret ranges (GEOAudit, FitCheckerApp, labs) since this ships as a minor bump per this toolkit's Changesets convention.
