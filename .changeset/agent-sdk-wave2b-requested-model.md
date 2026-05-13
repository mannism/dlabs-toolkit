---
"@diabolicallabs/agent-sdk": minor
---

feat(agent-sdk): propagate requestedModel to CallRecord for provider failover tracking

**v1.2.0 — failover observability:**

When `@diabolicallabs/llm-client` is configured with `model: string[]` and provider
failover fires, `LlmResponse.requestedModel` carries the originally-requested primary
model while `LlmResponse.model` holds the actually-serving fallback model.

`CallRecord.requestedModel?: string` is now populated from `response.requestedModel`
in `complete()`, `structured()`, and `withTools()` instrumentation paths. This lets the
Agent Spend Dashboard distinguish "requested gpt-5.5, served gpt-4.1" from
"requested gpt-4.1, served gpt-4.1."

`stream()` does not propagate `requestedModel` — streaming always uses the primary
model and mid-stream failover is not supported. The `model` field in the stream
`CallRecord` uses the primary (config-level first element) as before.
