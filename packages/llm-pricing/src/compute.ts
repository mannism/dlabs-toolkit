/**
 * computeCost() — derive USD cost from LLM token usage + pricing table.
 *
 * Design decisions:
 * - Long-context branching for Gemini: uses inputTokens to pick the tier.
 * - Anthropic cache math: cacheCreationTokens billed at cacheWritePer1M (5-min ephemeral).
 *   1-hr tier (cacheWrite1hPer1M) is reserved for a future LlmUsage.cacheWrite1hTokens field.
 * - Reasoning models (o-series): hasInvisibleReasoningTokens sets isPartial = true on result.
 * - Perplexity sonar-deep-research: partialCostCoverage sets isPartial = true.
 * - Deprecated aliases: emits console.warn once per alias at runtime.
 * - Unknown model: returns zero cost with isPartial = true and logs a warning.
 */

import { DEFAULT_PRICING_TABLE } from './table.js';
import type { ComputeCostInput, LlmCost, ModelPricing, PricingTable, Provider } from './types.js';

/** Divide token count by 1M to get the billing unit. */
function perMillion(tokens: number): number {
  return tokens / 1_000_000;
}

/**
 * Resolve the ModelPricing record for a given provider + model,
 * handling deprecated aliases and unknown models.
 *
 * Returns null if the model is not in the table.
 */
function resolveModelPricing(
  table: PricingTable,
  provider: Provider,
  model: string
): ModelPricing | null {
  const providerTable = table[provider];
  if (providerTable === undefined) return null;

  const record = providerTable[model];
  if (record === undefined) return null;

  // Emit deprecation warning if this is a known deprecated alias.
  // We warn on every call — consumers should update their model IDs.
  if (record.deprecatedAliasFor !== undefined) {
    console.warn(
      `[llm-pricing] Model ID '${model}' is deprecated — use '${record.deprecatedAliasFor}' instead. ` +
        `The deprecated alias maps to the same pricing as ${record.deprecatedAliasFor}.`
    );
  }

  return record;
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
    console.warn(
      `[llm-pricing] No pricing data for provider='${provider}' model='${model}'. ` +
        `Returning zero cost with isPartial=true. Update the pricing table or provide an override.`
    );
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
