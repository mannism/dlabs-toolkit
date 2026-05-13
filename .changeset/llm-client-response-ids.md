---
"@diabolicallabs/llm-client": minor
---

feat(llm-client): response IDs on all response types — id + idSource everywhere (Wave 3a §3.4)

Adds `id: string` and `idSource: 'provider' | 'synthesized'` to all three response types:
`LlmResponse`, `LlmStructuredResponse<T>`, and `LlmToolResponse`.

Previously `id` was optional and absent from `LlmResponse` entirely. Now all response paths
across all five providers always carry a non-undefined `id`.

**Provider sources:**
- Anthropic: `response.id` (message ID — provider-issued). `idSource: 'provider'`.
- OpenAI: `rawResponse.id` (Responses API response ID — provider-issued). `idSource: 'provider'`.
- DeepSeek: `rawResponse.id` (Chat Completions response ID — provider-issued). `idSource: 'provider'`.
- Perplexity: `response.id` (Chat Completions response ID — provider-issued). `idSource: 'provider'`.
- Gemini: synthesized UUID v7-style (time-derived prefix + random — time-sortable for trace correlation).
  `idSource: 'synthesized'`. Gemini does not issue native response IDs on generateContent calls.

**UUID v4 vs v7 decision:** The toolkit uses a hand-rolled v7-style generator (time-derived prefix,
no new dep). Time-sortability is useful for trace correlation without a separate timestamp field.
`crypto.randomUUID()` (v4) would be fully random — no correlation by time. No `uuid` package needed.

**Migration:** `id` is now required on all three response types. TypeScript consumers that were
checking `if (result.id !== undefined)` may need to remove the null check. The `idSource` field
lets trace systems distinguish durable provider IDs from toolkit-generated correlation IDs.
