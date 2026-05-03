# @diabolicallabs/llm-client

Unified LLM API across Anthropic, OpenAI, Google, and DeepSeek. © Diabolical Labs

## Status

**Scaffolded.** Types and public API surface are defined. Provider implementations ship Week 2 (Anthropic + OpenAI) and Week 3 (Google + DeepSeek).

## Install

```bash
# .npmrc must point @diabolicallabs scope at GitHub Packages
pnpm add @diabolicallabs/llm-client
```

Consumer `.npmrc`:

```
@diabolicallabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Usage

```typescript
import { createClient, createClientFromEnv } from '@diabolicallabs/llm-client';

// From explicit config
const client = createClient({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

// From environment variables (reads ANTHROPIC_API_KEY automatically)
const client = createClientFromEnv('anthropic', 'claude-sonnet-4-6');

// Non-streaming
const response = await client.complete([
  { role: 'user', content: 'Hello' },
]);
console.log(response.content, response.usage);

// Streaming
for await (const chunk of client.stream([{ role: 'user', content: 'Hello' }])) {
  process.stdout.write(chunk.token);
}

// Structured output (Zod schema)
import { z } from 'zod';
const schema = z.object({ name: z.string(), score: z.number() });
const result = await client.structured(messages, schema);
// result.data is typed as { name: string; score: number }
```

## API

### `createClient(config: LlmClientConfig): LlmClient`

Creates an LlmClient for the given provider.

### `createClientFromEnv(provider, model, overrides?): LlmClient`

Reads the API key from the environment:
- `anthropic` → `ANTHROPIC_API_KEY`
- `openai` → `OPENAI_API_KEY`
- `google` → `GOOGLE_AI_API_KEY`
- `deepseek` → `DEEPSEEK_API_KEY`

### `LlmClient` interface

| Method | Description |
|---|---|
| `complete(messages, options?)` | Non-streaming completion. Returns `LlmResponse`. |
| `stream(messages, options?)` | Streaming — async generator of `LlmStreamChunk`. Final chunk includes `usage`. |
| `structured(messages, schema, options?)` | Structured output validated against a Zod schema. Returns `LlmStructuredResponse<T>`. |

### Error handling

All provider errors are normalised into `LlmError`:

```typescript
import { LlmError } from '@diabolicallabs/llm-client';

try {
  const response = await client.complete(messages);
} catch (err) {
  if (err instanceof LlmError) {
    console.error(err.provider, err.statusCode, err.retryable);
  }
}
```

Retryable errors (429, 5xx, network) are retried automatically up to `maxRetries` times with exponential backoff + full jitter before throwing.

## Token normalisation

All providers return `LlmUsage` in a consistent shape regardless of the underlying API's field names:

```typescript
interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationTokens?: number; // Anthropic only
  cacheReadTokens?: number;     // Anthropic only
}
```
