---
"@diabolicallabs/llm-pricing": minor
---

Add `gemini-3.5-flash` and `claude-opus-4-8` to the pricing table.

**New models:**

- `gemini-3.5-flash` (provider: `gemini`) — $1.50/$9.00/$0.15 (input/output/cacheRead per 1M tokens). GA 2026-05-19. Source: ai.google.dev/gemini-api/docs/pricing.
- `claude-opus-4-8` (provider: `anthropic`) — pricing per the Anthropic API pricing page. Source URL recorded in `table.ts`.

No API or behavioral changes. `computeCost` and `resolveModelPricing` return non-zero results for these models; previously they returned `isPartial: true, total: 0` (unknown model).
