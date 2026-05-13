/**
 * @diabolicallabs/llm-pricing
 *
 * Pricing table + cost computation for @diabolicallabs/llm-client.
 *
 * Public surface:
 *   computeCost(input) — compute USD cost from LlmUsage + provider/model
 *   DEFAULT_PRICING_TABLE — curated pricing table verified 2026-05-13
 *   Types: LlmCost, ModelPricing, PricingTable, ComputeCostInput, Provider, LlmUsage
 */

export { computeCost } from './compute.js';
export { DEFAULT_PRICING_TABLE } from './table.js';
export type {
  ComputeCostInput,
  LlmCost,
  LlmUsage,
  ModelPricing,
  PricingTable,
  Provider,
} from './types.js';
