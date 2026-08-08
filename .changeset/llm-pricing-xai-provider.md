---
"@diabolicallabs/llm-pricing": minor
---

Add `xai` as a first-class provider. `Provider` union now includes `'xai'`, `PricingTable` gains an `xai: Record<string, ModelPricing>` key, and the bundled table ships one model: `grok-4.5` ($2/$6 per 1M input/output, sub-200K tier; $4/$12 long-context tier above 200K input tokens, same threshold shape as `gemini-3.1-pro`). Verified live against `docs.x.ai/developers/models/grok-4.5` 2026-07-25.

Updated every site in the package that enumerates all providers to include `xai`: `PricingTable`/`Provider` in `types.ts`, `REQUIRED_PROVIDERS` in `fetch-remote.ts` (remote-table schema validation), and the canonical `pricing/table.json` + `pricing/table.schema.json` + `pricing/sync-bundled.mjs` codegen pipeline that regenerates `src/table.ts`.

This is additive only — no existing provider's shape or any exported function signature changed. **Downstream flag:** any consumer doing an exhaustive `switch`/if-chain over `Provider` without a `default` case will now fail to typecheck until it adds an `'xai'` arm. This is intentional — TypeScript should catch the gap at compile time, not at runtime. No currently known downstream consumer (GEOAudit, FitCheckerApp, labs) does this today per a repo grep at the time of writing, but caret-range consumers should re-typecheck after upgrading.
