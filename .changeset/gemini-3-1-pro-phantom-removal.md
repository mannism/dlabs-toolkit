---
"@diabolicallabs/llm-pricing": patch
---

fix(gemini): remove phantom gemini-3.1-pro pricing entry

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
