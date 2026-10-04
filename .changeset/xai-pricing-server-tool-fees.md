---
'@diabolicallabs/llm-pricing': minor
---

Add server tool fee pricing and the full current Grok model table.

- `ModelPricing.serverToolFees` (USD per unit) and exported `ServerToolUsageKey`.
- `computeCost` accepts optional `usage.serverToolUsage`, returns an optional `LlmCost.serverTools` component included in `total`, and sets `isPartial: true` when a non-zero count has no fee entry.
- xAI table now covers grok-4.7, grok-4.6, grok-4.5, grok-4.3, grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning, grok-4.20-multi-agent-0309 and grok-build-0.1, each with web search, X post, X profile, code interpreter, file search, MCP and image generation ($0.05 per image, derived from a live call) tool fees.
- Behavior change: the long-context threshold now compares total prompt tokens (`inputTokens + cacheReadTokens + cacheCreationTokens`) instead of `inputTokens` alone. A large prompt that is mostly cached now correctly takes the long-context tier for any provider that reports cache tokens separately.
