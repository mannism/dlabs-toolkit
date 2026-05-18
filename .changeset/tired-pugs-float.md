---
"@diabolicallabs/llm-pricing": minor
---

Add 7 new OpenAI 5.1/5.2/5.3 family models to the pricing table.

**New models:**
- `gpt-5.1` — $1.25/$10.00/$0.125 (input/output/cacheRead per 1M tokens)
- `gpt-5.1-codex-mini` — $0.25/$2.00/$0.025
- `gpt-5.2` — $1.75/$14.00/$0.175
- `gpt-5.2-pro` — $21.00/$168.00/$2.10
- `gpt-5.2-codex` — $1.75/$14.00/$0.175
- `gpt-5.3-chat-latest` — $1.75/$14.00/$0.175 (canonical API ID; no bare `gpt-5.3` in `/v1/models`)
- `gpt-5.3-codex` — $1.75/$14.00/$0.175

Model IDs empirically confirmed via OpenAI `/v1/models` on 2026-05-18. Dated variants
(`gpt-5.1-2025-11-13`, `gpt-5.2-2025-12-11`, `gpt-5.2-pro-2025-12-11`) resolve via the
existing date-strip fallback in `resolveModelPricing`.

Pricing source: portkey.ai/models/openai — multi-aggregator convergence (portkey.ai, tldl.io,
inworld.ai, helicone.ai), cross-referenced against OpenAI pricing page. Confidence: Medium.
