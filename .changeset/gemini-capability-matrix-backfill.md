---
"@diabolicallabs/llm-client": minor
---

feat(gemini): backfill capability matrix for gemini-3.7-flash, gemini-3-flash-preview, gemini-2.5-flash-lite

`pricing/table.json` (via `@diabolicallabs/llm-pricing`) has carried pricing data for
`gemini-3.7-flash`, `gemini-3-flash-preview`, and `gemini-2.5-flash-lite` since earlier
Gemini refreshes, but `capabilities.ts` never gained matching entries.
`getModelCapabilities('gemini', ...)` returned `null` (unknown model) for all three
despite each being a real, callable Gemini model with legitimate pricing data.

All three now resolve to the correct `ModelCapabilities` shape: `contextWindow:
1_048_576`, `maxOutputTokens: 65_536`, `tools: true`, same provider-wide Gemini
constants as every other entry in the block (streaming, media input, structured
output, etc.). `gemini-3.7-flash` and `gemini-3-flash-preview` get
`reasoningEffort: 'gemini-thinking-level'` (3.x-series `thinkingConfig.thinkingLevel`
dialect); `gemini-2.5-flash-lite` gets `reasoningEffort: null` — it supports Gemini
thinking, but via the older 2.5-series `thinkingConfig.thinkingBudget` dialect, which
this field does not encode (same pattern as the existing `gemini-2.5-flash` entry).
Verified live against `ai.google.dev/gemini-api/docs/models/{id}` (2026-08-18).

Also confirmed and documented: the bare, non-preview `gemini-3.1-pro` ID (as opposed
to `gemini-3.1-pro-preview`, which is real) was never actually shipped by Google —
a phantom entry. It is intentionally NOT added to the capability matrix. Its pricing
row is removed from `pricing/table.json` in a companion `@diabolicallabs/llm-pricing`
patch changeset in this same PR.

**Minor, not patch:** this adds new capability data for previously-unknown model IDs —
additive new API surface (three new resolvable keys), not a change to any existing
model's behavior. Same reasoning as prior capability-matrix backfills (e.g. the
gpt-5.4-pro/nano + gemini-3.5-flash-lite/3.6-flash rows in 6.4.0).
