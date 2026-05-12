/**
 * Live smoke test for the OpenAI provider.
 * Gitignored — not committed.
 *
 * Run from monorepo root:
 *   set -a; source .env; set +a && npx tsx scripts/smoke-openai.ts
 *
 * Target model: gpt-5.4-mini (the model GEOAudit uses).
 * This smoke specifically exercises the max_completion_tokens rename path:
 * gpt-5.x rejects the legacy max_tokens parameter — if the toolkit's internal
 * rename from max_tokens → max_completion_tokens is broken, Test 1 will throw
 * "unsupported parameter: max_tokens" rather than returning a response.
 *
 * Verifies:
 *   1. complete() with maxTokens: 256 — confirms toolkit renames max_tokens → max_completion_tokens
 *   2. stream() — accumulates tokens, asserts final chunk has usage, logs summary
 *   3. structured() strict path — Zod 4 json_schema mode (native structured output)
 *   4. structured() prompt-fallback path — providerOptions.structuredMode: 'prompt' (GEOAudit's path)
 */

import { z } from 'zod';
import { createClientFromEnv } from '../packages/llm-client/src/index.js';
import type { LlmUsage } from '../packages/llm-client/src/types.js';

// Model used by GEOAudit (api/server.js). Confirmed current 2026-05-12 via OpenAI API docs.
const MODEL = 'gpt-5.4-mini';

async function runSmoke(): Promise<void> {
  // Pre-flight: explicit env key guard matching smoke-perplexity.ts pattern.
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set. Source .env before running.');
  }

  console.log('=== OpenAI Provider Smoke Test ===\n');
  const overallStart = Date.now();

  // ─── Test 1: complete() with maxTokens — proves max_completion_tokens rename ────
  // gpt-5.x rejects max_tokens outright. If the toolkit sends max_tokens instead of
  // max_completion_tokens, the API returns a 400 with "unsupported parameter: max_tokens".
  // A clean response here confirms the rename in openai.ts:145 is functioning.
  console.log(`Test 1: complete() with ${MODEL} and maxTokens: 256 — proves max_completion_tokens rename`);
  const client1 = createClientFromEnv('openai', MODEL);
  const result1 = await client1.complete(
    [
      {
        role: 'user',
        content:
          'What is the difference between strong consistency and eventual consistency? Answer in two short sentences.',
      },
    ],
    { maxTokens: 256 }
  );
  console.log(`  model: ${result1.model}`);
  console.log(`  latency: ${result1.latencyMs}ms`);
  console.log(`  usage: ${JSON.stringify(result1.usage)}`);
  console.log(`  content snippet: ${result1.content.slice(0, 200)}`);
  if (!result1.content || result1.content.length === 0) {
    throw new Error('complete() returned empty content');
  }
  console.log('  PASS\n');

  // ─── Test 2: stream() ─────────────────────────────────────────────────────
  console.log(`Test 2: stream() with ${MODEL}`);
  const client2 = createClientFromEnv('openai', MODEL);
  let accumulated = '';
  let finalUsage: LlmUsage | undefined;

  for await (const chunk of client2.stream([
    {
      role: 'user',
      content: 'Name three widely-used API rate limiting algorithms. One sentence each.',
    },
  ])) {
    accumulated += chunk.token;
    if (chunk.usage !== undefined) {
      finalUsage = chunk.usage;
    }
  }

  if (finalUsage === undefined) {
    throw new Error('stream() final chunk did not include usage');
  }
  console.log(`  accumulated chars: ${accumulated.length}`);
  console.log(`  content snippet: ${accumulated.slice(0, 200)}`);
  console.log(`  final usage: ${JSON.stringify(finalUsage)}`);
  console.log('  PASS\n');

  // ─── Test 3: structured() strict path — Zod 4 json_schema mode ──────────
  // Exercises response_format: { type: 'json_schema', strict: true } in openai.ts:278.
  console.log(`Test 3: structured() with ${MODEL} — Zod 4 json_schema strict mode`);
  const client3 = createClientFromEnv('openai', MODEL);

  const TopicSchema = z.object({
    topic: z.string(),
    bullets: z.array(z.string()),
  });

  const result3 = await client3.structured(
    [
      {
        role: 'user',
        content:
          'Return a JSON object with "topic" set to "Redis" and "bullets" containing exactly three key use cases for Redis.',
      },
    ],
    TopicSchema
  );
  console.log(`  model: ${result3.model}`);
  console.log(`  usage: ${JSON.stringify(result3.usage)}`);
  console.log(`  parsed data: ${JSON.stringify(result3.data, null, 2)}`);
  if (!result3.data.topic || result3.data.bullets.length === 0) {
    throw new Error('structured() strict path returned empty topic or bullets');
  }
  console.log('  PASS\n');

  // ─── Test 4: structured() prompt-fallback path ───────────────────────────
  // GEOAudit (api/server.js:610) passes structuredMode: 'prompt' for all providers.
  // This exercises the prompt-only json_object path in openai.ts:363, including the
  // parseJsonOrThrow extractor that handles fences and trailing prose.
  console.log(`Test 4: structured() with ${MODEL} — prompt-fallback path (GEOAudit's call shape)`);
  const client4 = createClientFromEnv('openai', MODEL);

  const FallbackSchema = z.object({
    topic: z.string(),
    bullets: z.array(z.string()),
  });

  const result4 = await client4.structured(
    [
      {
        role: 'user',
        content:
          'Return a JSON object with "topic" set to "CAP Theorem" and "bullets" containing exactly two key implications.',
      },
    ],
    FallbackSchema,
    { providerOptions: { structuredMode: 'prompt' } }
  );
  console.log(`  model: ${result4.model}`);
  console.log(`  usage: ${JSON.stringify(result4.usage)}`);
  console.log(`  parsed data: ${JSON.stringify(result4.data, null, 2)}`);
  if (!result4.data.topic || result4.data.bullets.length === 0) {
    throw new Error('structured() prompt-fallback returned empty topic or bullets');
  }
  console.log('  PASS\n');

  console.log('=== All smoke tests passed ===');
  console.log(`Total elapsed: ${Date.now() - overallStart}ms`);
}

runSmoke().catch((err: unknown) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
