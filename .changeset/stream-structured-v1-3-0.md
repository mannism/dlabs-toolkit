---
'@diabolicallabs/llm-client': minor
'@diabolicallabs/agent-sdk': minor
---

feat(llm-client): streamStructured() — token streaming + Zod-validated final output (v1.3.0)

Adds `streamStructured<T>(messages, schema, options?)` to `LlmClient`. Emits
`{ type: 'token', token }` events during generation and a single
`{ type: 'done', data: T, usage }` event at the end after JSON.parse() and
schema.parse() validation.

Provider support:
- **OpenAI (Responses API):** streams `output_text.delta` events. Zod 4 schemas
  enable `text.format.type = 'json_schema'` strict mode; plain `{ parse }` schemas
  use `json_object` mode.
- **Anthropic:** forced tool-use path (same as `structured()`), streams
  `input_json_delta` events from `messages.stream()`. Validated at end.
- **DeepSeek:** Chat Completions stream with `response_format: json_object`.
  Falls back to `parseJsonOrThrow` on `JSON.parse` failure to handle
  chain-of-thought preamble from `deepseek-reasoner`.
- **Gemini:** throws `LlmError(kind: 'bad_request')` immediately. Gemini does
  not reliably support simultaneous `responseSchema` constraints and streaming.
- **Perplexity:** throws `LlmError(kind: 'bad_request')` immediately. Search
  models do not return tool-validated JSON.

Error path: `LlmError(kind: 'structured_parse_failed')` thrown if
`JSON.parse()` or `schema.parse()` fails (no `done` event emitted).

AbortSignal, `streamStallTimeoutMs`, and `timeoutMs` propagate to the
underlying SDK stream unchanged.

No failover support (mid-stream model switching is unsafe). No cost annotation
(streaming does not produce a single accumulated response object).

feat(agent-sdk): wrap streamStructured() in InstrumentedLlmClient (v1.3.0)

`instrumentClient` wraps `streamStructured()` with a single `CallRecord`
dispatch per call (not per chunk). Usage is taken from the final `done` event.
No new fields on `CallRecord` — existing shape covers it.

Peer dep on `@diabolicallabs/llm-client` tightened to `^1.3.0`.
