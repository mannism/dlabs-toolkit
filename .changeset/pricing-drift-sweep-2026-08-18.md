---
"@diabolicallabs/llm-pricing": patch
---

Pricing drift correction sweep (Anthropic, OpenAI, DeepSeek, xAI) — 2026-08-18

- `claude-sonnet-5`: Anthropic cancelled the planned 2026-08-31 increase to $3/$15 — the
  $2/$10 rate is now permanent standard pricing. Updated input/output/cache rates accordingly.
- `claude-haiku-3`, `claude-haiku-3-5`: added retirement notes (first-party API retired
  2026-04-20 and 2026-02-19 respectively; `claude-haiku-3-5` remains live on Bedrock/GCP).
  No price change — retained for historical cost calculations.
- `gpt-5.6-terra`: corrected — table was 25% overpriced ($2.5/$15 → $2.0/$12).
- `gpt-5.6-luna`: corrected — table was 5x overpriced ($1.0/$6.0 → $0.20/$1.20).
- `gpt-4.1`, `o1`, `o3`, `o3-mini`, `o4-mini`: added scheduled-shutdown notes
  (2026-10-23, except `o3` at 2026-12-11) per OpenAI's deprecations page.
- `deepseek-chat`, `deepseek-reasoner`: notes updated — fully retired 2026-07-24, no longer
  a live alias despite the `deprecatedAliasFor` field; API calls now error.
- `deepseek-v4-flash`, `deepseek-v4-pro`: repriced to the new off-peak baseline rate
  following DeepSeek's introduction of peak/off-peak differential pricing (peak windows
  01:00-04:00 and 06:00-10:00 UTC, ~2x off-peak). Added notes warning `computeCost()`
  does not model time-of-day pricing.
- Added `grok-4.6` (xAI's new flagship, launched 2026-08-12). Same headline input/output
  rate as `grok-4.5` ($2.0/$6.0) but cached-input pricing is ~67% higher ($0.50 vs $0.30
  base tier, $1.00 vs $0.60 long-context). Verified directly against
  https://docs.x.ai/developers/models/grok-4.6.

All changes verified against live provider docs 2026-08-18 (4-agent research sweep,
Owner-approved scope). `pricing:verify` is clean except for the expected `deepseek-v4-flash`/
`deepseek-v4-pro` peak/off-peak gap (Owner-approved: table holds off-peak baseline, matching
the existing convention for Gemini's future-dated rate hikes).
