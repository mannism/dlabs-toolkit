# @diabolicallabs/llm-client

Unified LLM API across Anthropic, OpenAI, Google Gemini, DeepSeek, and Perplexity. Single interface for completion, streaming, structured output, and native tool calling. All provider errors are normalized into a consistent `LlmError` shape. © Diabolical Labs

## Status

**v5.1.0.** All five providers fully implemented. See [MIGRATION.md](./MIGRATION.md) for breaking changes from v0.x.

Highlights:
- **v5.1.0** — Files API: `LlmFilesApi` namespace on every `LlmClient` (`files.upload()`, `files.refresh()`, `files.waitForActive()`, `files.delete()`). New `{ type: 'file', ref: LlmFileRef }` content block for passing uploaded files in messages. Gemini supports video, large images, and PDFs via the Files API; OpenAI supports PDFs; Anthropic supports PDFs and images via the Files beta. Error kinds map to the existing taxonomy (`bad_request` for provider/state mismatches, `network`/`server_error` for SDK failures, `timeout` for waitForActive deadline exceeded). Cross-provider refs throw `bad_request` before any SDK call.
- **v5.0.0** — **Breaking.** `LlmTool.inputSchema` now requires an `LlmToolSchema` discriminated union (`{ kind: 'zod', schema }` or `{ kind: 'jsonSchema', schema, validate? }`). The legacy `{ parse: fn }` shape throws `LlmError({ kind: 'tool_schema_invalid' })` at runtime. `LlmToolSchema` is exported from the package root. New `tool_schema_invalid` error kind added. See [Tool calling](#tool-calling-v100) for migration examples.
- **v1.7.0** — `createClient()` is now `async`. `pricing.remoteUrl` config option fetches a remote `PricingTable` on init (stale-while-revalidate cache, 24h default TTL). `pricing.cacheTtlMs` controls the TTL. Structured `pricing_source` log on every `createClient()` with pricing config. Requires `@diabolicallabs/llm-pricing@^0.2.0`.
- **v1.6.0** — `LlmAfterCallContext` now carries `usage?: LlmUsage` for all 5 call types. Non-streaming paths mirror `response.usage`; `stream()` captures from the terminal chunk; `streamStructured()` from the `done` event. The v1.5.0 caveat ("usage not surfaced for streaming in afterCall") is removed. `agent-sdk` v2.0.0 uses this to complete its architecture migration.
- **v1.5.0** — Pre-call hooks API (`hooks?: LlmHooks` on `createClient`). `beforeCall` for request mutation and short-circuit caching; `afterCall` for custom logging and observability. Fires on all 5 call types. Cross-reference: [`@diabolicallabs/agent-sdk`](../agent-sdk/README.md) uses hooks internally.
- **v1.4.0** — Provider capability matrix (`getModelCapabilities()`), linked AbortController helper (`linkedAbortController()`), response IDs on all response types (`id` + `idSource`).
- **v1.3.0** — Streaming structured output (`streamStructured()`) — token streaming + Zod-validated final object. OpenAI, Anthropic, DeepSeek supported; Gemini and Perplexity throw pre-call.
- **v1.2.0** — Configurable retry strategy (exponential/linear/fixed/decorrelated), provider failover via `model: string[]`, `Retry-After` header support.
- **v1.1.0** — Per-response cost computation via `@diabolicallabs/llm-pricing`; concurrency pool at `@diabolicallabs/llm-client/pool`.
- **v1.0.0** — Native tool calling (`withTools()`), expanded `LlmErrorKind` taxonomy, OpenAI Responses API migration.

## Install

```bash
pnpm add @diabolicallabs/llm-client
```

Public on npmjs.com — no `.npmrc` config required.

## Usage

```typescript
import { createClient, createClientFromEnv } from '@diabolicallabs/llm-client';

// From explicit config — createClient() is async (v1.7.0+)
const client = await createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// From environment variables — also async
const client = await createClientFromEnv('anthropic', 'claude-sonnet-4-6');

// Non-streaming completion
const response = await client.complete([
  { role: 'user', content: 'Hello' },
]);
console.log(response.content, response.usage);

// Streaming
for await (const chunk of client.stream([{ role: 'user', content: 'Hello' }])) {
  process.stdout.write(chunk.token);
}

// Structured output — Zod 4 schema triggers strict native mode automatically
import { z } from 'zod';
const schema = z.object({ name: z.string(), score: z.number() });
const result = await client.structured(messages, schema);
// result.data is typed as { name: string; score: number }
// result.model and result.id are populated (v0.4.0+)
```

## Strict structured outputs (v0.4.0)

Pass a **Zod 4** schema to `structured()` and the toolkit automatically routes to the strictest native path available for each provider. No opt-in flag required.

```typescript
import { z } from 'zod';
const schema = z.object({
  topic: z.string(),
  bullets: z.array(z.string()),
});

const result = await client.structured(messages, schema);
// result.data    — typed and Zod-validated
// result.model   — model ID used (always present, v0.4.0+)
// result.id      — provider request ID for tracing (OpenAI + Anthropic)
// result.citations — Perplexity citations if any
```

### How detection works

The toolkit checks for Zod 4's internal `_zod` marker at runtime. If the schema is a Zod 4 instance, it converts to JSON Schema using Zod 4's built-in `z.toJSONSchema()` and routes to the native path. If the schema is anything else (plain `{ parse }` object, Zod 3, etc.), it falls back to the v0.3.0 system-prompt path.

### Schema-feature support matrix

| Provider | Native mode | What's enforced | Known limits |
|---|---|---|---|
| OpenAI (`gpt-4o`, `gpt-4o-mini`) | `text.format: { type: 'json_schema', strict: true }` (Responses API, v1.0.0) | Schema structure guaranteed; model cannot produce off-schema output | No `format`, `pattern`, or recursive schemas (`z.lazy()`). Throws at conversion time with clear message. |
| Anthropic | Tool-use with forced `tool_choice: { type: 'tool', name: 'extract' }` | Model must call the tool; `input` is pre-parsed JSON | Defense-in-depth `schema.parse()` still runs |
| Gemini | `responseSchema` (OpenAPI 3.0) + `responseMimeType: 'application/json'` | Schema communicated to the model; belt-and-braces fence-strip retained | OBJECT schemas with empty `properties: {}` auto-receive a `_placeholder` sentinel (v1.0.0); stripped before Zod parse. |
| DeepSeek | None (prompt-only, API limitation) | System-prompt nudge + schema.parse() | Same as v0.3.0 |
| Perplexity | None (prompt-only, API limitation) | System-prompt nudge + `<think>` strip + schema.parse() | Same as v0.3.0; `citations` propagated to structured response |

### Prompt-mode escape hatch

If your schema uses a feature unsupported in strict mode (e.g. `z.function()`, `z.lazy()`) and you need to keep using it, pass the escape hatch:

```typescript
const result = await client.structured(messages, schema, {
  providerOptions: { structuredMode: 'prompt' },
});
// Forces the v0.3.0 prompt-only path regardless of schema type
```

Alternatively, catch the `LlmError` thrown during schema conversion and inform the user:

```typescript
try {
  const result = await client.structured(messages, schema);
} catch (err) {
  if (err instanceof LlmError && err.kind === 'unknown') {
    // Schema contains an unrepresentable feature — message names it
    console.error(err.message);
  }
}
```

### Zod 3 schemas

If a Zod 3 schema is passed, the toolkit throws `LlmError` with a clear "upgrade to Zod 4" message rather than silently falling through to prompt mode. Pass `providerOptions.structuredMode = 'prompt'` if you cannot upgrade immediately.

## Anthropic prompt caching (v0.4.3)

Anthropic charges full input tokens on every call by default. Enable prompt caching to have Anthropic cache the system message block between calls, paying a 1.25× surcharge on the first (write) call and a 0.10× discount on every subsequent (read) call within the 5-minute TTL window.

```typescript
const result = await client.complete(messages, {
  providerOptions: { promptCache: 'ephemeral' },
});

// result.usage.cacheCreationTokens — tokens written to cache (first call)
// result.usage.cacheReadTokens     — tokens read from cache (subsequent calls)
```

Works identically on `complete()`, `stream()`, and `structured()` (both strict tool-use and prompt-fallback paths):

```typescript
// complete()
const r = await client.complete(messages, { providerOptions: { promptCache: 'ephemeral' } });

// stream()
for await (const chunk of client.stream(messages, { providerOptions: { promptCache: 'ephemeral' } })) {
  process.stdout.write(chunk.token);
}

// structured() — Zod 4 schema (strict tool-use path)
// Also caches the tool definition as a second cache layer.
const r = await client.structured(messages, zodSchema, {
  providerOptions: { promptCache: 'ephemeral' },
});

// structured() — prompt-fallback path (non-Zod schema or structuredMode: 'prompt')
const r = await client.structured(messages, narrowSchema, {
  providerOptions: { structuredMode: 'prompt', promptCache: 'ephemeral' },
});
```

### Cache semantics

| Field | Description |
|---|---|
| **TTL** | 5 minutes (default). Anthropic also offers a 1-hour beta TTL — not yet exposed in the toolkit. |
| **Minimum block size** | 1024 tokens for Claude Sonnet and Opus models; 2048 tokens for Haiku. Below minimum, the API silently ignores the marker — callers pay no write surcharge. |
| **Write cost** | 1.25× normal input token price. |
| **Read cost** | 0.10× normal input token price. |
| **Break-even** | ~3 cache reads within the TTL window. |

The toolkit always sends the `cache_control` marker and lets Anthropic's API enforce minimum block size. No client-side token estimation is performed — simpler, and the API's behavior is authoritative.

### Usage fields

Cache token counts surface in `LlmUsage`:

```typescript
interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationTokens?: number; // tokens written to cache (Anthropic only)
  cacheReadTokens?: number;     // tokens read from cache (Anthropic only)
}
```

On a cold call (cache miss): `cacheCreationTokens > 0`, `cacheReadTokens === 0`.
On a warm call (cache hit within TTL): `cacheReadTokens > 0`, `cacheCreationTokens === 0`.

### Provider isolation

`providerOptions.promptCache` is Anthropic-only. Passing it to an OpenAI, Gemini, DeepSeek, or Perplexity client has no effect — those providers ignore unrecognized `providerOptions` fields.

OpenAI has implicit automatic prompt caching on some models (no opt-in needed). Perplexity and Gemini caching models are different — if needed, those warrant separate briefs.

## Provider universe

| Provider | Status | Env var |
|---|---|---|
| `anthropic` | Implemented | `ANTHROPIC_API_KEY` |
| `openai` | Implemented | `OPENAI_API_KEY` |
| `gemini` | Implemented | `GOOGLE_AI_API_KEY` |
| `deepseek` | Implemented | `DEEPSEEK_API_KEY` |
| `perplexity` | Implemented | `PERPLEXITY_API_KEY` |

## Perplexity — web-grounded responses

The Perplexity provider returns real-time web-grounded answers with source citations. Use it via `createClient` or `createClientFromEnv`:

```typescript
const client = createClientFromEnv('perplexity', 'sonar');
const response = await client.complete([
  { role: 'user', content: 'What happened in AI this week?' },
]);

// Citations are deduplicated by URL
console.log(response.citations);
// [{ url: 'https://example.com/article' }, { url: 'https://reuters.com/story' }]
```

### Citations

`LlmResponse.citations` is populated when Perplexity returns source URLs. It is `undefined` for all other providers.

```typescript
interface LlmResponse {
  content: string;
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  citations?: Array<{
    url: string;
    title?: string;  // Perplexity currently returns URLs only; title is always undefined
  }>;
}
```

Citations are deduplicated by URL within a single response. They are **not available in stream mode** — use `complete()` when you need citations.

### Search filters via `providerOptions`

Perplexity supports search-specific parameters. Pass them via the `providerOptions` escape hatch on any call:

```typescript
await client.complete(messages, {
  providerOptions: {
    search_recency_filter: 'week',   // 'month' | 'week' | 'day' | 'hour'
    search_domain_filter: ['nytimes.com', 'reuters.com'],  // allowlist
  },
});
```

`providerOptions` is `Record<string, unknown>` — unknown fields are forwarded to the Perplexity API unchanged, so newly-released filters work without a toolkit update. Other providers ignore `providerOptions`.

### Reasoning models

Pass reasoning model IDs as the `model` string:

```typescript
const client = createClientFromEnv('perplexity', 'sonar-reasoning-pro');
```

Available models (verified 2026-05-08):

| Model | Notes |
|---|---|
| `sonar` | Lightweight search model. Default. |
| `sonar-pro` | Advanced search, more citations. |
| `sonar-reasoning-pro` | Chain-of-thought reasoning. Replaces deprecated `sonar-reasoning`. |
| `sonar-deep-research` | Exhaustive research. Perplexity docs indicate async job support — treat as experimental with this toolkit. |

`structured()` with `sonar-reasoning-pro` works correctly — reasoning tokens (`<think>...</think>`) are stripped before JSON parsing.

`sonar-deep-research` is accepted as a model string. If Perplexity's API returns an incompatible async response shape, the call will throw a clear `LlmError`. In that case, use `sonar-reasoning-pro` instead, or wait for a future deep-research-specific brief.

## API

### `createClient(config: LlmClientConfig): LlmClient`

Creates an `LlmClient` for the given provider.

### `createClientFromEnv(provider, model, overrides?): LlmClient`

Reads the API key from the environment automatically:
- `anthropic` → `ANTHROPIC_API_KEY`
- `openai` → `OPENAI_API_KEY`
- `gemini` → `GOOGLE_AI_API_KEY`
- `deepseek` → `DEEPSEEK_API_KEY`
- `perplexity` → `PERPLEXITY_API_KEY`

### `LlmClient` interface

| Method | Description |
|---|---|
| `complete(messages, options?)` | Non-streaming completion. Returns `LlmResponse` (includes `citations` for Perplexity). |
| `stream(messages, options?)` | Streaming — async generator of `LlmStreamChunk`. Final chunk includes `usage`. Citations unavailable. |
| `structured(messages, schema, options?)` | Structured output validated against a Zod schema. Returns `LlmStructuredResponse<T>`. |
| `streamStructured(messages, schema, options?)` | Token streaming + Zod-validated final object. Returns `AsyncGenerator<LlmStreamStructuredEvent<T>>`. See [Streaming structured output (v1.3.0)](#streaming-structured-output-v130). |
| `withTools(messages, tools, options?)` | Native tool calling. Returns `LlmToolResponse`. See [Tool calling](#tool-calling-v100). |

All methods accept `LlmCallOptions` as the options parameter:

```typescript
interface LlmCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;              // Per-call timeout (ms). Overrides config.timeoutMs.
  signal?: AbortSignal;            // Caller-supplied cancel signal. Never retried.
  streamStallTimeoutMs?: number;   // Per-chunk silence timeout for stream(). Default 30000.
  providerOptions?: Record<string, unknown>;  // Perplexity search filters, etc.
}
```

## Tool calling (v1.0.0)

`withTools()` enables native function calling across all supported providers. The toolkit handles provider-specific tool shapes, stop-reason mapping, and argument validation internally.

### `LlmToolSchema` — tool input schema (v5.0.0, breaking)

Every `LlmTool.inputSchema` must be an `LlmToolSchema` discriminated union. There are two variants:

**Zod variant** (`kind: 'zod'`) — recommended for type-safe tools. Pass a Zod 4 schema. The toolkit converts it to JSON Schema for the wire call and calls `schema.parse()` to validate the model's returned arguments automatically.

```typescript
import { z } from 'zod';
import { type LlmTool, createClientFromEnv } from '@diabolicallabs/llm-client';

const weatherTool: LlmTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    kind: 'zod',
    schema: z.object({ city: z.string() }),
  },
};
```

**JSON Schema variant** (`kind: 'jsonSchema'`) — use when you already have a JSON Schema or want to avoid a Zod dependency. The `schema` object is sent verbatim to the provider. The optional `validate` function is called for argument validation; when omitted, the raw model output is returned without validation.

```typescript
import { type LlmTool, createClientFromEnv } from '@diabolicallabs/llm-client';

const weatherTool: LlmTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    kind: 'jsonSchema',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
    // validate is optional — omit if you don't need runtime argument checking
    validate: (d) => {
      if (typeof (d as { city?: unknown }).city !== 'string') {
        throw new Error('city must be a string');
      }
      return d as { city: string };
    },
  },
};
```

> **v5 migration:** The v4.x `inputSchema: { parse: fn }` shape (including a bare Zod schema passed directly as `inputSchema`) no longer works. It throws `LlmError({ kind: 'tool_schema_invalid' })` at runtime. Replace it with one of the two variants above.

### Basic usage

```typescript
import { z } from 'zod';
import { type LlmTool, createClientFromEnv } from '@diabolicallabs/llm-client';

const client = await createClientFromEnv('anthropic', 'claude-sonnet-4-6');

const weatherTool: LlmTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: {
    kind: 'zod',
    schema: z.object({ city: z.string() }),
  },
};

const result = await client.withTools(
  [{ role: 'user', content: 'What is the weather in London?' }],
  [weatherTool]
);

// result.stopReason — 'tool_use' | 'end_turn' | 'max_tokens' | 'content_filter' | ...
// result.toolCalls — array of LlmToolCall (may be empty if model responded with text)
// result.content   — any text the model produced alongside tool calls
// result.model     — model ID used
// result.usage     — normalized token usage

if (result.stopReason === 'tool_use') {
  for (const call of result.toolCalls) {
    console.log(call.toolName, call.arguments); // arguments validated by inputSchema
    console.log(call.id);           // use as tool_call_id in the follow-up message
    console.log(call.rawArguments); // original JSON string from the model
  }
}
```

### Tool options

```typescript
interface LlmCallWithToolsOptions extends LlmCallOptions {
  toolChoice?: 'auto' | 'any' | 'none' | { name: string };
  parallelToolCalls?: boolean; // default: true (parallel-enabled)
}
```

`toolChoice`:
- `'auto'` (default) — model decides whether and which tools to call.
- `'any'` — model must call at least one tool. Maps to `'required'` on OpenAI Responses API; `{ type: 'any' }` on Anthropic.
- `'none'` — model must not call any tool.
- `{ name: 'tool_name' }` — model must call the named tool.

`parallelToolCalls: false` — disable parallel tool invocations. Maps to `parallel_tool_calls: false` on OpenAI and DeepSeek; `disable_parallel_tool_use: true` on Anthropic `tool_choice`; ignored on Gemini (no equivalent).

### Provider tool support matrix

| Provider | Tool calling | `parallelToolCalls` | Named `toolChoice` | Stop reasons |
|---|---|---|---|---|
| OpenAI | Native (Responses API flat shape) | Supported | Supported | `tool_use`, `end_turn`, `max_tokens`, `refusal` |
| Anthropic | Native (`{ name, description, input_schema }`) | Supported (inverse: `disable_parallel_tool_use`) | Supported | `tool_use`, `end_turn`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal` |
| Gemini | Native (`parametersJsonSchema`) | Not applicable (no Gemini equivalent) | Falls back to AUTO | `tool_use`, `end_turn`, `max_tokens`, `content_filter`, `stop_sequence` |
| DeepSeek | Native (Chat Completions nested shape) | Supported | Supported | `tool_use`, `end_turn`, `max_tokens`, `content_filter` |
| Perplexity | Not supported | N/A | N/A | Throws `kind:'bad_request'` immediately |

### Argument validation

After the model returns its arguments, the toolkit validates them against the tool's `inputSchema`:

- **`kind: 'zod'`** — calls `schema.parse(args)`. Throws `LlmError({ kind: 'tool_arguments_invalid' })` if validation fails.
- **`kind: 'jsonSchema'`** — calls `validate(args)` when provided. If `validate` throws or returns a rejected promise, `withTools()` throws `LlmError({ kind: 'tool_arguments_invalid' })`. When `validate` is omitted, the raw output is returned without checking.

Passing an `inputSchema` that has no `kind` field (e.g. the legacy `{ parse: fn }` shape from v4.x) throws `LlmError({ kind: 'tool_schema_invalid' })`, `retryable: false` — before any provider call is made.

### Gemini ID synthesis

Gemini does not issue native response IDs or tool call IDs. The toolkit synthesizes UUID v7-style IDs (time-based + random) for `LlmToolCall.id` and for the response-level `id` field on all Gemini responses (`complete()`, `structured()`, `withTools()`). These IDs are time-sortable (the first 12 hex characters encode the millisecond timestamp) but not cryptographically random. Use `idSource` to distinguish synthesized IDs from provider-issued ones.

## Streaming structured output (v1.3.0)

`streamStructured()` combines the typing-progress UX of `stream()` with the Zod-validated final object of `structured()`. It emits incremental token events as the model generates output, then validates the accumulated text against the schema before emitting a final `done` event.

```typescript
import { z } from 'zod';
import { createClientFromEnv } from '@diabolicallabs/llm-client';

const client = createClientFromEnv('openai', 'gpt-4o');
const schema = z.object({ summary: z.string(), sentiment: z.enum(['positive', 'negative', 'neutral']) });

for await (const event of client.streamStructured(
  [{ role: 'user', content: 'Analyze this review: "Great product, fast shipping!"' }],
  schema
)) {
  if (event.type === 'token') {
    process.stdout.write(event.token); // show typing progress
  } else if (event.type === 'done') {
    console.log('\nValidated output:', event.data);
    console.log('Usage:', event.usage);
  }
}
```

### Event shape

```typescript
type LlmStreamStructuredEvent<T> =
  | { type: 'token'; token: string }  // incremental text chunk
  | { type: 'done'; data: T; usage: LlmUsage };  // final, validated result
```

`token` events arrive during generation. Exactly one `done` event arrives at the end. If `JSON.parse()` or `schema.parse()` fails, `LlmError` with `kind: 'structured_parse_failed'` is thrown instead (no `done` event).

### Provider support matrix for `streamStructured()`

| Provider | Support | Notes |
|---|---|---|
| OpenAI | Supported | Streams `output_text.delta` events via Responses API. Zod 4 schemas enable `json_schema` strict mode; non-Zod schemas use `json_object` mode. |
| Anthropic | Supported | Uses forced tool-use (`extract` tool, `tool_choice: tool`). Streams `input_json_delta` events — raw JSON fragments that assemble into the final object. |
| DeepSeek | Supported | Streams Chat Completions deltas with `response_format: { type: 'json_object' }`. Falls back to `parseJsonOrThrow` if `JSON.parse` fails (handles chain-of-thought preamble from `deepseek-reasoner`). |
| Gemini | Not supported | Throws `LlmError(kind: 'bad_request')` immediately. Gemini does not reliably support simultaneous `responseSchema` constraints and streaming. Use `stream()` for tokens or `structured()` for validation. |
| Perplexity | Not supported | Throws `LlmError(kind: 'bad_request')` immediately. Search/retrieval models do not return tool-validated JSON. |

### Failover and pricing

`streamStructured()` **does not support provider failover** — mid-stream model switching would corrupt the token sequence. It always uses the primary model from a `model: string[]` config.

`streamStructured()` **does not attach cost** — cost computation requires final token counts from a complete response object. Use `complete()` or `structured()` if you need cost tracking via `config.pricing`.

AbortSignal, stall detection (`streamStallTimeoutMs`), and timeout (`timeoutMs`) all work identically to `stream()`.

## Provider capability matrix (v1.4.0)

Query provider capabilities statically — no client instance needed.

```typescript
import { getModelCapabilities } from '@diabolicallabs/llm-client';

const caps = getModelCapabilities('anthropic', 'claude-opus-4-7');
if (caps === null) {
  throw new Error('Unknown model');
}

console.log(caps.contextWindow);    // 1_000_000
console.log(caps.tools);            // true
console.log(caps.parallelTools);    // true
console.log(caps.promptCache);      // 'ephemeral'
console.log(caps.structuredOutput); // 'tool-use'
console.log(caps.responseIds);      // 'provider'
console.log(caps.streamStructured); // true
```

Returns `null` for unknown models — never throws.

### `ModelCapabilities` shape

```typescript
interface ModelCapabilities {
  contextWindow: number;          // max input tokens
  maxOutputTokens: number;        // max single-response tokens
  streaming: boolean;             // stream() supported
  tools: boolean;                 // withTools() supported
  parallelTools: boolean;         // model can invoke multiple tools per turn
  promptCache: 'ephemeral' | '1h' | null; // Anthropic only; null for all others
  structuredOutput: 'tool-use' | 'json-schema' | 'response-schema' | null;
  responseIds: 'provider' | 'synthesized'; // Gemini = 'synthesized'
  streamStructured: boolean;      // streamStructured() supported
}
```

### Provider capability summary

| Provider | tools | parallelTools | promptCache | structuredOutput | responseIds | streamStructured |
|---|---|---|---|---|---|---|
| Anthropic | true | true | `'ephemeral'` | `'tool-use'` | `'provider'` | true |
| OpenAI | true | true | null | `'json-schema'` | `'provider'` | true |
| Gemini | true | false | null | `'response-schema'` | `'synthesized'` | false |
| DeepSeek | true | true | null | `'json-schema'` | `'provider'` | true |
| Perplexity | false | false | null | null | `'provider'` | false |

`getModelCapabilities` covers all models in `@diabolicallabs/llm-pricing`'s `DEFAULT_PRICING_TABLE`. The table is versioned at `CAPABILITIES_VERSIONED_AT: '2026-05-13'` — import it to detect staleness.

## Linked AbortController helper (v1.4.0)

`linkedAbortController` is a utility for fan-out patterns where a root signal cancels all in-flight calls and individual calls have their own per-call timeouts.

```typescript
import { linkedAbortController } from '@diabolicallabs/llm-client';

const root = new AbortController();

const calls = tasks.map(t => {
  const child = linkedAbortController(root.signal, { timeoutMs: 30_000 });
  return client
    .complete(t.messages, { signal: child.signal })
    .finally(() => child.dispose()); // clean up on completion — prevents listener leak
});

// Cancel all in-flight calls at once
root.abort('shutdown');

// Or wait for all results (some may have individual timeouts)
const results = await Promise.allSettled(calls);
```

### Behaviour

| Scenario | Result |
|---|---|
| Parent aborts | Child aborts immediately, forwarding the parent's abort reason |
| Parent already aborted at call time | Child aborts synchronously, no API call made |
| `timeoutMs` fires | Child aborts with timeout reason string; independent of the parent signal |
| `dispose()` called | Parent listener + timer cleared; child NOT aborted |
| `abort()` called on handle | Child aborts immediately; `dispose()` called implicitly |

Always call `dispose()` in a `finally` block — it removes the parent listener and clears the timer, preventing leaks if the parent fires after the call completes.

### API

```typescript
function linkedAbortController(
  parentSignal: AbortSignal,
  options?: { timeoutMs?: number }
): {
  signal: AbortSignal;     // pass to client.complete(), stream(), etc.
  abort: (reason?) => void; // abort child immediately
  dispose: () => void;      // clean up without aborting
};
```

## Response IDs everywhere (v1.4.0)

All three response types (`LlmResponse`, `LlmStructuredResponse<T>`, `LlmToolResponse`) now carry `id: string` and `idSource: 'provider' | 'synthesized'` on every call.

```typescript
const response = await client.complete(messages);
console.log(response.id);       // 'msg_abc123' (Anthropic) or synthesized UUID (Gemini)
console.log(response.idSource); // 'provider' | 'synthesized'
```

### ID sources by provider

| Provider | id source | idSource |
|---|---|---|
| Anthropic | `response.id` (Anthropic message ID) | `'provider'` |
| OpenAI | `response.id` (Responses API) | `'provider'` |
| DeepSeek | `response.id` (Chat Completions) | `'provider'` |
| Perplexity | `response.id` (Chat Completions) | `'provider'` |
| Gemini | UUID v7-style synthesized by toolkit | `'synthesized'` |

Synthesized IDs are time-sortable (first 12 hex chars encode the millisecond timestamp) — useful for trace correlation without a separate timestamp. Check `idSource === 'synthesized'` before treating the ID as a durable provider reference.

**Migration from v1.3.x:** `id` was previously `id?` (optional) on `LlmStructuredResponse` and `LlmToolResponse`, and absent from `LlmResponse`. It is now `id: string` (always present) on all three types. Remove any `response.id !== undefined` null checks.

## Cancellation, timeouts, stall detection

### Per-call timeout override

The default timeout is set at client construction via `config.timeoutMs` (default 30 000 ms). Override it per-call:

```typescript
const client = createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  timeoutMs: 30_000, // client default
});

// This call gets 90 seconds — useful for sonar-deep-research or long reasoning
const response = await client.complete(messages, { timeoutMs: 90_000 });
```

On timeout, `LlmError.kind === 'timeout'` and `retryable === true`. Each retry attempt gets a fresh deadline — the timeout resets per attempt, not across the full retry sequence.

### Caller AbortSignal

Pass any `AbortSignal` to cancel an in-flight call immediately:

```typescript
const ac = new AbortController();

// Cancel on user navigation, request supersede, shutdown, etc.
const responsePromise = client.complete(messages, { signal: ac.signal });

// Cancel before the call returns
ac.abort('user navigated away');

try {
  await responsePromise;
} catch (err) {
  if (err instanceof LlmError && err.kind === 'cancelled') {
    // Gracefully handle the cancellation
  }
}
```

- A signal already aborted at call time throws immediately — no SDK call is made, no retry.
- A mid-call abort propagates to the SDK (Anthropic, OpenAI, DeepSeek, Perplexity) or wins a `Promise.race` (Gemini). `kind === 'cancelled'`, `retryable === false`. Never retried.

### Stream stall detection

A stream that emits a first chunk and then silently hangs will stall the consumer indefinitely without this feature. `streamStallTimeoutMs` fires a timer per chunk — if no chunk arrives within the window, the stream is aborted and a `kind: 'stream_stall'` error surfaces:

```typescript
try {
  for await (const chunk of client.stream(messages, { streamStallTimeoutMs: 10_000 })) {
    process.stdout.write(chunk.token);
  }
} catch (err) {
  if (err instanceof LlmError && err.kind === 'stream_stall') {
    console.error('stream stalled — retry or fallback');
  }
}
```

- Default `streamStallTimeoutMs`: 30 000 ms (set independently of `timeoutMs` — tolerant of reasoning-model think-pauses).
- The stall timer resets after each chunk arrives, so slow-but-not-stalled streams complete normally.
- Stall errors are **not retried** — partial output is unsafe to re-issue. The error surfaces to the caller.

### `LlmError.kind` discriminator (v1.0.0)

```typescript
// Full taxonomy — all providers emit one of these kinds
type LlmErrorKind =
  | 'rate_limit'              // 429
  | 'server_error'            // 5xx
  | 'auth'                    // 401, 403
  | 'not_found'               // 404
  | 'bad_request'             // 400
  | 'content_filter'          // model refused, safety block
  | 'context_length'          // prompt too long
  | 'tool_arguments_invalid'  // withTools() argument validation failure (Zod or validate())
  | 'tool_schema_invalid'     // withTools() — inputSchema missing kind field; legacy shape (v5+)
  | 'structured_parse_failed' // structured() JSON parse or Zod validation failure
  | 'network'                 // ECONNRESET, ETIMEDOUT, etc.
  | 'timeout'                 // per-call timeout
  | 'stream_stall'            // stream silence exceeded streamStallTimeoutMs
  | 'cancelled'               // AbortSignal fired
  | 'http'                    // residual unclassified 4xx
  | 'unknown';                // catch-all

class LlmError extends Error {
  readonly provider: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly kind: LlmErrorKind; // always defined in v1.0.0
}
```

See [MIGRATION.md](./MIGRATION.md) for the full migration table from `err.kind === 'http'` checks to the new specific kinds.

### Gemini cancellation caveat

`@google/genai` does not accept a per-call `AbortSignal`. Cancellation uses `Promise.race` — when the internal controller aborts, we stop awaiting, but the SDK's HTTP request continues in the background until the SDK-level timeout fires. The SDK client is constructed with `httpOptions.timeout = configTimeoutMs * 2` as a backstop. This bounds the leaked request to at most 2× the configured timeout. Native signal support will be added when the SDK provides it.

## Error handling

All provider errors are normalized into `LlmError`:

```typescript
import { LlmError } from '@diabolicallabs/llm-client';

try {
  const response = await client.complete(messages);
} catch (err) {
  if (err instanceof LlmError) {
    console.error(err.provider, err.statusCode, err.retryable, err.kind);
  }
}
```

Retryable errors (429, 5xx, network failures, timeout) are retried automatically with exponential backoff and full jitter before throwing. Cancelled and stream-stall errors are never retried.

## DeepSeek model IDs (v1.0.1+)

DeepSeek retired the `deepseek-chat` and `deepseek-reasoner` identifiers as of 2026. The canonical IDs are:

| Model | API ID | Notes |
|---|---|---|
| V4 Flash | `deepseek-v4-flash` | General use and reasoning (thinking mode). **Canonical default.** |
| V4 Pro | `deepseek-v4-pro` | High-capability tier. Promotional pricing active through 2026-05-31. |

**Deprecated aliases** — DeepSeek's API still accepts these server-side (they route to V4 variants) but new code should use the canonical IDs:

| Deprecated ID | Now routes to | Change |
|---|---|---|
| `deepseek-chat` | `deepseek-v4-flash` non-thinking | Was DeepSeek-V3; now resolves to V4 |
| `deepseek-reasoner` | `deepseek-v4-flash` thinking mode | Was DeepSeek-R1; now resolves to V4 thinking |

Usage:

```typescript
// Canonical V4 Flash (default — replaces deepseek-chat)
const client = createClientFromEnv('deepseek', 'deepseek-v4-flash');

// Canonical V4 Pro
const client = createClientFromEnv('deepseek', 'deepseek-v4-pro');
```

## Per-response cost computation (v1.1.0)

Attach `cost?: LlmCost` to every response by configuring pricing at client creation time. Requires `@diabolicallabs/llm-pricing` as an optional peer dep.

```bash
pnpm add @diabolicallabs/llm-pricing
```

```typescript
import { createClient } from '@diabolicallabs/llm-client';

// createClient() is async (v1.7.0+) — await it
const client = await createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  pricing: { computeOnEveryCall: true },
});

