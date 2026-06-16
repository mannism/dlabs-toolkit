/**
 * Live smoke test for the Gemini provider.
 *
 * Run from monorepo root:
 *   set -a; source .env; set +a && npx tsx scripts/smoke-gemini.ts
 *
 * Models tested:
 *   - gemini-2.5-flash — GEOAudit default (api/server.js:109). Confirmed 2026-05-12.
 *   - gemini-3.5-flash — Google GA flagship (released 2026-05-19). Added 2026-06-17.
 *
 * Env var: GOOGLE_AI_API_KEY (as resolved by createClientFromEnv for the gemini provider).
 *
 * Verifies per model:
 *   1. complete() happy path — logs model/latency/usage/content snippet
 *   2. stream() — accumulates tokens, logs usage from final chunk
 *   3. structured() with Zod 4 schema — exercises responseSchema + responseMimeType path
 *
 * Caveat: @google/genai SDK does not accept per-call AbortSignal. Cancellation is
 * implemented via Promise.race; see gemini.ts module-level caveat comment for details.
 */

import { z } from 'zod';
import { createClientFromEnv } from '../packages/llm-client/src/index.js';
import type { LlmUsage } from '../packages/llm-client/src/types.js';

const MODELS = ['gemini-2.5-flash', 'gemini-3.5-flash'] as const;

const TopicSchema = z.object({
  topic: z.string(),
  bullets: z.array(z.string()),
});

async function smokeModel(model: string): Promise<void> {
  console.log(`\n── ${model} ──────────────────────────────────────────────────\n`);
  const modelStart = Date.now();

  // ─── Test 1: complete() happy path ───────────────────────────────────────
  console.log(`Test 1: complete() with ${model} — happy path`);
  const client1 = await createClientFromEnv('gemini', model);
  const result1 = await client1.complete([
    {
      role: 'user',
      content:
        'What is the main advantage of using a CQRS architecture pattern? Answer in two concise sentences.',
    },
  ]);
  // Gemini provider returns the model name from config (response.modelVersion where available).
  console.log(`  model: ${result1.model}`);
  console.log(`  latency: ${result1.latencyMs}ms`);
  console.log(`  usage: ${JSON.stringify(result1.usage)}`);
  console.log(`  content snippet: ${result1.content.slice(0, 200)}`);
  if (!result1.content || result1.content.length === 0) {
    throw new Error(`[${model}] complete() returned empty content`);
  }
  console.log('  PASS\n');

  // ─── Test 2: stream() ─────────────────────────────────────────────────────
  // Gemini's generateContentStream() yields GenerateContentResponse chunks.
  // Usage is captured on each chunk — the final chunk has the complete totals.
  // The provider wraps the SDK stream with withStallTimeout and yields an empty
  // sentinel chunk with usage at the end (gemini.ts:272).
  console.log(`Test 2: stream() with ${model}`);
  const client2 = await createClientFromEnv('gemini', model);
  let accumulated = '';
  let finalUsage: LlmUsage | undefined;

  for await (const chunk of client2.stream([
    {
      role: 'user',
      content: 'List three benefits of event sourcing in one sentence each.',
    },
  ])) {
    accumulated += chunk.token;
    if (chunk.usage !== undefined) {
      finalUsage = chunk.usage;
    }
  }

  if (finalUsage === undefined) {
    throw new Error(`[${model}] stream() final chunk did not include usage`);
  }
  console.log(`  accumulated chars: ${accumulated.length}`);
  console.log(`  content snippet: ${accumulated.slice(0, 200)}`);
  console.log(`  final usage: ${JSON.stringify(finalUsage)}`);
  console.log('  PASS\n');

  // ─── Test 3: structured() with Zod 4 schema ──────────────────────────────
  // Gemini structured output uses responseSchema (OpenAPI 3.0 format derived from Zod 4
  // via toProviderSchema) plus responseMimeType: 'application/json'. The provider does a
  // belt-and-braces fence-strip on the response before JSON.parse (gemini.ts:333).
  console.log(`Test 3: structured() with ${model} — Zod 4 responseSchema path`);
  const client3 = await createClientFromEnv('gemini', model);

  const result3 = await client3.structured(
    [
      {
        role: 'user',
        content:
          'Return a JSON object with "topic" set to "Kubernetes" and "bullets" containing exactly three key benefits of container orchestration.',
      },
    ],
    TopicSchema
  );
  // Gemini: model comes from response.modelVersion ?? model config (gemini.ts:363).
  console.log(`  model: ${result3.model}`);
  console.log(`  usage: ${JSON.stringify(result3.usage)}`);
  console.log(`  parsed data: ${JSON.stringify(result3.data, null, 2)}`);
  if (!result3.data.topic || result3.data.bullets.length === 0) {
    throw new Error(`[${model}] structured() returned empty topic or bullets`);
  }
  console.log('  PASS\n');

  console.log(`  ${model} — all 3 tests passed (${Date.now() - modelStart}ms)`);
}

async function runSmoke(): Promise<void> {
  // Pre-flight: explicit env key guard matching smoke-perplexity.ts pattern.
  // createClientFromEnv reads GOOGLE_AI_API_KEY for the gemini provider.
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY not set. Source .env before running.');
  }

  console.log('=== Gemini Provider Smoke Test ===');
  console.log(`Models: ${MODELS.join(', ')}`);
  const overallStart = Date.now();

  for (const model of MODELS) {
    await smokeModel(model);
  }

  console.log(`\n=== All smoke tests passed (${MODELS.length} models × 3 tests) ===`);
  console.log(`Total elapsed: ${Date.now() - overallStart}ms`);
}

runSmoke().catch((err: unknown) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
