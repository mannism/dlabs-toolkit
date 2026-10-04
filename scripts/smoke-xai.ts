/**
 * Live smoke test for the xAI (Grok) provider.
 *
 * Run from the repo root (tsx is not installed locally; `npx tsx` fails here, use pnpm dlx):
 *   set -a; source .env; set +a && pnpm dlx tsx --tsconfig scripts/tsconfig.json scripts/smoke-xai.ts [--only=1,2]
 * (--tsconfig maps the bare 'zod' import, which pnpm only installs under packages/llm-client)
 *
 * Every case prints the toolkit-computed cost (llm-pricing: token + server tool counts) beside
 * xAI's own billed cost (usage.providerReportedCostUsd) and asserts they agree within $0.0001.
 * Keep prompts short and maxToolCalls low: agentic tool calls bill per call.
 *
 * Cases:
 *   1. plain complete()
 *   2. x_search with a handle allowlist and date range
 *   3. web_search
 *   4. code_interpreter with structured output
 *   5. mcp against https://mcp.deepwiki.com/mcp
 *   6. image_generation (prints the derived per-image fee; asserted once the fee is in the table)
 *   7. stream() with citations
 *   8. withTools(): a caller function tool mixed with a server tool
 */

import { z } from 'zod';
import type { LlmCost, LlmStreamChunk, LlmUsage } from '../packages/llm-client/src/index.js';
import { createClientFromEnv } from '../packages/llm-client/src/index.js';
import { computeCost } from '../packages/llm-pricing/src/index.js';

/** Maximum tolerated gap (USD) between computed and provider-reported cost. */
const COST_TOLERANCE_USD = 0.0001;
const MODEL = 'grok-4.7';

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

/**
 * Print usage + both costs and assert agreement. `assertCost: false` prints only (used for the
 * image case before its fee is in the table). Returns whether the case's cost check passed.
 */
