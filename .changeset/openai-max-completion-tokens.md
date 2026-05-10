---
"@diabolicallabs/llm-client": patch
---

Fix OpenAI provider to use `max_completion_tokens` instead of legacy `max_tokens`. Reasoning models in the gpt-5.x family (`gpt-5.5`, `gpt-5.4-mini`) reject `max_tokens` outright with HTTP 400 ("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), and the OpenAI SDK does not auto-translate. The provider now emits `max_completion_tokens` from `complete()`, `stream()`, and both `structured()` paths (strict and prompt-fallback). Universally accepted by all current OpenAI chat models — no `LlmCallOptions` API change.

Reasoning-model semantics to be aware of: on gpt-5.x, o1, and o3, `max_completion_tokens` is the combined budget for invisible reasoning tokens AND visible output tokens. Setting `maxTokens: 50` on `gpt-5.5` can yield empty visible content because the model spends the full budget on reasoning. Set `maxTokens` ≥ 1024 against reasoning models to leave headroom for visible output.
