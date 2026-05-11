---
"@diabolicallabs/llm-client": patch
---

feat(llm-client): opt-in Anthropic prompt cache via providerOptions.promptCache

Pass `providerOptions: { promptCache: 'ephemeral' }` on any Anthropic call to inject
`cache_control: { type: 'ephemeral' }` on the system message block (and on the tool
definition in strict structured mode). Anthropic caches the block for 5 minutes;
reads cost 0.10× and writes cost 1.25× normal input price.

All four code paths covered: complete(), stream(), structured() strict tool-use, and
structuredPromptFallback() (via delegation to complete()). Non-Anthropic providers
ignore the option — no behavioral change for existing callers.

Cache tokens surface in LlmUsage.cacheCreationTokens and LlmUsage.cacheReadTokens,
which were already mapped by normalizeUsage() but now have explicit test coverage.
