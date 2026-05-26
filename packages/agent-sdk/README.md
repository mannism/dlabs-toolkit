# @diabolicallabs/agent-sdk

Cost-tracking middleware for `@diabolicallabs/llm-client`. Drop-in wrapper that captures call records and dispatches them asynchronously to the Agent Spend Dashboard. © Diabolical Labs

**Stable.** Requires `@diabolicallabs/llm-client@^4.0.0`. Public API committed: `instrumentClient`, `CallRecord`, `setAgentSdkLogger`.

## Status

**Published — v3.2.0.** `instrumentClient()` wraps all five `LlmClient` methods: `complete()`, `stream()`, `structured()`, `streamStructured()`, `withTools()`. Cost propagation (v1.1.0), failover `requestedModel` tracking (v1.2.0), and `streamStructured()` (v1.3.0) are included.

**v3.2.0 — UUID validation at startup:** `instrumentClient()` now validates `identity.agentId` (required UUID) and `identity.projectId` (optional — validated if present) at call time. Non-UUID values emit a `console.warn` with the offending field names and flip the returned client to no-op/disabled mode rather than silently dispatching records that the dashboard will reject. See [Common pitfalls](#common-pitfalls).

**v2.0.0 — architecture migration complete:** all 5 call types now route through a single `buildAfterCallDispatch()` function. The `stream()` and `streamStructured()` bespoke usage-capture wrappers retained in v1.4.0 are deleted. `LlmAfterCallContext.usage` is now populated by `llm-client@1.6.0` for streaming paths, so `agent-sdk` no longer needs its own generator iteration for usage capture. Public API is unchanged.

**v3.0.1 — peer-dep cleanup:** `@diabolicallabs/llm-pricing` is no longer declared as a peer dependency. The only usage was two `import type` statements compiled away at build time. The `LlmCost` type is now defined inline in agent-sdk — no consumer-side install change required. If your project uses `@diabolicallabs/llm-client` with pricing enabled, install `@diabolicallabs/llm-pricing` via the llm-client peer-dep path (or directly) — not as an agent-sdk requirement.

## Install

```bash
pnpm add @diabolicallabs/agent-sdk @diabolicallabs/llm-client
```

## Usage

```typescript
import { createClientFromEnv } from '@diabolicallabs/llm-client';
import { instrumentClient } from '@diabolicallabs/agent-sdk';

const base = createClientFromEnv('anthropic', 'claude-sonnet-4-6');

const client = instrumentClient(base, {
  identity: { agentId: process.env.AGENT_ID!, taskLabel: 'geo-audit' },
  ingestionUrl: process.env.SPEND_INGESTION_URL!,
  ingestionKey: process.env.SPEND_INGESTION_KEY!,
});

// complete() — non-streaming
const response = await client.complete([{ role: 'user', content: 'Hello' }]);
// CallRecord dispatched asynchronously — response returned immediately

// streamStructured() — token streaming + validated output (v1.3.0)
const { z } = await import('zod');
const schema = z.object({ name: z.string(), score: z.number() });
for await (const event of client.streamStructured(messages, schema)) {
  if (event.type === 'token') process.stdout.write(event.token);
  if (event.type === 'done') console.log(event.data, event.usage);
}
// One CallRecord dispatched after the done event — not per token
```

## API

### `instrumentClient(client, config): InstrumentedLlmClient`

Wraps any `LlmClient` with cost-tracking middleware. The returned `InstrumentedLlmClient` is a drop-in replacement — it implements the same interface.

**Config:**

| Field | Type | Default | Description |
|---|---|---|---|
| `identity.agentId` | `string` | required | **Must be a UUID** from the Spend Dashboard agent registry. Non-UUID values flip the client to disabled mode with a `console.warn` at call time. |
| `identity.taskLabel` | `string?` | — | Optional label for this call (max 200 chars) |
| `identity.projectId` | `string?` | — | Optional project override. **Must be a UUID** if supplied; non-UUID values flip the client to disabled mode with a `console.warn`. |
| `ingestionUrl` | `string` | required | Agent Spend Dashboard `/api/ingest` endpoint |
| `ingestionKey` | `string` | required | Agent-scoped bearer token |
| `maxIngestionRetries` | `number` | `3` | Retries before dropping the record |
| `ingestionTimeoutMs` | `number` | `5000` | Ingestion request timeout — never blocks the LLM call |
| `disabled` | `boolean` | `false` | Set `true` in test/dev to skip all instrumentation |

**Instrumented methods and CallRecord behavior:**

| Method | CallRecord timing | Cost propagated | Notes |
|---|---|---|---|
| `complete()` | After response | Yes | `requestedModel` included on failover |
| `stream()` | After final chunk | No | Usage from the chunk that carries `usage` |
| `structured()` | After response | Yes | `requestedModel` included on failover |
| `streamStructured()` | After `done` event | No | One record per call, usage from the `done` event |
| `withTools()` | After response | Yes | `tool_calls` array included for per-tool attribution |

## Ingestion contract

Every LLM call produces a `CallRecord` dispatched to the ingestion URL:

```typescript
interface CallRecord {
  agent_id: string;
  model: string;
  requestedModel?: string; // Present when provider failover fired (v1.2.0+)
  prompt_tokens: number;
  completion_tokens: number;
  cache_creation_tokens?: number; // Anthropic prompt cache only
  cache_read_tokens?: number;     // Anthropic prompt cache only
  latency_ms: number;
  task_label?: string;
  project_id?: string;
  timestamp: string;   // ISO 8601 UTC
  call_id: string;     // UUID v4 — idempotency key
  tool_calls?: LlmToolCall[]; // withTools() only, omitted when array is empty
  cost?: LlmCost;     // Present when LlmClient has pricing configured (v1.1.0+)
}
```

## When to use `instrumentClient` vs raw `createClient({ hooks })`

`@diabolicallabs/llm-client` v1.5.0+ ships a native hooks API (`beforeCall`/`afterCall`) on `createClient()`. Use it directly when you want request-level interception: PII redaction, cache short-circuit, custom logging.

Use `instrumentClient()` when you want structured `CallRecord` ingestion to the Agent Spend Dashboard. It owns the `CallRecord` schema and the ingestion retry/backoff contract. In v2.0.0, all 5 call types dispatch through a single uniform `afterCall` handler — the public entry point is always `instrumentClient(client, config)`.

**Composition:** if you set `hooks` on a `LlmClient` config and then pass that client to `instrumentClient()`, both hooks run. The consumer's `afterCall` fires first; the ingestion dispatch fires second.

```typescript
const base = createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  hooks: {
    beforeCall: async (ctx) => ({
      messages: redactPii(ctx.messages),
    }),
  },
});

// Both the PII hook and ingestion dispatch run on every call
const client = instrumentClient(base, {
  identity: { agentId: process.env.AGENT_ID! },
  ingestionUrl: process.env.SPEND_INGESTION_URL!,
  ingestionKey: process.env.SPEND_INGESTION_KEY!,
});
```

## Failure behavior

Ingestion failures are **always silent** — they never surface to the LLM caller.

- Endpoint down or slow: retried up to `maxIngestionRetries` with exponential backoff
- Retries exhausted: record dropped, structured warning logged (includes `call_id` for audit)
- `disabled: true`: all instrumentation skipped, underlying client returned directly

## Common pitfalls

### Non-UUID `agentId` or `projectId` — zero records appear in the dashboard

Before v3.2.0, if you passed a non-UUID `agentId` (for example a slug like `"fitcheck-llm"`) or a non-UUID `projectId`, the SDK silently dispatched records to the dashboard, which rejected them with HTTP 400 `VALIDATION_ERROR`. The SDK retried 4 times and dropped the record — the only signal was a JSON-formatted `warn` on stdout that was easy to miss in Railway logs.

From v3.2.0, `instrumentClient()` validates both fields at call time. If either is not a valid UUID, the SDK emits a `console.warn` naming the malformed field(s) and flips the returned client to no-op mode immediately — no records are dispatched. Register your agent in the Spend Dashboard to obtain the correct UUIDs, then set them via environment variables (for example `AGENT_SPEND_AGENT_ID` and `AGENT_SPEND_PROJECT_ID`).
