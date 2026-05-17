/**
 * computeCost() — derive USD cost from LLM token usage + pricing table.
 *
 * Design decisions:
 * - Long-context branching for Gemini: uses inputTokens to pick the tier.
 * - Anthropic cache math: cacheCreationTokens billed at cacheWritePer1M (5-min ephemeral).
 *   1-hr tier (cacheWrite1hPer1M) is reserved for a future LlmUsage.cacheWrite1hTokens field.
 * - Reasoning models (o-series): hasInvisibleReasoningTokens sets isPartial = true on result.
 * - Perplexity sonar-deep-research: partialCostCoverage sets isPartial = true.
 * - Deprecated aliases: emits console.warn once per alias per process lifetime.
 * - Unknown model: returns zero cost with isPartial = true and logs a warning once per model.
 * - Date-strip fallback: if exact lookup fails, strips trailing date suffixes
 *   (-YYYY-MM-DD, -YYYYMMDD, -YYYY-MM) and retries. Emits a warn once per dated model ID.
 *   Fixes cost-tracking leak where providers return dated model IDs (e.g. gpt-5.4-mini-2026-03-17)
 *   that don't match alias-only entries in the pricing table.
 */

import { DEFAULT_PRICING_TABLE } from './table.js';
import type { ComputeCostInput, LlmCost, ModelPricing, PricingTable, Provider } from './types.js';

/** Divide token count by 1M to get the billing unit. */
function perMillion(tokens: number): number {
  return tokens / 1_000_000;
}

// ---------------------------------------------------------------------------
// Warn-once Sets — keyed by `${provider}::${model}` so the same warn fires
// once per unique (provider, model) pair per process lifetime. High-volume
// callers (GEOAudit firing hundreds of requests/hour) would otherwise spam logs.
// Three separate Sets so warn messages can identify the cause by the set used.
// ---------------------------------------------------------------------------

/** Tracks models that have already emitted a deprecation warning. */
const deprecationWarnedSet = new Set<string>();

/** Tracks (provider, model) pairs that have already emitted an unknown-model warning. */
const unknownModelWarnedSet = new Set<string>();

/** Tracks dated model IDs that have already emitted a date-strip fallback warning. */
const dateStripWarnedSet = new Set<string>();

/**
 * Clear all warn-once Sets. Exported for test isolation only — do not call in production code.
 * Module-level Sets persist across test cases in the same process; clearing them in beforeEach
 * ensures each test can assert on first-warn behavior independently.
 */
export function _resetWarnSetsForTesting(): void {
  deprecationWarnedSet.clear();
  unknownModelWarnedSet.clear();
  dateStripWarnedSet.clear();
}

/**
 * Strip a trailing date suffix from a model string, returning the base alias.
 * Returns null if no recognizable date suffix is found.
 *
 * Patterns (checked longest-first to avoid greedy partial matches):
 *   -YYYY-MM-DD  e.g. gpt-5.4-mini-2026-03-17, claude-opus-4-7-20251101 (wrong fmt — see -YYYYMMDD)
 *   -YYYYMMDD    e.g. claude-haiku-4-5-20251001
 *   -YYYY-MM     e.g. gpt-4o-2024-08 (rare)
 */
function stripDateSuffix(model: string): string | null {
  // Use positional capture group [1] to avoid noPropertyAccessFromIndexSignature
  // conflict with named groups. Patterns checked longest-first.
  //
  // -YYYY-MM-DD (e.g. gpt-5.4-mini-2026-03-17)
  const ymdBase = /^(.+)-\d{4}-\d{2}-\d{2}$/.exec(model)?.[1];
  if (ymdBase !== undefined) return ymdBase;
  // -YYYYMMDD (e.g. claude-haiku-4-5-20251001)
  const ymdCompactBase = /^(.+)-\d{8}$/.exec(model)?.[1];
  if (ymdCompactBase !== undefined) return ymdCompactBase;
  // -YYYY-MM (e.g. gpt-4o-2024-08)
  const ymBase = /^(.+)-\d{4}-\d{2}$/.exec(model)?.[1];
  if (ymBase !== undefined) return ymBase;
  return null;
}

/**
 * Resolve the ModelPricing record for a given provider + model.
 *
 * Lookup order:
 * 1. Exact match against provider table.
 * 2. Date-strip fallback: strips trailing date suffix from model ID and retries.
 *    This handles providers that return dated model IDs (e.g. gpt-5.4-mini-2026-03-17)
 *    when the table only has the canonical alias (e.g. gpt-5.4-mini).
 *
 * Emits warn-once console.warn for:
 * - Deprecated alias hits (once per alias).
 * - Date-strip fallback hits (once per dated model ID).
 *
 * Returns null if neither lookup finds a match.
 */
