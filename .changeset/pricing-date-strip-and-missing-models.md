---
"@diabolicallabs/llm-pricing": minor
---

Add 13 missing models to the pricing table and fix dated model ID cost-tracking leak.

**New models:**
- Anthropic: `claude-opus-4-5`, `claude-sonnet-4-5`
- OpenAI: `gpt-5.4-nano`, `gpt-5.4-pro`, `o3-mini`, `o3-pro`, `o1`, `o1-mini`, `gpt-4o`, `gpt-4o-mini`
- Gemini: `gemini-3.1-pro` (non-preview), `gemini-3-flash-preview`, `gemini-2.5-flash-lite`

**Date-strip fallback in `resolveModelPricing`:** When an exact model ID lookup fails, strips trailing date suffixes (`-YYYY-MM-DD`, `-YYYYMMDD`, `-YYYY-MM`) and retries with the base alias. Fixes a production cost-tracking leak where the OpenAI Responses API returns dated model IDs (e.g. `gpt-5.4-mini-2026-03-17`) that previously fell through to `{ total: 0, isPartial: true }`.

**Warn-once for noisy paths:** All three console.warn paths (deprecated alias, unknown model, date-strip fallback) now fire at most once per unique `(provider, model)` pair per process lifetime. Prevents log spam in high-volume callers.

**Follow-up (out of scope):** DeepSeek cache-read price change from 2026-04-26 — tracked separately. `@diabolicallabs/llm-client` has no source change in this release; the `^0.2.0` optional peer-dep range does not include `0.3.0` (pre-1.0 caret behaviour). GEOAudit's direct `@diabolicallabs/llm-pricing: "^0.2.0"` dependency will also need a manual bump to `^0.3.0` to pick up this fix.
