/**
 * DeepSeek provider smoke test.
 *
 * Validates: single-turn complete() call against deepseek-v4-flash (canonical V4 default).
 * Expected: successful response with normalized LlmUsage, model string, content.
 *
 * Canonical model IDs (as of 2026-05-13):
 *   deepseek-v4-flash  — general + reasoning (thinking mode via providerOptions)
 *   deepseek-v4-pro    — high-capability tier
 *
 * Retired IDs (DeepSeek retired both on 2026-07-24 15:59 UTC, no fallback alias —
 * llm-client rejects them client-side as of the 2026-08-18 fix; see deepseek.test.ts
 * "retired model rejection" for the automated coverage):
 *   deepseek-chat      — was DeepSeek-V3; now throws LlmError(kind:'bad_request')
 *   deepseek-reasoner  — was DeepSeek-R1; now throws LlmError(kind:'bad_request')
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

const client = await createClientFromEnv('deepseek', 'deepseek-v4-flash', { maxTokens: 5 });

console.log('[smoke-deepseek] Starting complete() call...');
const start = Date.now();

try {
  const result = await client.complete([{ role: 'user', content: 'Reply with: ok' }]);
  const latency = Date.now() - start;

  console.log('[smoke-deepseek] Success');
  console.log(`  model:   ${result.model}`);
  console.log(`  content: ${result.content.slice(0, 80)}`);
  console.log(
    `  usage:   in=${result.usage.inputTokens} out=${result.usage.outputTokens} total=${result.usage.totalTokens}`
  );
  console.log(`  latency: ${latency}ms`);
} catch (err) {
  console.error('[smoke-deepseek] FAILED:', err);
  process.exit(1);
}
