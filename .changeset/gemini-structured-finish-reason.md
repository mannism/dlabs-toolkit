---
"@diabolicallabs/llm-client": minor
---

Gemini `structured()` (and its prompt-mode fallback, `structuredPromptFallback()`) now inspects `candidates[0].finishReason` and `promptFeedback.blockReason` **before** attempting `JSON.parse` on an empty or whitespace-only response, instead of always throwing a generic `structured_parse_failed` with an empty `"Raw: "` message.

New classification when the response text is empty:

- `MAX_TOKENS` finish reason → `LlmError{ kind: 'max_tokens' }` (new kind)
- `SAFETY` finish reason or `promptFeedback.blockReason` present → `LlmError{ kind: 'content_filter' }`
- any other finish reason, including a genuine `STOP` (e.g. an all-thought-parts response, where `@google/genai`'s `.text` getter silently skips `thought: true` parts) → `LlmError{ kind: 'empty_response' }` (new kind)
- non-empty, unparseable text → `structured_parse_failed` (unchanged)

Each new error message names the finish reason / block reason and includes `thoughtsTokenCount` / `candidatesTokenCount` from `usageMetadata` when present.

`LlmStructuredResponse` gains an optional `stopReason?: 'end_turn' | 'max_tokens' | 'content_filter'` field, populated by Gemini on every successful `structured()` call, so callers can detect truncation even when `JSON.parse` still succeeds. Undefined for all other providers.

Both new `LlmErrorKind` members are additive — no existing kind changes meaning or retryability, so this is a minor release.
