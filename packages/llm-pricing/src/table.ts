/**
 * Default pricing table for @diabolicallabs/llm-pricing.
 *
 * Data sourced from Tom's Wave 2a pricing snapshot (2026-05-13).
 * Confidence: High for Anthropic, Gemini, DeepSeek, Perplexity (first-party docs).
 *             Medium for OpenAI (primary pricing page 403'd; cross-referenced from
 *             pricepertoken.com + devtk.ai + OpenRouter — all consistent).
 *
 * All prices are USD per 1 million tokens.
 *
 * Maintenance: monthly Perplexity drift check (see routines/llm-pricing-drift-check.md)
 * + quarterly baseline refresh. See brief-pricing-maintenance.md for full plan.
 *
 * IMPORTANT: deepseek-v4-pro has a 75% promotional discount active through 2026-05-31.
 * Post-discount rates will be approx 4× current. See verifiedAt + sourceUrl.
 */

import type { PricingTable } from './types.js';

const ANTHROPIC_SOURCE = 'https://platform.claude.com/docs/en/docs/about-claude/pricing';
const OPENAI_SOURCE =
  'https://pricepertoken.com/pricing-page/provider/openai (primary 403 — cross-referenced)';
const GEMINI_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const DEEPSEEK_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';
const PERPLEXITY_SOURCE = 'https://docs.perplexity.ai/guides/pricing';

const VERIFIED = '2026-05-13';

