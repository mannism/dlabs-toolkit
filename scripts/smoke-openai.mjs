/**
 * smoke-openai.mjs — v0.4.0 OpenAI strict structured output smoke test.
 *
 * Tests gpt-5.4-mini with strict json_schema mode (Zod 4 schema).
 * Gate: if OPENAI_API_KEY is absent, logs a skip notice and exits 0.
 *
 * Usage:
 *   node --env-file=.env scripts/smoke-openai.mjs
 */

if (!process.env.OPENAI_API_KEY) {
  console.log('[smoke-openai] OPENAI_API_KEY not set — skipping OpenAI smoke test.');
  process.exit(0);
}

import { createClient } from '../packages/llm-client/dist/index.js';
import { z } from '../packages/llm-client/node_modules/zod/v4/index.js';

const client = createClient({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o-mini',
  maxRetries: 1,
});

const SCHEMA = z.object({
  topic: z.string(),
  bullets: z.array(z.string()),
});

console.log('\n========== smoke-openai v0.4.0 ==========\n');
console.log('--- OpenAI strict json_schema structured call (Zod 4 schema) ---');

try {
  const result = await client.structured(
    [
      {
        role: 'user',
        content:
          'Return a JSON object with a "topic" field (string: "TypeScript 5.7") and a "bullets" field (array of 2 short strings describing key features).',
      },
    ],
    SCHEMA
  );

  const hasTopic = typeof result.data.topic === 'string' && result.data.topic.length > 0;
  const hasBullets = Array.isArray(result.data.bullets) && result.data.bullets.length > 0;
  const hasModel = typeof result.model === 'string' && result.model.length > 0;
  const hasId = typeof result.id === 'string' && result.id.length > 0;

  if (hasTopic && hasBullets && hasModel && hasId) {
    console.log(`PASS`);
    console.log(`  topic:   "${result.data.topic}"`);
    console.log(`  bullets: ${JSON.stringify(result.data.bullets)}`);
    console.log(`  model:   ${result.model}`);
    console.log(`  id:      ${result.id}`);
    console.log(`  usage:   ${JSON.stringify(result.usage)}`);
    console.log(`  latency: ${result.latencyMs}ms`);
  } else {
    console.error('FAIL  unexpected response shape:');
    console.error('  data:', JSON.stringify(result.data));
    console.error('  model:', result.model);
    console.error('  id:', result.id);
    process.exit(1);
  }
} catch (err) {
  console.error(`FAIL  kind:${err?.kind}  message:${err?.message}`);
  if (err?.cause) console.error('cause:', err.cause?.message ?? err.cause);
  process.exit(1);
}

console.log('\n========== smoke-openai complete ==========');