const response = await client.complete(messages);
console.log(response.cost);
// {
//   input:     0.0003,   // USD
//   output:    0.00075,  // USD
//   cacheRead: 0,
//   cacheWrite: 0,
//   total:     0.00105,  // USD
//   currency:  'USD',
//   isPartial: false,    // true for o-series (invisible reasoning tokens) or sonar-deep-research
// }
```

### Remote pricing table (v1.7.0)

Set `pricing.remoteUrl` to fetch the latest prices from a URL on client init, with a stale-while-revalidate cache. No code change or npm release needed when prices change — consumers pick up updates on the next process restart.

```typescript
const client = await createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  pricing: {
    remoteUrl: 'https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/table.json',
    cacheTtlMs: 24 * 60 * 60 * 1000, // 24h (default)
    computeOnEveryCall: true,
  },
});
```

**Precedence (highest → lowest):**

| `pricing.table` | `pricing.remoteUrl` | Result |
|---|---|---|
| set | any | Consumer table always wins — no fetch |
| unset | set | Fetched on init, cached per TTL |
| unset | unset | Bundled `DEFAULT_PRICING_TABLE` |

On fetch failure (network error, HTTP error, schema validation failure, 5s timeout), the client falls back silently to `DEFAULT_PRICING_TABLE` and logs a structured warning. Pricing failures never crash LLM calls.

A structured `pricing_source` log line is emitted on every `createClient()` with a pricing config:

```json
{ "event": "pricing_source", "source": "remote", "url": "...", "fetchedAt": "..." }
```

`source` is one of: `"remote"` | `"cache"` | `"fallback"` | `"bundled"` | `"consumer_override"`.

### Static table override

The `pricing.table` option accepts a custom `PricingTable` from `@diabolicallabs/llm-pricing` to override default rates:

```typescript
import { DEFAULT_PRICING_TABLE } from '@diabolicallabs/llm-pricing';

