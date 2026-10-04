/**
 * Live smoke test for the xAI (Grok) provider.
 *
 * Run from the repo root:
 *   set -a; source .env; set +a && npx tsx scripts/smoke-xai.ts [--only=1,2]
 *
 * Every case prints the toolkit-computed cost (llm-pricing, from token + server tool counts)
 * beside xAI's own billed cost (usage.providerReportedCostUsd) and asserts they agree within
 * $0.0001. Keep prompts short and maxToolCalls low — agentic tool calls bill per call.
 *
 * Cases (added incrementally):
 *   1. plain complete()
 *   2. x_search with a handle allowlist and date range
 *   3. web_search
 */

import { createClientFromEnv } from '../packages/llm-client/src/index.js';
import type { LlmResponse } from '../packages/llm-client/src/index.js';

/** Maximum tolerated gap (USD) between computed and provider-reported cost. */
const COST_TOLERANCE_USD = 0.0001;

/** Case selection: --only=1,2 runs just those; default runs all. */
function selectedCases(): Set<number> | null {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  if (arg === undefined) return null;
  return new Set(
    arg
      .slice('--only='.length)
      .split(',')
      .map((n) => Number(n))
  );
}

let totalReportedUsd = 0;
let failures = 0;

/** Print usage + both costs and assert agreement. Returns whether the case passed. */
function reportCost(label: string, response: LlmResponse): boolean {
  const computed = response.cost?.total;
  const reported = response.usage.providerReportedCostUsd;
  console.log(`  usage: ${JSON.stringify(response.usage)}`);
  console.log(`  cost.computed:  ${computed?.toFixed(6) ?? 'n/a'} (partial: ${response.cost?.isPartial})`);
  console.log(`  cost.reported:  ${reported?.toFixed(6) ?? 'n/a'}`);
  if (reported !== undefined) totalReportedUsd += reported;
  if (computed === undefined || reported === undefined) {
    console.log(`  FAIL (${label}): missing cost on one side`);
    return false;
  }
  const delta = Math.abs(computed - reported);
  const ok = delta <= COST_TOLERANCE_USD;
  console.log(`  cost.delta:     ${delta.toFixed(6)} → ${ok ? 'PASS' : 'FAIL'}`);
  return ok;
}

/** Run one case, counting a thrown error as a failure without aborting later cases. */
async function runCase(n: number, title: string, fn: () => Promise<boolean>): Promise<void> {
  const only = selectedCases();
  if (only !== null && !only.has(n)) return;
  console.log(`\nCase ${n}: ${title}`);
  try {
    if (!(await fn())) failures += 1;
  } catch (err) {
    failures += 1;
    console.log(`  FAIL (${title}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  if (!process.env['XAI_API_KEY']) {
    throw new Error('XAI_API_KEY not set. Source .env before running.');
  }
  console.log('=== xAI Provider Smoke Test ===');

  // Pricing enabled so response.cost is populated; the 2-minute timeout covers agentic calls.
  const client = await createClientFromEnv('xai', 'grok-4.7', {
    pricing: { computeOnEveryCall: true },
    timeoutMs: 120_000,
    maxRetries: 1,
  });

  await runCase(1, 'plain complete()', async () => {
    const r = await client.complete([{ role: 'user', content: 'Reply with exactly: pong' }], {
      maxTokens: 400,
      reasoningEffort: 'low',
    });
    console.log(`  model: ${r.model}  latency: ${r.latencyMs}ms`);
    console.log(`  content: ${r.content.trim().slice(0, 100)}`);
    return reportCost('plain', r) && r.content.length > 0;
  });

  await runCase(2, 'x_search with handle allowlist + date range', async () => {
    const r = await client.complete(
      [
        {
          role: 'user',
          content: 'In one sentence, what did @SpaceXAI most recently post about?',
        },
      ],
      {
        reasoningEffort: 'low',
        providerOptions: {
          serverTools: [
            {
              type: 'xSearch',
              allowedXHandles: ['SpaceXAI'],
              fromDate: '2026-09-01',
              toDate: '2026-10-04',
            },
          ],
          maxToolCalls: 3,
        },
      }
    );
    console.log(`  model: ${r.model}  latency: ${r.latencyMs}ms`);
    console.log(`  content: ${r.content.trim().slice(0, 200)}`);
    console.log(`  citations (${r.citations?.length ?? 0}): ${(r.citations ?? []).map((c) => c.url).join(', ')}`);
    console.log(`  serverToolCalls: ${JSON.stringify(r.serverToolCalls)}`);
    const costOk = reportCost('x_search', r);
    const used = r.usage.serverToolUsage?.xSearchCalls ?? 0;
    if (used < 1) console.log('  FAIL: xSearchCalls usage not reported');
    return costOk && used >= 1;
  });

  await runCase(3, 'web_search', async () => {
    const r = await client.complete(
      [{ role: 'user', content: 'In one sentence: what is the current stable Node.js LTS version?' }],
      {
        reasoningEffort: 'low',
        providerOptions: {
          serverTools: [{ type: 'webSearch' }],
          maxToolCalls: 2,
        },
      }
    );
    console.log(`  content: ${r.content.trim().slice(0, 200)}`);
    console.log(`  citations (${r.citations?.length ?? 0})`);
    const costOk = reportCost('web_search', r);
    return costOk && (r.usage.serverToolUsage?.webSearchCalls ?? 0) >= 1;
  });

  console.log(`\nTotal provider-reported spend this run: $${totalReportedUsd.toFixed(4)}`);
  console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
