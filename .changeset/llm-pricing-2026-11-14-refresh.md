---
"@diabolicallabs/llm-pricing": minor
---

Pricing table refresh verified 2026-11-14. Adds `claude-fable-5-2`, `claude-mythos-5-2` (limited availability), `claude-opus-4-5-20251101`, `gemini-4-carbon` (introductory $2 / $10 / $0.10; steps up to $4 / $20 / $0.20 on 2026-12-01), `gemini-4-hydrogen`, and `gemini-3.1-pro-preview-customtools`.

Computed costs change for existing models, which callers on caret ranges will see:

- `perplexity` `sonar` is repriced from $1.00 / $1.00 to the Agent API rate of $0.25 input / $2.50 output / $0.0625 cache read (the only Sonar rate Perplexity publishes). Input cost falls 75% but output cost rises 2.5x, so computed cost rises whenever output tokens exceed half of input tokens (example: 500K input / 300K output goes from $0.80 to $0.875). Still `isPartial` because tool fees are not modeled. `sonar-pro`, `sonar-reasoning-pro` and `sonar-deep-research` keep their rates, now flagged as unverified since 2026-07-25.
- `gemini-3.5-flash` is repriced from $1.50 / $9.00 / $0.15 to $0.75 / $3.75 / $0.075, the rate of `gemini-3.6-flash`, which the ID now routes to. Computed cost falls by about half. Google does not state the billing rate for routed calls, so this is unverified.
- `gpt-5.5-pro` gains a long-context tier: prompts above 272K input tokens bill the full request at $60 input / $270 output, so computed cost rises for requests above 272K input tokens (previously billed at $30 / $180 with no tier). The tier comes from the OpenAI pricing page, is not stated on the model page, and is unconfirmed.

Corrects notes for `gemini-2.5-pro` and `gemini-2.5-flash` (shutdown 2026-12-01), `gpt-5.6-sol` (promotional pricing ends 2026-11-30), the `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-pro`, `o3` and `o3-pro` replacement models, and `claude-haiku-4-5`.
