---
'@diabolicallabs/agent-sdk': minor
---

Implement `instrumentClient()` — cost-tracking middleware for `@diabolicallabs/llm-client`.

Intercepts `complete()`, `stream()`, and `structured()` calls to capture a `CallRecord` (agent_id, model, tokens, latency, timestamp, call_id UUID) and dispatch it asynchronously to a configurable ingestion endpoint. The LLM response is returned to the caller immediately — ingestion is non-blocking.

- **Retry:** exponential backoff, configurable `maxIngestionRetries` (default 3)
- **Exhaustion:** record dropped, structured warning logged (includes `call_id` for audit), never throws to LLM caller
- **Stream passthrough:** tokens yield immediately without buffering; usage captured from final chunk
- **Disabled mode:** `config.disabled: true` skips all instrumentation with zero overhead
- **No new runtime dependencies:** `crypto.randomUUID()` (Node 20 built-in) for idempotency key; native `fetch` with `AbortController` timeout
