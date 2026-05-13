/**
 * pricing:verify — diagnostic script for @diabolicallabs/llm-pricing.
 *
 * Reads the current DEFAULT_PRICING_TABLE and queries Perplexity sonar
 * once per provider to detect pricing drift. Prints a diff table to stdout.
 * Exits non-zero if any model's detected price differs by more than --threshold
 * (default 10%).
 *
 * IMPORTANT: This script is a DIAGNOSTIC TOOL only. It never modifies the
 * pricing table. Detected drift triggers a human-verified research refresh.
 *
 * Requires: PERPLEXITY_API_KEY in environment.
 * Usage: pnpm pricing:verify [--threshold=<percent>]
 *        set -a; source .env; set +a && pnpm pricing:verify
 */

import { DEFAULT_PRICING_TABLE } from '../src/table.js';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const thresholdArg = process.argv.find((a) => a.startsWith('--threshold='));
const THRESHOLD_PERCENT = thresholdArg ? parseFloat(thresholdArg.split('=')[1] ?? '10') : 10;

// ---------------------------------------------------------------------------
// Perplexity API client (minimal — no full SDK dependency)
// ---------------------------------------------------------------------------

const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

if (!PERPLEXITY_API_KEY) {
  console.error('[pricing:verify] ERROR: PERPLEXITY_API_KEY is not set in environment.');
  console.error('  Set it before running: set -a; source .env; set +a && pnpm pricing:verify');
  process.exit(1);
}

interface PerplexityMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface PerplexityChoice {
  message: { content: string };
}

interface PerplexityResponse {
  choices: PerplexityChoice[];
}

async function queryPerplexity(prompt: string): Promise<string> {
  const messages: PerplexityMessage[] = [
    {
      role: 'system',
      content:
        'You are a pricing lookup assistant. Return ONLY valid JSON — no prose, no markdown fences. ' +
        'If you cannot find a reliable current price for a model, set status to "unverifiable". ' +
        'Never guess prices.',
    },
    { role: 'user', content: prompt },
  ];

  const response = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sonar',
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as PerplexityResponse;
  return data.choices[0]?.message.content ?? '';
}

// ---------------------------------------------------------------------------
// Pricing query helpers
// ---------------------------------------------------------------------------

interface ModelEntry {
  provider: string;
  model: string;
  tableInputPer1M: number;
  tableOutputPer1M: number;
}

/** Collect all primary models from the table (skip deprecated aliases). */
function collectModels(): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const [provider, models] of Object.entries(DEFAULT_PRICING_TABLE)) {
    if (provider === 'versionedAt') continue;
    for (const [model, pricing] of Object.entries(
      models as Record<string, { deprecatedAliasFor?: string; inputPer1M: number; outputPer1M: number }>
    )) {
      // Skip deprecated aliases — they share rates with the canonical model
      if (pricing.deprecatedAliasFor !== undefined) continue;
      entries.push({
        provider,
        model,
        tableInputPer1M: pricing.inputPer1M,
        tableOutputPer1M: pricing.outputPer1M,
      });
    }
  }
  return entries;
}

interface DriftRecord {
  provider: string;
  model: string;
  tableInputPer1M: number;
  tableOutputPer1M: number;
  detectedInputPer1M: number | 'unverifiable';
  detectedOutputPer1M: number | 'unverifiable';
  inputDeltaPercent: number | 'unverifiable';
  outputDeltaPercent: number | 'unverifiable';
  exceedsThreshold: boolean;
}

interface PerplexityPriceResult {
  model: string;
  inputPer1M?: number;
  outputPer1M?: number;
  status?: 'unverifiable';
}