export const DEFAULT_PRICING_TABLE: PricingTable = {
  /**
   * ISO 8601 date the table was last verified against official pricing sources.
   * Consumers can compare against Date.now() to detect staleness.
   *
   * @example
   * const ageInDays = (Date.now() - new Date(DEFAULT_PRICING_TABLE.versionedAt).getTime()) / 86_400_000;
   * if (ageInDays > 90) console.warn('llm-pricing default table may be stale — check for a newer version');
   */
  versionedAt: '2026-05-13',

  // ---------------------------------------------------------------------------
  // Anthropic
  // Cache mechanics: two write tiers (5-min ephemeral at 1.25× base, 1-hr at 2×).
  // cacheWritePer1M = 5-min (ephemeral) rate. cacheWrite1hPer1M = 1-hr rate.
  // The toolkit's providerOptions.promptCache: 'ephemeral' wires the 5-min tier only.
  // ---------------------------------------------------------------------------
  anthropic: {
    'claude-opus-4-7': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25, // 5-min ephemeral: 1.25× base input
      cacheWrite1hPer1M: 10.0, // 1-hr: 2× base input
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
    'claude-sonnet-4-6': {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cacheReadPer1M: 0.3,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
    // API ID: claude-haiku-4-5-20251001; alias: claude-haiku-4-5
    'claude-haiku-4-5': {
      inputPer1M: 1.0,
      outputPer1M: 5.0,
      cacheReadPer1M: 0.1,
      cacheWritePer1M: 1.25,
      cacheWrite1hPer1M: 2.0,
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
    'claude-haiku-4-5-20251001': {
      inputPer1M: 1.0,
      outputPer1M: 5.0,
      cacheReadPer1M: 0.1,
      cacheWritePer1M: 1.25,
      cacheWrite1hPer1M: 2.0,
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
    // Legacy — still callable; included for consumer price-check coverage
    'claude-opus-4-6': {
      inputPer1M: 5.0,
      outputPer1M: 25.0,
      cacheReadPer1M: 0.5,
      cacheWritePer1M: 6.25,
      cacheWrite1hPer1M: 10.0,
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
    'claude-sonnet-4-5-20250929': {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cacheReadPer1M: 0.3,
      cacheWritePer1M: 3.75,
      cacheWrite1hPer1M: 6.0,
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
    'claude-haiku-3-5': {
      inputPer1M: 0.8,
      outputPer1M: 4.0,
      cacheReadPer1M: 0.08,
      cacheWritePer1M: 1.0,
      cacheWrite1hPer1M: 1.6,
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
    'claude-haiku-3': {
      inputPer1M: 0.25,
      outputPer1M: 1.25,
      cacheReadPer1M: 0.03,
      cacheWritePer1M: 0.3125,
      cacheWrite1hPer1M: 0.5,
      verifiedAt: VERIFIED,
      sourceUrl: ANTHROPIC_SOURCE,
    },
  },

  // ---------------------------------------------------------------------------
  // OpenAI
  // Confidence: Medium (primary page 403'd — cross-referenced from third parties).
  // o-series: hasInvisibleReasoningTokens = true — outputTokens includes reasoning
  // tokens not returned in response content. Cost is a floor.
  // ---------------------------------------------------------------------------
  openai: {
    'gpt-5.5': {
      inputPer1M: 5.0,
      outputPer1M: 30.0,
      cacheReadPer1M: 0.5, // 90% cache discount
      verifiedAt: VERIFIED,
      sourceUrl: OPENAI_SOURCE,
    },
    'gpt-5.5-pro': {
      inputPer1M: 30.0,
      outputPer1M: 180.0,
      // No cached-input rate documented for gpt-5.5-pro — omitted
      verifiedAt: VERIFIED,
      sourceUrl: OPENAI_SOURCE,
    },
    'gpt-5.4': {
      inputPer1M: 2.5,
      outputPer1M: 15.0,
      cacheReadPer1M: 0.25,
      verifiedAt: VERIFIED,
      sourceUrl: OPENAI_SOURCE,
    },
    'gpt-5.4-mini': {
      inputPer1M: 0.75,
      outputPer1M: 4.5,
      cacheReadPer1M: 0.075,
      verifiedAt: VERIFIED,
      sourceUrl: OPENAI_SOURCE,
    },
    'gpt-4.1': {
      inputPer1M: 2.0,
      outputPer1M: 8.0,
      cacheReadPer1M: 0.5,
      verifiedAt: VERIFIED,
      sourceUrl: OPENAI_SOURCE,
    },
    // o-series: output billing includes invisible reasoning tokens
    o3: {
      inputPer1M: 2.0,
      outputPer1M: 8.0,
      cacheReadPer1M: 0.5,
      hasInvisibleReasoningTokens: true,
      verifiedAt: VERIFIED,
      sourceUrl: OPENAI_SOURCE,
    },
    'o4-mini': {
      inputPer1M: 1.1,
      outputPer1M: 4.4,
      cacheReadPer1M: 0.275,
      hasInvisibleReasoningTokens: true,
      verifiedAt: VERIFIED,
      sourceUrl: OPENAI_SOURCE,
    },
  },

  // ---------------------------------------------------------------------------
  // Gemini
  // Long-context tiering: gemini-3.1-pro-preview and gemini-2.5-pro have
  // short-context (≤200k) vs long-context (>200k) price tiers.
  // computeCost() uses inputTokens to decide which tier applies.
  // ---------------------------------------------------------------------------
  gemini: {
    'gemini-3.1-pro-preview': {
      inputPer1M: 2.0, // ≤200k tokens
      outputPer1M: 12.0,
      cacheReadPer1M: 0.2,
      longContextThreshold: 200_000,
      longContextInputPer1M: 4.0, // >200k tokens
      longContextOutputPer1M: 18.0,
      longContextCacheReadPer1M: 0.4,
      verifiedAt: VERIFIED,
      sourceUrl: GEMINI_SOURCE,
    },
    'gemini-2.5-pro': {
      inputPer1M: 1.25,
      outputPer1M: 10.0,
      cacheReadPer1M: 0.125,
      longContextThreshold: 200_000,
      longContextInputPer1M: 2.5,
      longContextOutputPer1M: 15.0,
      longContextCacheReadPer1M: 0.25,
      verifiedAt: VERIFIED,
      sourceUrl: GEMINI_SOURCE,
    },
    // GEOAudit default — flat rate (no tiered pricing)
    'gemini-2.5-flash': {
      inputPer1M: 0.3,
      outputPer1M: 2.5,
      cacheReadPer1M: 0.03,
      verifiedAt: VERIFIED,
      sourceUrl: GEMINI_SOURCE,
    },
    'gemini-3.1-flash-lite': {
      inputPer1M: 0.25,
      outputPer1M: 1.5,
      cacheReadPer1M: 0.025,
      verifiedAt: VERIFIED,
      sourceUrl: GEMINI_SOURCE,
    },
  },

  // ---------------------------------------------------------------------------
  // DeepSeek
  // Canonical IDs: deepseek-v4-flash, deepseek-v4-pro.
  // Deprecated aliases (deepseek-chat, deepseek-reasoner) are included with
  // deprecatedAliasFor so computeCost() can warn consumers at runtime.
  //
  // IMPORTANT: deepseek-v4-pro promotional 75% discount expires 2026-05-31.
  // Post-discount rates: input ~$1.74, cache hit ~$0.0145, output ~$3.48 per 1M.
  //
  // DeepSeek "cache hit" is server-side KV cache — fires automatically on repeated
  // prefixes, no opt-in required. Different from Anthropic's explicit prompt caching.
  // ---------------------------------------------------------------------------
  deepseek: {
    'deepseek-v4-flash': {
      inputPer1M: 0.14, // cache miss rate
      outputPer1M: 0.28,
      cacheReadPer1M: 0.0028, // server-side KV cache hit: 10× discount vs launch price
      verifiedAt: VERIFIED,
      sourceUrl: DEEPSEEK_SOURCE,
    },
    'deepseek-v4-pro': {
      inputPer1M: 0.435, // promotional — expires 2026-05-31. Post-discount: ~$1.74
      outputPer1M: 0.87, // promotional — post-discount: ~$3.48
      cacheReadPer1M: 0.003625, // promotional — post-discount: ~$0.0145
      verifiedAt: VERIFIED,
      sourceUrl: DEEPSEEK_SOURCE,
    },
    // Deprecated aliases — included for consumer compatibility with deprecation warning
    'deepseek-chat': {
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      cacheReadPer1M: 0.0028,
      deprecatedAliasFor: 'deepseek-v4-flash',
      verifiedAt: VERIFIED,
      sourceUrl: DEEPSEEK_SOURCE,
    },
    'deepseek-reasoner': {
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      cacheReadPer1M: 0.0028,
      deprecatedAliasFor: 'deepseek-v4-flash',
      verifiedAt: VERIFIED,
      sourceUrl: DEEPSEEK_SOURCE,
    },
  },

  // ---------------------------------------------------------------------------
  // Perplexity
  // Token cost only — per-request fees (based on search context size) and
  // sonar-deep-research's citation/search-query fees are NOT computable from
  // token usage alone. computeCost() returns a floor and marks isPartial = true
  // for sonar-deep-research.
  // ---------------------------------------------------------------------------
  perplexity: {
    sonar: {
      inputPer1M: 1.0,
      outputPer1M: 1.0,
      verifiedAt: VERIFIED,
      sourceUrl: PERPLEXITY_SOURCE,
    },
    'sonar-pro': {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      verifiedAt: VERIFIED,
      sourceUrl: PERPLEXITY_SOURCE,
    },
    'sonar-reasoning-pro': {
      inputPer1M: 2.0,
      outputPer1M: 8.0,
      verifiedAt: VERIFIED,
      sourceUrl: PERPLEXITY_SOURCE,
    },
    // partialCostCoverage: true — citation tokens ($2/1M), search queries ($5/1K),
    // and reasoning tokens ($3/1M) are not in LlmUsage and cannot be computed here.
    'sonar-deep-research': {
      inputPer1M: 2.0,
      outputPer1M: 8.0,
      partialCostCoverage: true,
      verifiedAt: VERIFIED,
      sourceUrl: PERPLEXITY_SOURCE,
    },
  },
};
