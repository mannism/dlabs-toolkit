---
"@diabolicallabs/agent-sdk": minor
---

Add pluggable `AgentSdkLogger` with stdout JSON default.

**New exports:** `setAgentSdkLogger(logger | null)` and the `AgentSdkLogger` interface.

The single `ingestion_exhausted` diagnostic event previously emitted via `console.warn(JSON.stringify(...))` now routes through the pluggable logger. The default logger writes `console.log(JSON.stringify({ level: 'warn', event, ...payload }))` to stdout, so Railway-style log ingesters classify it by the embedded `level` field rather than by stream.

**Consumer impact:** Default behavior is functionally equivalent — the log line content is identical. If you were spying on `console.warn` for `ingestion_exhausted` in tests, inject a logger via `setAgentSdkLogger()` instead. No other changes required.

The `ingestion_exhausted` event name is stable and may be used as a consumer alert key. Payload fields are unchanged: `{ call_id, agent_id, model, message }`.

Mirrors the pattern already shipped in `@diabolicallabs/llm-pricing@1.1.0` and `@diabolicallabs/llm-client` — all three packages now share the same pluggable-logger shape.
