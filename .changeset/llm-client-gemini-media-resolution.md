---
'@diabolicallabs/llm-client': minor
---

feat(gemini): mediaResolution option (request + per-part), gemini-3.8-flash row, multimodal timeout guidance

Whole-document extraction callers (e.g. sending a native PDF to Gemini as a `document`
content block) had no way to control how many tokens each media part consumes.
`@google/genai` exposes both a request-level `GenerateContentConfig.mediaResolution`
and a per-part `Part.mediaResolution`, and neither was wired into the toolkit.

Adds `mediaResolution?: 'low' | 'medium' | 'high' | 'ultra_high'` at three levels:

- `LlmClientConfig.mediaResolution` — default for every media part in every call.
- `LlmCallOptions.mediaResolution` — per-call override; wins over the config default.
- `LlmContentBlock.mediaResolution` on `image`, `document`, and `file` blocks — per-part
  override; wins over both call- and config-level.

Gemini-only: every other provider (Anthropic, OpenAI, DeepSeek, Perplexity) ignores the
field entirely — it is a quality/cost knob those providers don't read, not a value-set
mismatch requiring rejection. `'ultra_high'` has no request-level `MediaResolution` enum
member on the Gemini SDK, so setting it on `LlmClientConfig`/`LlmCallOptions` throws
`bad_request` before any SDK call; per-block, `'ultra_high'` is valid on `image` blocks
but throws `bad_request` pre-flight on `document` blocks (Google documents it as
image-only, and the Gemini API itself returns HTTP 400 for it on documents).

Per-part support is Gemini 3.x only — Gemini 2.5-series models (`gemini-2.5-pro`,
`gemini-2.5-flash`, `gemini-2.5-flash-lite`) return HTTP 400 when a per-part
`mediaResolution` is set on a content block, though request-level still works on 2.5.
This is now exposed as a new **additive** capability field,
`ModelCapabilities.mediaInput.mediaResolution: 'request' | 'part' | null` — consumers
with a `satisfies ModelCapabilities` literal for a custom capability table will need to
add this field. It is advisory only; no provider call site gates on it at runtime.

Also adds `gemini-3.8-flash` to the capability matrix (GA 2026-09-02, same shape as
`gemini-3.7-flash`, `mediaInput.mediaResolution: 'part'`), and documents in
`LlmClientConfig.timeoutMs`'s JSDoc and the README that multimodal (`document`/`file`
block) and `reasoningEffort` calls commonly need `timeoutMs >= 90_000` — the 30 second
default is unchanged.

See the README's new "Media resolution (Gemini)" section for the live token-count table,
precedence rules, and Google's medium/high/low guidance.
