# @diabolicallabs/agent-sdk

Cost-tracking middleware for `@diabolicallabs/llm-client`. Drop-in wrapper that captures call records and dispatches them asynchronously to the Agent Spend Dashboard. © Diabolical Labs

**Pre-1.0. APIs may change between minor versions.**

## Status

**Published — v1.2.0.** `instrumentClient()` wraps all five `LlmClient` methods: `complete()`, `stream()`, `structured()`, `streamStructured()`, `withTools()`. Cost propagation (v1.1.0) and failover `requestedModel` tracking (v1.2.0) are included. `streamStructured()` wrapper ships in v1.3.0.

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
| `identity.agentId` | `string` | required | UUID from Spend Dashboard agent registry |
| `identity.taskLabel` | `string?` | — | Optional label for this call (max 200 chars) |
| `identity.projectId` | `string?` | — | Optional project override |
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

## Failure behavior

Ingestion failures are **always silent** — they never surface to the LLM caller.

- Endpoint down or slow: retried up to `maxIngestionRetries` with exponential backoff
- Retries exhausted: record dropped, structured warning logged (includes `call_id` for audit)
- `disabled: true`: all instrumentation skipped, underlying client returned directly
