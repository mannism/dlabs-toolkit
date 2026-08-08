---
'@diabolicallabs/llm-client': minor
---

feat(capabilities): add gpt-5.4-pro, gpt-5.4-nano, gemini-3.5-flash-lite, gemini-3.6-flash to capability matrix

Registers the 4 models already priced in `@diabolicallabs/llm-pricing`'s
`pricing/table.json` but missing from `getModelCapabilities()`. All four
now resolve their full descriptor instead of `null`.

- `gpt-5.4-nano`: contextWindow 400,000, maxOutputTokens 128,000 — diverges
  from sibling `gpt-5.4`/`gpt-5.4-mini` (256,000 / 32,768). Verified against
  developers.openai.com/api/docs/models/gpt-5.4-nano.
- `gpt-5.4-pro`: contextWindow 1,050,000 (rounded to 1,000,000 per the
  gpt-5.6-family convention), maxOutputTokens 128,000 — diverges from
  `gpt-5.5-pro`'s 32,768 despite matching its pricing tier. Verified against
  developers.openai.com/api/docs/models/gpt-5.4-pro.
- `gemini-3.5-flash-lite` / `gemini-3.6-flash`: contextWindow 1,048,576,
  maxOutputTokens 65,536 — same shape as sibling `gemini-3.5-flash`.
  Verified against ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
  and .../gemini-3.6-flash.

All four use `reasoningEffort: 'openai-effort'` / `'gemini-thinking-level'`
per their provider dialect, confirmed against the same live docs.
