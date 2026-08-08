---
'@diabolicallabs/llm-client': minor
---

feat(capabilities): add claude-fable-5, claude-opus-4-8, claude-sonnet-5 to capability matrix

Registers the 3 models already priced in `@diabolicallabs/llm-pricing`'s
`pricing/table.json` but missing from `getModelCapabilities()`. All three
now resolve their full descriptor instead of `null`.

- `claude-fable-5` / `claude-opus-4-8` / `claude-sonnet-5`: contextWindow
  1,000,000, maxOutputTokens 128,000 — same shape as sibling `claude-opus-5`.
  Verified against platform.claude.com/docs/en/about-claude/models/overview.
- All three confirmed to support `output_config.effort`
  (`reasoningEffort: 'anthropic-effort'`) via platform.claude.com/docs/en/build-with-claude/effort's
  "Supported models" list.