function reportCost(
  label: string,
  r: { usage: LlmUsage; cost?: LlmCost | undefined },
  assertCost = true
): boolean {
  const computed = r.cost?.total;
  const reported = r.usage.providerReportedCostUsd;
  console.log(`  usage: ${JSON.stringify(r.usage)}`);
  console.log(
    `  cost.computed:  ${computed?.toFixed(6) ?? 'n/a'} (partial: ${r.cost?.isPartial}, serverTools: ${r.cost?.serverTools?.toFixed(6)})`
  );
  console.log(`  cost.reported:  ${reported?.toFixed(6) ?? 'n/a'}`);
  if (reported !== undefined) totalReportedUsd += reported;
  if (computed === undefined || reported === undefined) {
    console.log(`  FAIL (${label}): missing cost on one side`);
    return false;
  }
  const delta = Math.abs(computed - reported);
  if (!assertCost) {
    console.log(`  cost.delta:     ${delta.toFixed(6)} (not asserted)`);
    return true;
  }
  const ok = delta <= COST_TOLERANCE_USD;
  console.log(`  cost.delta:     ${delta.toFixed(6)} -> ${ok ? 'PASS' : 'FAIL'}`);
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
  const client = await createClientFromEnv('xai', MODEL, {
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
      [{ role: 'user', content: 'In one sentence, what did @SpaceXAI most recently post about?' }],
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
    console.log(`  content: ${r.content.trim().slice(0, 200)}`);
    console.log(`  citations: ${(r.citations ?? []).map((c) => c.url).join(', ')}`);
    console.log(`  serverToolCalls: ${r.serverToolCalls?.map((c) => c.name ?? c.type).join(', ')}`);
    const costOk = reportCost('x_search', r);
    const used = r.usage.serverToolUsage?.xSearchCalls ?? 0;
    if (used < 1) console.log('  FAIL: xSearchCalls usage not reported');
    return costOk && used >= 1;
  });

  await runCase(3, 'web_search', async () => {
    const r = await client.complete(
      [{ role: 'user', content: 'In one sentence: what is the current Node.js LTS version?' }],
      {
        reasoningEffort: 'low',
        providerOptions: { serverTools: [{ type: 'webSearch' }], maxToolCalls: 2 },
      }
    );
    console.log(`  content: ${r.content.trim().slice(0, 200)}`);
    console.log(`  citations: ${r.citations?.length ?? 0}`);
    const costOk = reportCost('web_search', r);
    return costOk && (r.usage.serverToolUsage?.webSearchCalls ?? 0) >= 1;
  });

  await runCase(4, 'code_interpreter with structured output', async () => {
    const r = await client.structured(
      [
        {
          role: 'user',
          content:
            'Use the code interpreter to compute the 30th Fibonacci number (F1=F2=1). Return it as n.',
        },
      ],
      z.object({ n: z.number().int() }),
      {
        reasoningEffort: 'low',
        providerOptions: { serverTools: [{ type: 'codeInterpreter' }], maxToolCalls: 2 },
      }
    );
    console.log(`  data: ${JSON.stringify(r.data)}`);
    console.log(`  serverToolCalls: ${r.serverToolCalls?.map((c) => c.type).join(', ')}`);
    const costOk = reportCost('code_interpreter', r);
    return costOk && r.data.n === 832040 && (r.usage.serverToolUsage?.codeInterpreterCalls ?? 0) >= 1;
  });

  await runCase(5, 'mcp (deepwiki)', async () => {
    const r = await client.complete(
      [
        {
          role: 'user',
          content:
            'Use the deepwiki MCP server tool read_wiki_structure on repository facebook/react and list the first 3 topic titles. Do not answer from memory.',
        },
      ],
      {
        reasoningEffort: 'low',
        providerOptions: {
          serverTools: [
            {
              type: 'mcp',
              serverUrl: 'https://mcp.deepwiki.com/mcp',
              serverLabel: 'deepwiki',
            },
          ],
          maxToolCalls: 2,
        },
      }
    );
    console.log(`  content: ${r.content.trim().slice(0, 200)}`);
    console.log(`  serverToolCalls: ${JSON.stringify(r.serverToolCalls)}`);
    const costOk = reportCost('mcp', r);
    return costOk && (r.usage.serverToolUsage?.mcpCalls ?? 0) >= 1;
  });

  await runCase(6, 'image_generation (derive per-image fee)', async () => {
    const r = await client.complete(
      [{ role: 'user', content: 'Generate one tiny image of a red circle on white.' }],
      {
        reasoningEffort: 'low',
        providerOptions: { serverTools: [{ type: 'imageGeneration' }], maxToolCalls: 1 },
      }
    );
    const img = r.images?.[0];
    console.log(`  images: ${r.images?.length ?? 0}, first base64 chars: ${img?.data.length ?? 0}`);
    const calls = r.usage.serverToolUsage?.imageGenerationCalls ?? 0;
    const reported = r.usage.providerReportedCostUsd ?? 0;
    // Token-only computed cost: image calls with no fee entry leave cost.total as the token floor.
    const tokenCost = r.cost?.total ?? 0;
    const hasFee = !(r.cost?.isPartial ?? true);
    if (calls > 0 && !hasFee) {
      const fee = (reported - tokenCost) / calls;
      console.log(
        `  DERIVED image fee: (reported ${reported.toFixed(6)} - token cost ${tokenCost.toFixed(6)}) / ${calls} call(s) = $${fee.toFixed(6)} per image`
      );
    }
    // Asserted only once imageGenerationCalls is in the table (then isPartial is false).
    const costOk = reportCost('image_generation', r, hasFee);
    return costOk && (img?.data.length ?? 0) > 0 && calls >= 1;
  });

  await runCase(7, 'stream() with citations', async () => {
    let tokens = 0;
    let finalChunk: LlmStreamChunk | undefined;
    for await (const chunk of client.stream(
      [{ role: 'user', content: 'In one sentence: what is the latest stable TypeScript release?' }],
      {
        reasoningEffort: 'low',
        providerOptions: { serverTools: [{ type: 'webSearch' }], maxToolCalls: 2 },
      }
    )) {
      if (chunk.token.length > 0) tokens += 1;
      if (chunk.usage !== undefined) finalChunk = chunk;
    }
    console.log(`  token chunks: ${tokens}`);
    console.log(`  citations: ${finalChunk?.citations?.length ?? 0}`);
    if (finalChunk?.usage === undefined) {
      console.log('  FAIL: no terminal chunk with usage');
      return false;
    }
    // Streams are not cost-wrapped by the client; compute with llm-pricing directly.
    const cost = computeCost({ usage: finalChunk.usage, provider: 'xai', model: MODEL });
    const costOk = reportCost('stream', { usage: finalChunk.usage, cost });
    return costOk && tokens > 0 && (finalChunk.citations?.length ?? 0) > 0;
  });

  await runCase(8, 'withTools(): function tool + server tool', async () => {
    const r = await client.withTools(
      [
        {
          role: 'user',
          content:
            'Call the get_weather function for Singapore. Do not answer without calling it.',
        },
      ],
      [
        {
          name: 'get_weather',
          description: 'Get the weather for a city',
          inputSchema: { kind: 'zod', schema: z.object({ city: z.string() }) },
        },
      ],
      {
        reasoningEffort: 'low',
        providerOptions: { serverTools: [{ type: 'webSearch' }], maxToolCalls: 2 },
      }
    );
    console.log(`  toolCalls: ${JSON.stringify(r.toolCalls.map((c) => [c.toolName, c.arguments]))}`);
    console.log(`  serverToolCalls: ${r.serverToolCalls?.length ?? 0}  stopReason: ${r.stopReason}`);
    const costOk = reportCost('withTools', r);
    return costOk && r.toolCalls.some((c) => c.toolName === 'get_weather');
  });

  console.log(`\nTotal provider-reported spend this run: $${totalReportedUsd.toFixed(4)}`);
  console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
  if (failures > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
