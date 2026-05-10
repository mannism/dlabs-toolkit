---
"@diabolicallabs/llm-client": patch
---

Fix per-call `timeoutMs` to extend the SDK socket deadline; classify `APIConnectionTimeoutError` as `kind: 'timeout'`.

**Fix A — per-call timeoutMs now propagates to the SDK socket.** Previously, `LlmCallOptions.timeoutMs` only fed the toolkit's `AbortController`. The SDK socket was fixed at `createClient()` time (`config.timeoutMs ?? 30_000`), so long calls (>30 s) hit the SDK socket first, threw, and retry-exhausted at ~121 s — the per-call budget of 300 s never had a chance to take effect. Now `timeout: effectiveTimeoutMs` is passed in the per-call RequestOptions second argument at every call site across all three providers (OpenAI: `complete`, `stream`, `structured` strict, `structuredPromptFallback`; Anthropic: `complete`, `stream`, `structured` strict — `structuredPromptFallback` delegates to `complete`; Perplexity: `complete`, `stream`, `structured`). The constructor-level `timeout` stays as the floor for callers who do not pass a per-call override. This unblocks GEOAudit PR #171: `gpt-5.5` and `claude-sonnet-4-6` were failing A1 at exactly the retry-exhaustion latency (validated 2026-05-11 against `proj-plan/dlabs-toolkit/research/owner-geoaudit-use-case-validation-2026-05-11.md`).

**Fix B — `APIConnectionTimeoutError` now maps to `kind: 'timeout'`.** Both OpenAI and Anthropic SDKs throw `APIConnectionTimeoutError` (a subclass of `APIConnectionError`) when the socket timeout fires. The existing normalizers checked `instanceof APIConnectionError` first — the timeout subclass matched but emitted no `kind` discriminator, leaving `kind: undefined`. An `instanceof APIConnectionTimeoutError` branch is now inserted *before* the `instanceof APIConnectionError` branch in `normalizeOpenAIError`, `normalizeAnthropicError`, and `normalizePerplexityError`. All three map to `{ kind: 'timeout', retryable: true }`. Callers who branch on `LlmError.kind` can now distinguish SDK socket timeouts from other connection errors.

`LlmCallOptions` shape is unchanged — this is a non-breaking patch.
