/**
 * @diabolicallabs/llm-pricing
 *
 * Pricing table + cost computation for @diabolicallabs/llm-client.
 *
 * Public surface:
 *   computeCost(input) — compute USD cost from LlmUsage + provider/model
 *   DEFAULT_PRICING_TABLE — curated pricing table verified 2026-05-18
 *   fetchRemoteTable(url, options?) — opt-in remote pricing source (v0.2.0+)
 *   clearPricingCache(url?) — clear in-memory cache (testing utility)
 *   setPricingLogger(logger | null) — swap the diagnostic logger (v1.1.0+)
 *   Types: LlmCost, ModelPricing, PricingTable, ComputeCostInput, Provider,
 *          LlmUsage, FetchRemoteTableOptions, FetchRemoteTableResult, PricingLogger
 */

export { computeCost } from './compute.js';
export {
  clearPricingCache,
  type FetchRemoteTableOptions,
  type FetchRemoteTableResult,
  fetchRemoteTable,
} from './fetch-remote.js';
export { setPricingLogger } from './logger.js';
export { DEFAULT_PRICING_TABLE } from './table.js';
export type {
  ComputeCostInput,
  LlmCost,
  LlmUsage,
  ModelPricing,
  PricingLogger,
  PricingTable,
  Provider,
} from './types.js';
