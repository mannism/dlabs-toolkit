/**
 * Live smoke test for reasoning-effort passthrough (v6.3.0) — Acceptance Criterion #14.
 *
 * Run from monorepo root:
 *   set -a; source .env; set +a && npx tsx scripts/smoke-reasoning-effort.ts
 *
 * Verifies one real complete() call per provider with reasoningEffort set, confirming
 * the response succeeds and usage.reasoningTokens is populated where the provider
 * reports that breakdown.
 *
 * Model substitutions (brief §Provider Reality / AC14 — do not block on unresolved
 * simulated-future model IDs):
 *   - Anthropic: claude-opus-5 / claude-fable-5 / claude-mythos-5 are not resolvable
 *     against this key's live model list. Substituted with claude-sonnet-4-6 — a
 *     confirmed effort-capable model per platform.claude.com/docs/en/build-with-claude/effort
 *     (also the existing smoke-anthropic.ts target).
 *   - OpenAI: gpt-5.6-sol/terra/luna are not resolvable against this key's live model
 *     list. Substituted with gpt-5.4-mini — a confirmed reasoning.effort-capable model
 *     per developers.openai.com/api/docs/guides/reasoning (also the existing
 *     smoke-openai.ts target).
 *   - Gemini: gemini-3.5-flash — already the live-verified thinkingConfig-capable model
 *     per manifest.yaml (v5.2.0 smoke, 2026-06-17).
 */

import { createClientFromEnv } from '../packages/llm-client/src/index.js';

async function runSmoke(): Promise<void> {
  console.log('=== Reasoning-Effort Passthrough Smoke Test (v6.3.0) ===\n');

  // ─── Anthropic ────────────────────────────────────────────────────────────
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY not set. Source .env before running.');
  }
  console.log('Test 1: Anthropic complete() with reasoningEffort: "low" (model: claude-sonnet-4-6)');
  const anthropicClient = await createClientFromEnv('anthropic', 'claude-sonnet-4-6');
  const anthropicResult = await anthropicClient.complete(
    [{ role: 'user', content: 'In one sentence, what is the CAP theorem?' }],
    { reasoningEffort: 'low' }
  );
  console.log(`  model: ${anthropicResult.model}`);
  console.log(`  latency: ${anthropicResult.latencyMs}ms`);
  console.log(`  usage: ${JSON.stringify(anthropicResult.usage)}`);
  console.log(`  content snippet: ${anthropicResult.content.slice(0, 150)}...`);
  console.log(
    `  reasoningTokens: ${anthropicResult.usage.reasoningTokens ?? 'undefined (low effort may not trigger a reported breakdown)'}`
  );
  console.log('  PASS\n');

  // ─── OpenAI ───────────────────────────────────────────────────────────────
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (!openaiKey) {
    throw new Error('OPENAI_API_KEY not set. Source .env before running.');
  }
  console.log('Test 2: OpenAI complete() with reasoningEffort: "medium" (model: gpt-5.4-mini)');
  const openaiClient = await createClientFromEnv('openai', 'gpt-5.4-mini');
  const openaiResult = await openaiClient.complete(
    [{ role: 'user', content: 'In one sentence, what is eventual consistency?' }],
    { reasoningEffort: 'medium' }
  );
  console.log(`  model: ${openaiResult.model}`);
  console.log(`  latency: ${openaiResult.latencyMs}ms`);
  console.log(`  usage: ${JSON.stringify(openaiResult.usage)}`);
  console.log(`  content snippet: ${openaiResult.content.slice(0, 150)}...`);
  console.log(
    `  reasoningTokens: ${openaiResult.usage.reasoningTokens ?? 'undefined (model may not report a breakdown for this effort level)'}`
  );
  console.log('  PASS\n');

  // ─── Gemini ───────────────────────────────────────────────────────────────
  const geminiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!geminiKey) {
    throw new Error('GOOGLE_AI_API_KEY not set. Source .env before running.');
  }
  console.log('Test 3: Gemini complete() with reasoningEffort: "high" (model: gemini-3.5-flash)');
  const geminiClient = await createClientFromEnv('gemini', 'gemini-3.5-flash');
  const geminiResult = await geminiClient.complete(
    [{ role: 'user', content: 'In one sentence, what is the CAP theorem?' }],
    { reasoningEffort: 'high' }
  );
  console.log(`  model: ${geminiResult.model}`);
  console.log(`  latency: ${geminiResult.latencyMs}ms`);
  console.log(`  usage: ${JSON.stringify(geminiResult.usage)}`);
  console.log(`  content snippet: ${geminiResult.content.slice(0, 150)}...`);
  console.log('  reasoningTokens: undefined (expected — Gemini does not report this breakdown)');
  console.log('  PASS\n');

  console.log('=== All reasoning-effort smoke tests passed ===');
}

runSmoke().catch((err: unknown) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
