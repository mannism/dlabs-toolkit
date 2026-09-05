---
'@diabolicallabs/llm-client': minor
---

feat(capabilities): add gpt-6-astra and claude-fable-5-1 capability rows

`gpt-6-astra` (contextWindow 1,050,000, maxOutputTokens 128,000) and `claude-fable-5-1`
(contextWindow 1,000,000, maxOutputTokens 128,000) are now resolvable in
`resolveModelCapabilities()`. `claude-fable-5-1` mirrors `claude-fable-5`'s shape exactly
for tool/streaming/reasoning-effort fields — same-tier model, no new schema introduced.
`gpt-6-astra` mirrors the `gpt-5.6-sol` shape (reasoning model, image+text input, text
output); its long-context pricing tier is a `@diabolicallabs/llm-pricing`-only concern
and is not represented here.
