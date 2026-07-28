---
"@diabolicallabs/llm-client": minor
---

Add reasoning-effort passthrough for Anthropic, OpenAI, and Gemini — a purely additive, opt-in `reasoningEffort` field on `LlmCallOptions` that unblocks the Labs Effort-Level A/B Harness (which needs to sweep effort levels across Claude Opus 5 and GPT-5.6 and record the cost/quality curve).

**New public API:**

- `LlmReasoningEffort` type — `'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`, exported from the package root.
- `LlmCallOptions.reasoningEffort?: LlmReasoningEffort` — set on any call (`complete`, `stream`, `structured`, `streamStructured`, `withTools`).
- `LlmUsage.reasoningTokens?: number` — tokens spent on internal reasoning, populated from Anthropic's `usage.output_tokens_details.thinking_tokens` and OpenAI's `usage.output_tokens_details.reasoning_tokens`, in both the streaming and non-streaming paths. Undefined for Gemini/Perplexity/DeepSeek (no equivalent breakdown reported).
- `ModelCapabilities.reasoningEffort: 'anthropic-effort' | 'openai-effort' | 'gemini-thinking-level' | null` — a dialect tag (not a value-set enumeration); cross-reference against the new `providers/reasoning-effort.ts` module's exported per-provider value sets.

**Provider mapping (new module `providers/reasoning-effort.ts`):**

All three providers' accepted value sets differ — a value unsupported by the resolved provider throws `LlmError({ kind: 'bad_request', retryable: false })` before any SDK call:

- **Anthropic** — maps to `output_config.effort`. Accepts `low | medium | high | xhigh | max` (no `none`/`minimal`). Merges into `output_config` at all 5 call-type sites (`complete`, `stream`, `structured`, `streamStructured`, `withTools`) — never overwrites, since `OutputConfig` also carries `format`.
- **OpenAI** — maps to `reasoning.effort`. Accepts all 7 values. Merges into `reasoning` at all 6 call-type sites, including `structuredPromptFallback` and `withTools`. Sending `reasoning` to a non-reasoning model (e.g. `gpt-4.1`) returns a live HTTP 400, which normalizes to the existing `bad_request` error path — no internal pre-call capability check is added (deliberately out of scope; `getModelCapabilities()` has no model-alias resolution and is never internally consulted today).
- **Gemini** — maps to `thinkingConfig.thinkingLevel`, uppercased on the wire (`'high'` → `'HIGH'`). Accepts `minimal | low | medium | high` (no `none`/`xhigh`/`max`). Merges into `thinkingConfig` at all 5 call-type sites (Gemini's `streamStructured()` already throws unconditionally — untouched).
- **Perplexity, DeepSeek** — reject `reasoningEffort` outright with `bad_request`, at the top of every public method, before any message-building work — neither documents a comparable request parameter.

**Capability matrix:** new rows for `claude-opus-5` (`anthropic-effort`; context window 1M / max output 128K, verified live against Anthropic's Opus 5 docs) and `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` (`openai-effort`; context window ~1M / max output 128K, verified live against OpenAI's reasoning-guide + model docs). Every pre-existing row backfilled with `reasoningEffort` (mostly `null`; `anthropic-effort` on `claude-opus-4-7`/`claude-opus-4-6`/`claude-sonnet-4-6`; `openai-effort` on `gpt-5.4`/`gpt-5.4-mini`/`gpt-5.5`/`gpt-5.5-pro`/`o3`/`o4-mini`; `gemini-thinking-level` on `gemini-3.1-pro-preview`/`gemini-3.1-flash-lite`/`gemini-3.5-flash` — Gemini's 2.5-series uses `thinkingBudget`, not `thinkingLevel`, and stays `null`). `CAPABILITIES_VERSIONED_AT` bumped to `2026-07-29`.

No existing model key was deleted or renamed; no breaking type changes anywhere in this release. `providerOptions` (the pre-existing untyped escape hatch) is untouched — `reasoningEffort` is a first-class field, matching the precedent set by the v4.2.0 multimodal-content-blocks feature.
