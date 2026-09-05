---
'@diabolicallabs/llm-pricing': minor
---

feat(pricing): add claude-fable-5-1, claude-mythos-5-1, gpt-6-astra, gpt-5/mini/nano/pro rows; fix gpt-5.6-sol drift

**New rows:**
- `claude-fable-5-1` / `claude-mythos-5-1`: $10/$50 per 1M input/output, same tier as
  `claude-fable-5`/`claude-mythos-5`. Cache reads are priced at **0.25/1M — a 0.025x
  multiplier on base input**, not the standard 0.1x every other Claude model in this
  table uses. This is Anthropic's own documented rate (pricing page footnote), not an
  error — do not "correct" it toward `inputPer1M * 0.1`.
- `gpt-6-astra`: $10/$50/$1.00 standard tier, reasoning model (invisible reasoning
  tokens like the rest of the o-series/gpt-5.6 family). Carries a long-context billing
  tier: prompts over 272K input tokens bill the **entire request** at 2x input/cache
  and 1.5x output rates (`longContextThreshold`/`longContextInputPer1M`/
  `longContextOutputPer1M`/`longContextCacheReadPer1M`).
- `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`: coverage gap fill — these were live
  on OpenAI's pricing page but absent from the table entirely.

**Correction — `gpt-5.6-sol` was mispriced by up to 33%.** The table had $5.00/$30.00/
$0.50 (sourced from a secondary aggregator, `verifiedAt: 2026-07-25`). Live
`developers.openai.com/api/docs/pricing` confirms **$4.00/$20.00/$0.40** — independently
corroborated by `gpt-6-astra` pricing being exactly 2.5x this corrected rate.
**Downstream consumers on caret ranges (GEOAudit is a confirmed live consumer) will see
reported Sol output costs drop ~33% on upgrade. This is a correction of a pre-existing
overcharge in cost reporting, not a regression — do not revert.**

**Notes-only (no price change):** `gemini-3.6-flash`/`3.7-flash`/`3.8-flash` now carry a
`notes` field flagging that current pricing is introductory through 2026-12-31, doubling
to $1.50/$7.50 (cacheRead $0.15) from 2027-01-01 — so the January jump isn't mis-flagged
as drift by the monthly n8n check.

All figures live-verified against vendor primary sources on 2026-09-05 (see
`proj-plan/dlabs-toolkit/research/mano-pricing-audit-2026-09-05.md`).
