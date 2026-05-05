# @diabolicallabs/llm-client

Unified LLM API across Anthropic, OpenAI, Google Gemini, and DeepSeek. Single interface for completion, streaming, and structured output. All provider errors are normalized into a consistent `LlmError` shape. © Diabolical Labs

**Pre-1.0. APIs may change between minor versions.**

## Status

**In progress.** All four providers are implemented. A fifth provider (Perplexity) is a stub and will be implemented in a future release.

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

// Structured output (Zod schema)
import { z } from 'zod';
const schema = z.object({ name: z.string(), score: z.number() });
const result = await client.structured(messages, schema);
// result.data is typed as { name: string; score: number }
```

## Provider universe

| Provider | Status | Env var |
|---|---|---|
| `anthropic` | Implemented | `ANTHROPIC_API_KEY` |
| `openai` | Implemented | `OPENAI_API_KEY` |
| `google` | Implemented | `GOOGLE_AI_API_KEY` |
| `deepseek` | Implemented | `DEEPSEEK_API_KEY` |
| `perplexity` | Stub — throws `LlmError` | — |

## API

### `createClient(config: LlmClientConfig): LlmClient`

Creates an `LlmClient` for the given provider.

### `createClientFromEnv(provider, model, overrides?): LlmClient`

Reads the API key from the environment automatically:
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

## Error handling

All provider errors are normalized into `LlmError`:

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

Retryable errors (429, 5xx, network failures) are retried automatically with exponential backoff and full jitter before throwing.

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