/** Query Perplexity for current prices of a batch of models from one provider. */
async function queryProviderPrices(
  provider: string,
  models: ModelEntry[]
): Promise<DriftRecord[]> {
  const modelList = models.map((m) => m.model).join(', ');
  const today = new Date().toISOString().split('T')[0];

  const prompt =
    `Today is ${today}. What is the current API pricing (USD per million tokens, ` +
    `input and output) for these ${provider} models: ${modelList}? ` +
    `Return a JSON array with one object per model: ` +
    `{ "model": "<id>", "inputPer1M": <number>, "outputPer1M": <number> }. ` +
    `If you cannot find a reliable current price for any model, return ` +
    `{ "model": "<id>", "status": "unverifiable" } for that model.`;

  let rawJson: string;
  try {
    rawJson = await queryPerplexity(prompt);
  } catch (err) {
    console.warn(`  [warning] Perplexity query failed for provider '${provider}': ${String(err)}`);
    return models.map((m) => ({
      provider,
      model: m.model,
      tableInputPer1M: m.tableInputPer1M,
      tableOutputPer1M: m.tableOutputPer1M,
      detectedInputPer1M: 'unverifiable',
      detectedOutputPer1M: 'unverifiable',
      inputDeltaPercent: 'unverifiable',
      outputDeltaPercent: 'unverifiable',
      exceedsThreshold: false,
    }));
  }

  // Strip markdown fences if Perplexity included them
  const cleaned = rawJson
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let results: PerplexityPriceResult[];
  try {
    const parsed: unknown = JSON.parse(cleaned);
    results = Array.isArray(parsed) ? (parsed as PerplexityPriceResult[]) : [];
  } catch {
    console.warn(`  [warning] Could not parse Perplexity response for '${provider}'. Raw: ${cleaned.slice(0, 200)}`);
    results = [];
  }

  return models.map((m) => {
    const detected = results.find((r) => r.model === m.model);

    if (detected === undefined || detected.status === 'unverifiable') {
      return {
        provider,
        model: m.model,
        tableInputPer1M: m.tableInputPer1M,
        tableOutputPer1M: m.tableOutputPer1M,
        detectedInputPer1M: 'unverifiable' as const,
        detectedOutputPer1M: 'unverifiable' as const,
        inputDeltaPercent: 'unverifiable' as const,
        outputDeltaPercent: 'unverifiable' as const,
        exceedsThreshold: false,
      };
    }

    const detectedInput = detected.inputPer1M ?? m.tableInputPer1M;
    const detectedOutput = detected.outputPer1M ?? m.tableOutputPer1M;

    const inputDelta =
      m.tableInputPer1M !== 0
        ? ((detectedInput - m.tableInputPer1M) / m.tableInputPer1M) * 100
        : 0;
    const outputDelta =
      m.tableOutputPer1M !== 0
        ? ((detectedOutput - m.tableOutputPer1M) / m.tableOutputPer1M) * 100
        : 0;

    const exceedsThreshold =
      Math.abs(inputDelta) > THRESHOLD_PERCENT || Math.abs(outputDelta) > THRESHOLD_PERCENT;

    return {
      provider,
      model: m.model,
      tableInputPer1M: m.tableInputPer1M,
      tableOutputPer1M: m.tableOutputPer1M,
      detectedInputPer1M: detectedInput,
      detectedOutputPer1M: detectedOutput,
      inputDeltaPercent: Math.round(inputDelta * 10) / 10,
      outputDeltaPercent: Math.round(outputDelta * 10) / 10,
      exceedsThreshold,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log('');
console.log('@diabolicallabs/llm-pricing — pricing:verify');
console.log('='.repeat(60));
console.log(`Table versionedAt: ${DEFAULT_PRICING_TABLE.versionedAt}`);
console.log(`Drift threshold:   ${THRESHOLD_PERCENT}%`);
console.log(`Perplexity model:  sonar`);
console.log('');

const allModels = collectModels();
const providers = [...new Set(allModels.map((m) => m.provider))];

const allDrift: DriftRecord[] = [];

for (const provider of providers) {
  const providerModels = allModels.filter((m) => m.provider === provider);
  console.log(`Checking ${provider} (${providerModels.length} models)...`);
  const drift = await queryProviderPrices(provider, providerModels);
  allDrift.push(...drift);
}

console.log('');
console.log('Results');
console.log('='.repeat(100));
console.log(
  `${'Provider'.padEnd(12)} ${'Model'.padEnd(32)} ${'TableIn'.padStart(10)} ${'DetectedIn'.padStart(12)} ${'ΔIn%'.padStart(8)} ${'TableOut'.padStart(10)} ${'DetectedOut'.padStart(12)} ${'ΔOut%'.padStart(8)} ${'Flag'.padStart(6)}`
);
console.log('-'.repeat(100));

let driftCount = 0;

for (const row of allDrift) {
  const flag = row.exceedsThreshold ? '*** DRIFT' : '';
  if (row.exceedsThreshold) driftCount++;

  const detIn =
    row.detectedInputPer1M === 'unverifiable' ? '?' : `$${row.detectedInputPer1M.toFixed(4)}`;
  const detOut =
    row.detectedOutputPer1M === 'unverifiable' ? '?' : `$${row.detectedOutputPer1M.toFixed(4)}`;
  const dIn =
    row.inputDeltaPercent === 'unverifiable' ? '?' : `${row.inputDeltaPercent > 0 ? '+' : ''}${row.inputDeltaPercent}%`;
  const dOut =
    row.outputDeltaPercent === 'unverifiable' ? '?' : `${row.outputDeltaPercent > 0 ? '+' : ''}${row.outputDeltaPercent}%`;

  console.log(
    `${row.provider.padEnd(12)} ${row.model.padEnd(32)} ${'$' + row.tableInputPer1M.toFixed(4).padStart(9)} ${detIn.padStart(12)} ${dIn.padStart(8)} ${'$' + row.tableOutputPer1M.toFixed(4).padStart(9)} ${detOut.padStart(12)} ${dOut.padStart(8)} ${flag.padStart(6)}`
  );
}

console.log('');

if (driftCount > 0) {
  console.error(
    `[pricing:verify] DRIFT DETECTED: ${driftCount} model(s) exceeded the ${THRESHOLD_PERCENT}% threshold.`
  );
  console.error('  Action: run the full research refresh (Tom) and open a pricing PR (Sable).');
  console.error('  This tool never auto-updates the table — human verification required.');
  process.exit(1);
} else {
  console.log(
    `[pricing:verify] OK — no drift detected above ${THRESHOLD_PERCENT}% threshold. Table is current.`
  );
  process.exit(0);
}
