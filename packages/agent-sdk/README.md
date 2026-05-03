# @diabolicallabs/agent-sdk

Cost-tracking middleware for `@diabolicallabs/llm-client`. Drop-in wrapper that captures call records and dispatches them asynchronously to the Agent Spend Dashboard. © Diabolical Labs

## Status

**Scaffolded.** Types and public API surface are defined. Full implementation ships Week 4.

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

// Identical API to LlmClient — instrumentation is invisible to the caller
const response = await client.complete([
  { role: 'user', content: 'Analyse this URL...' },
]);
// CallRecord dispatched asynchronously — response returned immediately
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

## Ingestion contract

Every LLM call produces a `CallRecord` dispatched to the ingestion URL:

```typescript
interface CallRecord {
  agent_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
  latency_ms: number;
  task_label?: string;
  project_id?: string;
  timestamp: string; // ISO 8601
  call_id: string;   // UUID idempotency key
}
```

## Failure behaviour

Ingestion failures are **always silent** — they never surface to the caller.

- Endpoint down: record queued in memory (max 100 items), retried on next call
- Retries exhausted: record dropped, structured warning logged (includes `call_id`)
- `disabled: true`: all instrumentation skipped, passthrough only
