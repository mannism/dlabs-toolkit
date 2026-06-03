/**
 * Default pricing table for @diabolicallabs/llm-pricing.
 *
 * AUTO-GENERATED — do not edit directly.
 * Source of truth: pricing/table.json
 * Regenerate: node pricing/sync-bundled.mjs
 *
 * Data sourced from Tom's Wave 2a pricing snapshot (2026-05-13).
 * Confidence: High for Anthropic, Gemini, DeepSeek, Perplexity (first-party docs).
 *             Medium for OpenAI (primary pricing page 403'd; cross-referenced from
 *             pricepertoken.com + devtk.ai + OpenRouter — all consistent).
 *
 * All prices are USD per 1 million tokens.
 *
 * Maintenance: edit pricing/table.json + run node pricing/sync-bundled.mjs.
 * See pricing/README.md for the full refresh workflow.
 *
 * IMPORTANT: deepseek-v4-pro has a 75% promotional discount active through 2026-05-31.
 * Post-discount rates will be approx 4x current. See verifiedAt + sourceUrl.
 */

import type { PricingTable } from './types.js';

export const DEFAULT_PRICING_TABLE: PricingTable = {
  versionedAt: '2026-06-04',

  anthropic: {
    'claude-haiku-3': {
      cacheReadPer1M: 0.03,
      cacheWrite1hPer1M: 0.5,
      cacheWritePer1M: 0.3125,
      inputPer1M: 0.25,
      outputPer1M: 1.25,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-haiku-3-5': {
      cacheReadPer1M: 0.08,
      cacheWrite1hPer1M: 1.6,
      cacheWritePer1M: 1,
      inputPer1M: 0.8,
      outputPer1M: 4,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-haiku-4-5': {
      cacheReadPer1M: 0.1,
      cacheWrite1hPer1M: 2,
      cacheWritePer1M: 1.25,
      inputPer1M: 1,
      outputPer1M: 5,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-haiku-4-5-20251001': {
      cacheReadPer1M: 0.1,
      cacheWrite1hPer1M: 2,
      cacheWritePer1M: 1.25,
      inputPer1M: 1,
      outputPer1M: 5,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-opus-4-5': {
      cacheReadPer1M: 0.5,
      cacheWrite1hPer1M: 10,
      cacheWritePer1M: 6.25,
      inputPer1M: 5,
      outputPer1M: 25,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-05-18',
    },
    'claude-opus-4-6': {
      cacheReadPer1M: 0.5,
      cacheWrite1hPer1M: 10,
      cacheWritePer1M: 6.25,
      inputPer1M: 5,
      outputPer1M: 25,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-opus-4-7': {
      cacheReadPer1M: 0.5,
      cacheWrite1hPer1M: 10,
      cacheWritePer1M: 6.25,
      inputPer1M: 5,
      outputPer1M: 25,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-opus-4-8': {
      cacheReadPer1M: 0.5,
      cacheWrite1hPer1M: 10,
      cacheWritePer1M: 6.25,
      inputPer1M: 5,
      outputPer1M: 25,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-sonnet-4-5': {
      cacheReadPer1M: 0.3,
      cacheWrite1hPer1M: 6,
      cacheWritePer1M: 3.75,
      inputPer1M: 3,
      outputPer1M: 15,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-05-18',
    },
    'claude-sonnet-4-5-20250929': {
      cacheReadPer1M: 0.3,
      cacheWrite1hPer1M: 6,
      cacheWritePer1M: 3.75,
      inputPer1M: 3,
      outputPer1M: 15,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
    'claude-sonnet-4-6': {
      cacheReadPer1M: 0.3,
      cacheWrite1hPer1M: 6,
      cacheWritePer1M: 3.75,
      inputPer1M: 3,
      outputPer1M: 15,
      sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      verifiedAt: '2026-06-04',
    },
  },

  openai: {
    'gpt-4.1': {
      cacheReadPer1M: 0.5,
      inputPer1M: 2,
      outputPer1M: 8,
      sourceUrl: 'https://pricepertoken.com/pricing-page/provider/openai',
      verifiedAt: '2026-05-13',
    },
    'gpt-4o': {
      cacheReadPer1M: 1.25,
      inputPer1M: 2.5,
      outputPer1M: 10,
      sourceUrl: 'https://pricepertoken.com/pricing-page/model/openai-gpt-4o',
      verifiedAt: '2026-05-18',
    },
    'gpt-4o-mini': {
      cacheReadPer1M: 0.075,
      inputPer1M: 0.15,
      outputPer1M: 0.6,
      sourceUrl: 'https://pricepertoken.com/pricing-page/model/openai-gpt-4o-mini',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.1': {
      cacheReadPer1M: 0.125,
      inputPer1M: 1.25,
      outputPer1M: 10,
      sourceUrl: 'https://portkey.ai/models/openai',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.1-codex-mini': {
      cacheReadPer1M: 0.025,
      inputPer1M: 0.25,
      outputPer1M: 2,
      sourceUrl: 'https://portkey.ai/models/openai',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.2': {
      cacheReadPer1M: 0.175,
      inputPer1M: 1.75,
      outputPer1M: 14,
      sourceUrl: 'https://portkey.ai/models/openai',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.2-codex': {
      cacheReadPer1M: 0.175,
      inputPer1M: 1.75,
      outputPer1M: 14,
      sourceUrl: 'https://portkey.ai/models/openai',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.2-pro': {
      cacheReadPer1M: 2.1,
      inputPer1M: 21,
      outputPer1M: 168,
      sourceUrl: 'https://portkey.ai/models/openai',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.3-chat-latest': {
      cacheReadPer1M: 0.175,
      inputPer1M: 1.75,
      outputPer1M: 14,
      sourceUrl: 'https://portkey.ai/models/openai',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.3-codex': {
      cacheReadPer1M: 0.175,
      inputPer1M: 1.75,
      outputPer1M: 14,
      sourceUrl: 'https://portkey.ai/models/openai',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.4': {
      cacheReadPer1M: 0.25,
      inputPer1M: 2.5,
      outputPer1M: 15,
      sourceUrl: 'https://pricepertoken.com/pricing-page/provider/openai',
      verifiedAt: '2026-05-13',
    },
    'gpt-5.4-mini': {
      cacheReadPer1M: 0.075,
      inputPer1M: 0.75,
      outputPer1M: 4.5,
      sourceUrl: 'https://pricepertoken.com/pricing-page/provider/openai',
      verifiedAt: '2026-05-13',
    },
    'gpt-5.4-nano': {
      cacheReadPer1M: 0.02,
      inputPer1M: 0.2,
      outputPer1M: 1.25,
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.4-pro': {
      inputPer1M: 30,
      outputPer1M: 180,
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'gpt-5.5': {
      cacheReadPer1M: 0.5,
      inputPer1M: 5,
      outputPer1M: 30,
      sourceUrl: 'https://pricepertoken.com/pricing-page/provider/openai',
      verifiedAt: '2026-05-13',
    },
    'gpt-5.5-pro': {
      inputPer1M: 30,
      outputPer1M: 180,
      sourceUrl: 'https://pricepertoken.com/pricing-page/provider/openai',
      verifiedAt: '2026-05-13',
    },
    o1: {
      cacheReadPer1M: 7.5,
      hasInvisibleReasoningTokens: true,
      inputPer1M: 15,
      outputPer1M: 60,
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'o1-mini': {
      cacheReadPer1M: 0.55,
      hasInvisibleReasoningTokens: true,
      inputPer1M: 0.55,
      outputPer1M: 2.2,
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    o3: {
      cacheReadPer1M: 0.5,
      hasInvisibleReasoningTokens: true,
      inputPer1M: 2,
      outputPer1M: 8,
      sourceUrl: 'https://pricepertoken.com/pricing-page/provider/openai',
      verifiedAt: '2026-05-13',
    },
    'o3-mini': {
      cacheReadPer1M: 0.55,
      hasInvisibleReasoningTokens: true,
      inputPer1M: 1.1,
      outputPer1M: 4.4,
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'o3-pro': {
      hasInvisibleReasoningTokens: true,
      inputPer1M: 20,
      outputPer1M: 80,
      sourceUrl: 'https://developers.openai.com/api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'o4-mini': {
      cacheReadPer1M: 0.275,
      hasInvisibleReasoningTokens: true,
      inputPer1M: 1.1,
      outputPer1M: 4.4,
      sourceUrl: 'https://pricepertoken.com/pricing-page/provider/openai',
      verifiedAt: '2026-05-13',
    },
  },

  gemini: {
    'gemini-2.5-flash': {
      cacheReadPer1M: 0.03,
      inputPer1M: 0.3,
      outputPer1M: 2.5,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-05-13',
    },
    'gemini-2.5-flash-lite': {
      cacheReadPer1M: 0.01,
      inputPer1M: 0.1,
      outputPer1M: 0.4,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'gemini-2.5-pro': {
      cacheReadPer1M: 0.125,
      inputPer1M: 1.25,
      longContextCacheReadPer1M: 0.25,
      longContextInputPer1M: 2.5,
      longContextOutputPer1M: 15,
      longContextThreshold: 200000,
      outputPer1M: 10,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-05-13',
    },
    'gemini-3-flash-preview': {
      cacheReadPer1M: 0.05,
      inputPer1M: 0.5,
      outputPer1M: 3,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'gemini-3.1-flash-lite': {
      cacheReadPer1M: 0.025,
      inputPer1M: 0.25,
      outputPer1M: 1.5,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-05-13',
    },
    'gemini-3.1-pro': {
      cacheReadPer1M: 0.2,
      inputPer1M: 2,
      longContextCacheReadPer1M: 0.4,
      longContextInputPer1M: 4,
      longContextOutputPer1M: 18,
      longContextThreshold: 200000,
      outputPer1M: 12,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-05-18',
    },
    'gemini-3.1-pro-preview': {
      cacheReadPer1M: 0.2,
      inputPer1M: 2,
      longContextCacheReadPer1M: 0.4,
      longContextInputPer1M: 4,
      longContextOutputPer1M: 18,
      longContextThreshold: 200000,
      outputPer1M: 12,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-05-13',
    },
    'gemini-3.5-flash': {
      cacheReadPer1M: 0.15,
      inputPer1M: 1.5,
      outputPer1M: 9,
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
      verifiedAt: '2026-06-04',
    },
  },

  deepseek: {
    'deepseek-chat': {
      cacheReadPer1M: 0.0028,
      deprecatedAliasFor: 'deepseek-v4-flash',
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      verifiedAt: '2026-05-13',
    },
    'deepseek-reasoner': {
      cacheReadPer1M: 0.0028,
      deprecatedAliasFor: 'deepseek-v4-flash',
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      verifiedAt: '2026-05-13',
    },
    'deepseek-v4-flash': {
      cacheReadPer1M: 0.0028,
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      verifiedAt: '2026-05-13',
    },
    'deepseek-v4-pro': {
      cacheReadPer1M: 0.003625,
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      verifiedAt: '2026-05-13',
    },
  },

  perplexity: {
    sonar: {
      inputPer1M: 1,
      outputPer1M: 1,
      sourceUrl: 'https://docs.perplexity.ai/guides/pricing',
      verifiedAt: '2026-05-13',
    },
    'sonar-deep-research': {
      inputPer1M: 2,
      outputPer1M: 8,
      partialCostCoverage: true,
      sourceUrl: 'https://docs.perplexity.ai/guides/pricing',
      verifiedAt: '2026-05-13',
    },
    'sonar-pro': {
      inputPer1M: 3,
      outputPer1M: 15,
      sourceUrl: 'https://docs.perplexity.ai/guides/pricing',
      verifiedAt: '2026-05-13',
    },
    'sonar-reasoning-pro': {
      inputPer1M: 2,
      outputPer1M: 8,
      sourceUrl: 'https://docs.perplexity.ai/guides/pricing',
      verifiedAt: '2026-05-13',
    },
  },
};
