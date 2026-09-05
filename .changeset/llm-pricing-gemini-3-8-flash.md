---
'@diabolicallabs/llm-pricing': minor
---

feat(gemini): add gemini-3.8-flash pricing row

`gemini-3.8-flash` (GA 2026-09-02) is now priced in `DEFAULT_PRICING_TABLE` at the same
rate as `gemini-3.7-flash`: $0.75 / $3.75 / $0.075 per 1M input/output/cache-read tokens.

**Promotional pricing ends 2027-01-01** for both `gemini-3.7-flash` and
`gemini-3.8-flash` — Google's list price rises to $1.50 / $7.50 / $0.15 per 1M tokens
from that date. Expect the January drift check to flag this as a pricing change on both
models when it fires.
