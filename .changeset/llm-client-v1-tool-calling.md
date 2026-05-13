---
"@diabolicallabs/llm-client": major
"@diabolicallabs/agent-sdk": major
---

v1.0.0: native tool calling, OpenAI Responses API, and expanded error taxonomy

**@diabolicallabs/llm-client** breaking changes:

- `LlmErrorKind` is now a closed union of 14 specific kinds (was narrow string union). `err.kind` is always defined (was `LlmErrorKind | undefined`). Consumers using `err.kind === 'http'` for retryable checks should migrate to `err.kind === 'rate_limit' || err.kind === 'server_error'`.
- OpenAI provider migrated from Chat Completions to Responses API (`responses.create`). The `LlmClient` interface is unchanged — migration is transparent for `complete()`, `stream()`, and `structured()` callers.
- `LlmClient` interface adds `withTools(messages, tools, options?)` — native tool calling across all five providers. Custom `LlmClient` implementations must add this method.

New features:

- `withTools()` — native tool calling on OpenAI (Responses API flat shape), Anthropic (`{ name, description, input_schema }`), Gemini (`parametersJsonSchema`), DeepSeek (Chat Completions nested shape). Perplexity throws `kind:'bad_request'` immediately.
- `LlmTool`, `LlmToolCall`, `LlmToolResponse`, `LlmCallWithToolsOptions` types exported from the package root.
- Gemini `structured()` fix: OBJECT schemas with empty `properties: {}` now auto-inject a `_placeholder` sentinel (stripped before Zod parse) to satisfy the Gemini API's rejection of empty-properties objects.

**@diabolicallabs/agent-sdk** breaking changes:

- `InstrumentedLlmClient` now requires `withTools()` on the underlying `LlmClient`. Consumers with custom `LlmClient` implementations must add `withTools()` before upgrading.
- `CallRecord` gains optional `tool_calls?: LlmToolCall[]` — populated when `withTools()` produces at least one tool call. The Spend Dashboard ingestion endpoint should accept this additive field.
