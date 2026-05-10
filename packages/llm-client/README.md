# @diabolicallabs/llm-client

Unified LLM API across Anthropic, OpenAI, Google Gemini, DeepSeek, and Perplexity. Single interface for completion, streaming, and structured output. All provider errors are normalized into a consistent `LlmError` shape. © Diabolical Labs

**Pre-1.0. APIs may change between minor versions.**

## Status

**Published — v0.3.0.** All five providers implemented. v0.4.0 adds native strict structured outputs (OpenAI json_schema, Anthropic tool-use, Gemini responseSchema) triggered automatically when a Zod 4 schema is passed.

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
| OpenAI (`gpt-4o`, `gpt-4o-mini`) | `response_format: { type: 'json_schema', strict: true }` | Schema structure guaranteed; model cannot produce off-schema output | No `format`, `pattern`, or recursive schemas (`z.lazy()`). Throws at conversion time with clear message. |
| Anthropic | Tool-use with forced `tool_choice: { type: 'tool', name: 'extract' }` | Model must call the tool; `input` is pre-parsed JSON | Defense-in-depth `schema.parse()` still runs |
| Gemini | `responseSchema` (OpenAPI 3.0) + `responseMimeType: 'application/json'` | Schema communicated to the model; belt-and-braces fence-strip retained | Tested via mocks only — file an issue if Gemini's API rejects the schema shape |
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

### `LlmError.kind` discriminator

```typescript
type LlmErrorKind = 'cancelled' | 'timeout' | 'stream_stall' | 'http' | 'network' | 'unknown';

class LlmError extends Error {
  readonly provider: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly kind: LlmErrorKind | undefined; // undefined on errors from older paths
}
```

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
