/**
 * @diabolicallabs/llm-pricing
 *
 * Pricing table + cost computation for @diabolicallabs/llm-client.
 *
 * Public surface:
 *   computeCost(input) — compute USD cost from LlmUsage + provider/model
 *   DEFAULT_PRICING_TABLE — curated pricing table verified 2026-05-13
 *   fetchRemoteTable(url, options?) — opt-in remote pricing source (v0.2.0+)
 *   clearPricingCache(url?) — clear in-memory cache (testing utility)
 *   Types: LlmCost, ModelPricing, PricingTable, ComputeCostInput, Provider,
 *          LlmUsage, FetchRemoteTableOptions, FetchRemoteTableResult
 */

export { computeCost } from './compute.js';
export {
  clearPricingCache,
  type FetchRemoteTableOptions,
  type FetchRemoteTableResult,
  fetchRemoteTable,
} from './fetch-remote.js';
export { DEFAULT_PRICING_TABLE } from './table.js';
export type {
  ComputeCostInput,
  LlmCost,
  LlmUsage,
  ModelPricing,
  PricingTable,
  Provider,
} from './types.js';