function resolveModelPricing(
  table: PricingTable,
  provider: Provider,
  model: string
): ModelPricing | null {
  const providerTable = table[provider];
  if (providerTable === undefined) return null;

  // --- Exact match ---
  const record = providerTable[model];
  if (record !== undefined) {
    // Emit deprecation warning once per deprecated alias.
    if (record.deprecatedAliasFor !== undefined) {
      const warnKey = `${provider}::${model}`;
      if (!deprecationWarnedSet.has(warnKey)) {
        deprecationWarnedSet.add(warnKey);
        console.warn(
          `[llm-pricing] Model ID '${model}' is deprecated — use '${record.deprecatedAliasFor}' instead. ` +
            `The deprecated alias maps to the same pricing as ${record.deprecatedAliasFor}.`
        );
      }
    }
    return record;
  }

  // --- Date-strip fallback ---
  // Fires only when the exact lookup missed. Handles providers that echo back a
  // dated snapshot ID (e.g. gpt-5.4-mini-2026-03-17) while the table has the alias.
  const alias = stripDateSuffix(model);
  if (alias !== null) {
    const aliasRecord = providerTable[alias];
    if (aliasRecord !== undefined) {
      const warnKey = `${provider}::${model}`;
      if (!dateStripWarnedSet.has(warnKey)) {
        dateStripWarnedSet.add(warnKey);
        console.warn(
          `[llm-pricing] Matched via date-strip fallback: '${model}' → '${alias}'. ` +
            `Update the pricing table to add '${model}' as an explicit entry to silence this warning.`
        );
      }
      return aliasRecord;
    }
  }

  return null;
}

/**
 * Compute the USD cost for a single LLM call.
 *
 * @param input - Token usage, provider, model, and optional pricing override.
 * @returns LlmCost with per-component breakdown and isPartial flag.
 *
 * @example
 * const cost = computeCost({
 *   usage: response.usage,
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-6',
 * });
 * // cost.total — USD amount (isPartial: false for standard models)
 */
export function computeCost(input: ComputeCostInput): LlmCost {
  const table = input.pricingTable ?? DEFAULT_PRICING_TABLE;
  const { usage, provider, model } = input;

  const pricing = resolveModelPricing(table, provider, model);

  if (pricing === null) {
    // Warn once per unique (provider, model) pair — high-volume callers should not spam logs.
    const unknownKey = `${provider}::${model}`;
    if (!unknownModelWarnedSet.has(unknownKey)) {
      unknownModelWarnedSet.add(unknownKey);
      console.warn(
        `[llm-pricing] No pricing data for provider='${provider}' model='${model}'. ` +
          `Returning zero cost with isPartial=true. Update the pricing table or provide an override.`
      );
    }
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      currency: 'USD',
      isPartial: true,
    };
  }

  // Determine whether we are in the long-context tier (Gemini 3.1 Pro, 2.5 Pro).
  const isLongContext =
    pricing.longContextThreshold !== undefined &&
    pricing.longContextInputPer1M !== undefined &&
    usage.inputTokens > pricing.longContextThreshold;

  const effectiveInputPer1M = isLongContext
    ? (pricing.longContextInputPer1M ?? pricing.inputPer1M)
    : pricing.inputPer1M;

  const effectiveOutputPer1M = isLongContext
    ? (pricing.longContextOutputPer1M ?? pricing.outputPer1M)
    : pricing.outputPer1M;

  const effectiveCacheReadPer1M = isLongContext
    ? (pricing.longContextCacheReadPer1M ?? pricing.cacheReadPer1M)
    : pricing.cacheReadPer1M;

  // Compute each cost component.
  const inputCost = perMillion(usage.inputTokens) * effectiveInputPer1M;
  const outputCost = perMillion(usage.outputTokens) * effectiveOutputPer1M;

  // Cache read cost — Anthropic prompt cache hits, Gemini context cache reads.
  const cacheReadCost =
    usage.cacheReadTokens !== undefined && effectiveCacheReadPer1M !== undefined
      ? perMillion(usage.cacheReadTokens) * effectiveCacheReadPer1M
      : 0;

  // Cache write cost — Anthropic 5-min ephemeral writes (cacheCreationTokens).
  // We use cacheWritePer1M (5-min tier) since that is the only tier the toolkit
  // currently wires via providerOptions.promptCache: 'ephemeral'.
  const cacheWriteCost =
    usage.cacheCreationTokens !== undefined && pricing.cacheWritePer1M !== undefined
      ? perMillion(usage.cacheCreationTokens) * pricing.cacheWritePer1M
      : 0;

  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;

  // isPartial is true when cost components exist that we cannot compute:
  // - o-series reasoning tokens billed in output but not returned in response.
  // - sonar-deep-research citation/search/reasoning fees.
  const isPartial =
    (pricing.hasInvisibleReasoningTokens ?? false) || (pricing.partialCostCoverage ?? false);

  return {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total,
    currency: 'USD',
    isPartial,
  };
}
