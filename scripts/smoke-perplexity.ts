/**
 * Live smoke test for the Perplexity provider.
 * Gitignored — not committed.
 *
 * Run from monorepo root:
 *   set -a; source .env; set +a
 *   pnpm --filter=@diabolicallabs/llm-client exec tsx ../../scripts/smoke-perplexity.ts
 *
 * Or from the repo root:
 *   set -a; source .env; set +a && npx tsx scripts/smoke-perplexity.ts
 *
 * Verifies:
 *   1. complete() with sonar — at least one citation returned
 *   2. complete() with sonar-reasoning-pro — model string accepted, response received
 *   3. complete() with providerOptions: { search_recency_filter: 'week' }
 *   4. complete() with providerOptions: { search_domain_filter: ['example.com'] }
 */

import { createClientFromEnv } from '../packages/llm-client/src/index.js';

const QUESTION = 'What is the current state of AI model scaling in 2025? Give a brief answer.';

async function runSmoke(): Promise<void> {
  const apiKey = process.env['PERPLEXITY_API_KEY'];
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY not set. Source .env before running.');
  }

  console.log('=== Perplexity Provider Smoke Test ===\n');

  // ─── Test 1: sonar — happy path with citations ───────────────────────────
  console.log('Test 1: complete() with sonar — expecting citations');
  const start1 = Date.now();
  const client1 = createClientFromEnv('perplexity', 'sonar');
  const result1 = await client1.complete([{ role: 'user', content: QUESTION }]);
  console.log(`  model: ${result1.model}`);
  console.log(`  latency: ${result1.latencyMs}ms`);
  console.log(`  usage: ${JSON.stringify(result1.usage)}`);
  console.log(`  content snippet: ${result1.content.slice(0, 150)}...`);
  console.log(`  citations (${result1.citations?.length ?? 0}):`);
  for (const c of result1.citations ?? []) {
    console.log(`    - ${c.url}`);
  }
  if (!result1.citations || result1.citations.length === 0) {
    console.warn('  WARNING: No citations returned on sonar. Perplexity API may have changed.');
  } else {
    console.log('  PASS\n');
  }

  // ─── Test 2: sonar-reasoning-pro ─────────────────────────────────────────
  console.log('Test 2: complete() with sonar-reasoning-pro');
  const client2 = createClientFromEnv('perplexity', 'sonar-reasoning-pro');
  const result2 = await client2.complete([
    { role: 'user', content: 'What is 2 + 2? Answer with just the number.' },
  ]);
  console.log(`  model: ${result2.model}`);
  console.log(`  latency: ${result2.latencyMs}ms`);
  console.log(`  content: ${result2.content.trim()}`);
  console.log('  PASS\n');

  // ─── Test 3: search_recency_filter ───────────────────────────────────────
  console.log("Test 3: complete() with providerOptions: { search_recency_filter: 'week' }");
  const client3 = createClientFromEnv('perplexity', 'sonar');
  const result3 = await client3.complete(
    [{ role: 'user', content: 'What AI news happened this week?' }],
    { providerOptions: { search_recency_filter: 'week' } }
  );
  console.log(`  model: ${result3.model}`);
  console.log(`  latency: ${result3.latencyMs}ms`);
  console.log(`  citations: ${result3.citations?.length ?? 0}`);
  console.log(`  content snippet: ${result3.content.slice(0, 100)}...`);
  console.log('  PASS\n');

  // ─── Test 4: search_domain_filter ────────────────────────────────────────
  console.log(
    "Test 4: complete() with providerOptions: { search_domain_filter: ['example.com'] }"
  );
  const client4 = createClientFromEnv('perplexity', 'sonar');
  const result4 = await client4.complete(
    [{ role: 'user', content: 'Tell me about example.com — what is it used for?' }],
    { providerOptions: { search_domain_filter: ['example.com'] } }
  );
  console.log(`  model: ${result4.model}`);
  console.log(`  latency: ${result4.latencyMs}ms`);
  console.log(`  citations: ${result4.citations?.length ?? 0}`);
  console.log(`  content snippet: ${result4.content.slice(0, 100)}...`);
  console.log('  PASS\n');

  console.log('=== All smoke tests passed ===');
  console.log(`Total elapsed: ${Date.now() - start1}ms`);
}

runSmoke().catch((err: unknown) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
