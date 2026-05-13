# @diabolicallabs/llm-client

Unified LLM API across Anthropic, OpenAI, Google Gemini, DeepSeek, and Perplexity. Single interface for completion, streaming, structured output, and native tool calling. All provider errors are normalized into a consistent `LlmError` shape. © Diabolical Labs

## Status

**v1.0.0 (pending publish).** All five providers fully implemented. See [MIGRATION.md](./MIGRATION.md) for breaking changes from v0.x.

Highlights:
- **v1.0.0** — Native tool calling (`withTools()`), expanded `LlmErrorKind` taxonomy, OpenAI Responses API migration.
- **v0.4.3** — Opt-in Anthropic prompt caching via `providerOptions.promptCache`.
- **v0.4.0** — Native strict structured outputs (Zod 4 schema → OpenAI json_schema, Anthropic tool-use, Gemini responseSchema).

## Install

```bash
pnpm add @diabolicallabs/llm-client
```

Public on npmjs.com — no `.npmrc` config required.

## Usage

```typescript
import { createClient, createClientFromEnv } from '@diabolicallabs/llm-client';

// From explicit config
const client = createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// From environment variables
const client = createClientFromEnv('anthropic', 'claude-sonnet-4-6');

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

```typescript
import { z } from 'zod';
import { createClientFromEnv } from '@diabolicallabs/llm-client';

const client = createClientFromEnv('anthropic', 'claude-sonnet-4-6');

const weatherTool = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
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
    console.log(call.toolName, call.arguments); // arguments is validated by inputSchema
    console.log(call.id);         // use as tool_call_id in the follow-up message
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

Each `LlmTool.inputSchema` must expose a `.parse(data: unknown)` method. If the model returns arguments that fail validation, `withTools()` throws `LlmError` with `kind: 'tool_arguments_invalid'`, `retryable: false`. A Zod 4 schema satisfies this interface automatically.

### Gemini ID synthesis

Gemini does not issue tool call IDs. The toolkit synthesizes UUID v7-style IDs (time-based + random) for every `LlmToolCall.id` on the Gemini path. These IDs are unique within a request but not cryptographically random.

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
  | 'rate_limit'           // 429
  | 'server_error'         // 5xx
  | 'auth'                 // 401, 403
  | 'not_found'            // 404
  | 'bad_request'          // 400
  | 'content_filter'       // model refused, safety block
  | 'context_length'       // prompt too long
  | 'tool_arguments_invalid' // withTools() schema validation failure
  | 'structured_parse_failed' // structured() JSON parse or Zod validation failure
  | 'network'              // ECONNRESET, ETIMEDOUT, etc.
  | 'timeout'              // per-call timeout
  | 'stream_stall'         // stream silence exceeded streamStallTimeoutMs
  | 'cancelled'            // AbortSignal fired
  | 'http'                 // residual unclassified 4xx
  | 'unknown';             // catch-all

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
