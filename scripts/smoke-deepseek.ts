/**
 * DeepSeek provider smoke test.
 *
 * Validates: single-turn complete() call against deepseek-chat (DeepSeek-V3).
 * Expected: successful response with normalized LlmUsage, model string, content.
 *
 * Requires: DEEPSEEK_API_KEY in environment.
 * Run: set -a; source .env; set +a && npx tsx scripts/smoke-deepseek.ts
 */

import { createClientFromEnv } from '../packages/llm-client/src/client.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('ERROR: DEEPSEEK_API_KEY not set');
  process.exit(1);
}

const client = createClientFromEnv('deepseek', 'deepseek-chat', { maxTokens: 5 });

console.log('[smoke-deepseek] Starting complete() call...');
const start = Date.now();

try {
  const result = await client.complete([{ role: 'user', content: 'Reply with: ok' }]);
  const latency = Date.now() - start;

  console.log('[smoke-deepseek] Success');
  console.log(`  model:   ${result.model}`);
  console.log(`  content: ${result.content.slice(0, 80)}`);
  console.log(`  usage:   in=${result.usage.inputTokens} out=${result.usage.outputTokens} total=${result.usage.totalTokens}`);
  console.log(`  latency: ${latency}ms`);
} catch (err) {
  console.error('[smoke-deepseek] FAILED:', err);
  process.exit(1);
}
