---
"@diabolicallabs/llm-pricing": patch
---

Add `gemini-3.7-flash` pricing, reprice `gemini-3.6-flash` to match introductory rate

Google shipped `gemini-3.7-flash` (stable GA) on 2026-08-13 and repriced `gemini-3.6-flash`
down to match its introductory rate ($0.75/$3.75/$0.075 per 1M input/output/cache-read tokens,
in effect through 2026-12-31). Verified against https://ai.google.dev/gemini-api/docs/pricing.