const client = await createClient({
  provider: 'openai',
  model: 'gpt-5.5',
  apiKey: process.env.OPENAI_API_KEY!,
  pricing: {
    computeOnEveryCall: true,
    table: {
      ...DEFAULT_PRICING_TABLE,
      openai: {
        'gpt-5.5': { inputPer1M: 4.5, outputPer1M: 28.0, verifiedAt: '2026-05-14', sourceUrl: 'internal' },
      },
    },
  },
});
```

`stream()` does not attach cost — cost requires final token counts from a complete response. Use `complete()` if you need cost tracking. See [`@diabolicallabs/llm-pricing`](../llm-pricing/README.md) for the full pricing table, maintenance plan, and `pnpm pricing:verify` diagnostic script.

## Hooks (v1.5.0+)

Attach `beforeCall` and `afterCall` hooks to any `createClient()` config. Hooks fire for all five call types: `complete`, `stream`, `structured`, `withTools`, `streamStructured`.

```typescript
const client = createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  hooks: {
    beforeCall: async (ctx) => {
      // ctx.callType, ctx.provider, ctx.model, ctx.messages, ctx.options
    },
    afterCall: async (ctx) => {
      // ctx.request, ctx.response, ctx.usage, ctx.error, ctx.latencyMs
    },
  },
});
```

### `beforeCall` — request mutation

Return `{ messages, options }` to replace the originals for that call. Subsequent calls use the original config values.

```typescript
hooks: {
  // PII redaction before the request leaves the process
  beforeCall: async (ctx) => ({
    messages: ctx.messages.map((m) => ({
      ...m,
      content: redactPii(m.content),
    })),
  }),
}
```

### `beforeCall` — short-circuit caching

Return `{ skip: cachedResponse }` to return a pre-built response without executing the provider call. The retry and failover layers do not fire.

```typescript
hooks: {
  beforeCall: async (ctx) => {
    const cached = await cache.get(cacheKey(ctx.messages));
    if (cached) return { skip: cached };
  },
}
```

For streaming call types (`stream`, `streamStructured`), `skip` must be an `AsyncGenerator` matching the call's event shape.

### `afterCall` — observability

Fires after the call completes (or after generator exhaustion for streams). Errors in `afterCall` are caught, logged as a structured warning, and dropped — they never crash the call that already returned.

```typescript
hooks: {
  afterCall: async (ctx) => {
    logger.info({
      callType: ctx.request.callType,
      model: ctx.request.model,
      latencyMs: ctx.latencyMs,
      inputTokens: ctx.usage?.inputTokens,
      outputTokens: ctx.usage?.outputTokens,
      error: ctx.error?.message,
    });
  },
}
```

**`ctx.usage` (v1.6.0+):** Populated for all 5 call types. For non-streaming paths (`complete`, `structured`, `withTools`), `ctx.usage` mirrors `ctx.response.usage`. For `stream()`, usage comes from the terminal chunk; for `streamStructured()`, from the `done` event. `ctx.usage` is `undefined` only when the call failed before a response was received.

**`ctx.response`:** `undefined` for `stream()` and `streamStructured()` — no accumulated response object exists for streaming calls. Read token counts from `ctx.usage` instead.

### Hook contract

| Property | Value |
|---|---|
| Firing frequency | Once per public method invocation — NOT per retry attempt |
| `beforeCall` error | Propagates as `LlmError({ kind: 'bad_request' })` |
| `afterCall` error | Logged as structured warn, dropped — never propagates |
| `ctx.model` at `beforeCall` | Primary (first) model in config array. May differ from `response.model` if failover fires. |
| `ctx.usage` (v1.6.0+) | Populated for all 5 call types. `undefined` only on error paths (call failed before a response). |
| `ctx.response` on streaming | `undefined` for `stream()` and `streamStructured()` — read token counts from `ctx.usage`. |

### When to use hooks vs `instrumentClient`

Use **hooks** when you want request-level interception: PII redaction, system prompt injection, cache short-circuit, custom logging. Hooks are configured directly on `createClient()`.

Use **[`@diabolicallabs/agent-sdk`](../agent-sdk/README.md)** when you want ingestion of `CallRecord` objects to the Agent Spend Dashboard. `instrumentClient()` internally uses the hooks infrastructure since v1.4.0, but the public API (`instrumentClient`, `CallRecord`, `AgentSdkConfig`) stays the SDK's entry point.

Both compose: `instrumentClient()` merges its `afterCall` handler with any hooks already set on the client config.

## Multimodal content blocks (v4.2.0)

`LlmMessage.content` now accepts `string | LlmContentBlock[]`. String content is backward-compatible across all providers. Array content enables images and PDFs for the providers that support them.

### Provider support table

| Provider | image.base64 | image.url | document.pdfBase64 |
|---|---|---|---|
| Anthropic (claude-3.5+ / claude-opus-4 / claude-sonnet-4 / claude-haiku-4-5+) | Yes | Yes | Yes |
| Anthropic claude-haiku-3 | No | No | No |
| OpenAI (gpt-5.5 / gpt-5.5-pro / gpt-5.4 / gpt-5.4-mini / gpt-4.1) | Yes | Yes | Yes |
| OpenAI o4-mini | Yes (image) | Yes (image) | No |
| Gemini (all) | Yes | No | Yes |
| Perplexity (all) | No — deferred | No — deferred | No |
| DeepSeek (all) | No | No | No |

Gemini only accepts images via `inlineData` (base64 bytes). Image URL source is not supported on Gemini — the toolkit throws `LlmError({ kind: 'bad_request' })` before making any SDK call.

Use `getModelCapabilities(provider, model).mediaInput` to check support programmatically before constructing a multimodal message.

### Usage example

```typescript
import { type LlmContentBlock, type LlmMessage, createClient } from '@diabolicallabs/llm-client';

const client = createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const blocks: LlmContentBlock[] = [
  {
    type: 'document',
    source: { type: 'base64', mediaType: 'application/pdf', data: pdfBase64 },
  },
  {
    type: 'image',
    source: { type: 'base64', mediaType: 'image/jpeg', data: jpegBase64 },
  },
  { type: 'text', text: 'Summarize these materials.' },
];

const response = await client.complete([
  { role: 'system', content: 'You are a brand strategist.' },
  { role: 'user', content: blocks },
]);
```

### Known limits (API-enforced, not toolkit-validated)

- Anthropic: max 20 MB per image; PDFs via base64 source (no URL PDFs in v4.2.0).
- Gemini: max ~50 MB total inline data per request; PDFs up to 1000 pages via `inlineData`.
- OpenAI: standard Responses API file limits apply.

### Unsupported media behavior

Providers that don't support a block type throw `LlmError({ kind: 'bad_request', retryable: false })` **before any network call**. The error message names the provider and the unsupported block/source type:

```
[llm-client] Provider 'gemini' does not support image content with source 'url' in LlmMessage.content.
Use a supported provider/model or convert the attachment to text before calling this provider.
```

## Token normalization

All providers return `LlmUsage` in a consistent shape regardless of the underlying API's field names:

```typescript
interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationTokens?: number; // Anthropic prompt cache only
  cacheReadTokens?: number;     // Anthropic prompt cache only
}
```
