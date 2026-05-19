/**
 * Tests for computeCost() — @diabolicallabs/llm-pricing.
 *
 * Covers:
 * - Every provider with a representative model
 * - Anthropic prompt cache math (5-min ephemeral write + read)
 * - Gemini long-context tier branching (≤200k vs >200k)
 * - Deprecated alias resolution (deepseek-chat, deepseek-reasoner) with structured log event
 * - Unknown model → zero cost, isPartial = true
 * - Override pricing table behavior
 * - Reasoning model isPartial flag (o-series)
 * - sonar-deep-research partialCostCoverage flag
 * - Date-strip fallback for dated model IDs (e.g. gpt-5.4-mini-2026-03-17)
 * - Warn-once behavior for unknown/deprecated/date-strip warns
 * - New model rows: claude-opus-4-5, gpt-5.4-nano, gpt-4o, gemini-3.1-pro long-context
 *
 * Diagnostic capture: tests inject a PricingLogger via setPricingLogger() that
 * pushes events into `warnCalls`. Assertions match on the stable event names
 * exported by the package (pricing_deprecated_alias, pricing_date_strip_fallback,
 * pricing_unknown_model) instead of brittle log-string substrings.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetWarnSetsForTesting, computeCost } from './compute.js';
import { setPricingLogger } from './logger.js';
import { DEFAULT_PRICING_TABLE } from './table.js';
import type { LlmUsage, PricingTable } from './types.js';

interface CapturedWarn {
  event: string;
  data: Record<string, unknown>;
}

let warnCalls: CapturedWarn[] = [];

beforeEach(() => {
  warnCalls = [];
  setPricingLogger({
    warn: (event, data) => {
      warnCalls.push({ event, data });
    },
  });
  // Reset module-level warn-once Sets so each test can assert on first-warn behavior
  // independently. Without this, warn Sets accumulate across tests in the same process.
  _resetWarnSetsForTesting();
});

afterEach(() => {
  setPricingLogger(null);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basicUsage(
  inputTokens: number,
  outputTokens: number,
  overrides: Partial<LlmUsage> = {}
): LlmUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...overrides,
  };
}

/** Round to 6 decimal places to avoid floating-point noise in assertions. */
function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe('computeCost — Anthropic', () => {
  it('claude-sonnet-4-6: basic input + output', () => {
    const usage = basicUsage(1_000_000, 500_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-sonnet-4-6' });

    // Input: 1M × $3.00/1M = $3.00
    // Output: 0.5M × $15.00/1M = $7.50
    expect(cost.input).toBeCloseTo(3.0, 5);
    expect(cost.output).toBeCloseTo(7.5, 5);
    expect(cost.cacheRead).toBe(0);
    expect(cost.cacheWrite).toBe(0);
    expect(round(cost.total)).toBe(10.5);
    expect(cost.currency).toBe('USD');
    expect(cost.isPartial).toBe(false);
  });

  it('claude-opus-4-7: basic pricing at higher rate', () => {
    const usage = basicUsage(100_000, 100_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-opus-4-7' });

    // Input: 0.1M × $5.00 = $0.50
    // Output: 0.1M × $25.00 = $2.50
    expect(cost.input).toBeCloseTo(0.5, 5);
    expect(cost.output).toBeCloseTo(2.5, 5);
    expect(round(cost.total)).toBe(3.0);
    expect(cost.isPartial).toBe(false);
  });

  it('claude-sonnet-4-6: with 5-min cache write (cacheCreationTokens)', () => {
    const usage = basicUsage(100_000, 50_000, { cacheCreationTokens: 200_000 });
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-sonnet-4-6' });

    // Input: 0.1M × $3.00 = $0.30
    // Output: 0.05M × $15.00 = $0.75
    // Cache write: 0.2M × $3.75/1M = $0.75
    expect(cost.input).toBeCloseTo(0.3, 5);
    expect(cost.output).toBeCloseTo(0.75, 5);
    expect(cost.cacheWrite).toBeCloseTo(0.75, 5);
    expect(cost.cacheRead).toBe(0);
    expect(round(cost.total)).toBe(1.8);
    expect(cost.isPartial).toBe(false);
  });

  it('claude-sonnet-4-6: with cache read (cacheReadTokens)', () => {
    const usage = basicUsage(50_000, 30_000, { cacheReadTokens: 500_000 });
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-sonnet-4-6' });

    // Input: 0.05M × $3.00 = $0.15
    // Output: 0.03M × $15.00 = $0.45
    // Cache read: 0.5M × $0.30/1M = $0.15
    expect(cost.input).toBeCloseTo(0.15, 5);
    expect(cost.output).toBeCloseTo(0.45, 5);
    expect(cost.cacheRead).toBeCloseTo(0.15, 5);
    expect(cost.cacheWrite).toBe(0);
    expect(round(cost.total)).toBe(0.75);
  });

  it('claude-sonnet-4-6: with both cache write and read', () => {
    const usage = basicUsage(100_000, 50_000, {
      cacheCreationTokens: 200_000,
      cacheReadTokens: 300_000,
    });
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-sonnet-4-6' });

    // Input: 0.1M × $3.00 = $0.30
    // Output: 0.05M × $15.00 = $0.75
    // CacheWrite: 0.2M × $3.75 = $0.75
    // CacheRead: 0.3M × $0.30 = $0.09
    expect(round(cost.total)).toBeCloseTo(0.3 + 0.75 + 0.75 + 0.09, 5);
    expect(cost.isPartial).toBe(false);
  });

  it('claude-haiku-4-5: lowest Anthropic tier', () => {
    const usage = basicUsage(1_000_000, 1_000_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-haiku-4-5' });

    // Input: $1.00, Output: $5.00
    expect(cost.input).toBeCloseTo(1.0, 5);
    expect(cost.output).toBeCloseTo(5.0, 5);
    expect(round(cost.total)).toBe(6.0);
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe('computeCost — OpenAI', () => {
  it('gpt-5.5: standard input + output', () => {
    const usage = basicUsage(1_000_000, 200_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.5' });

    // Input: 1M × $5.00 = $5.00
    // Output: 0.2M × $30.00 = $6.00
    expect(cost.input).toBeCloseTo(5.0, 5);
    expect(cost.output).toBeCloseTo(6.0, 5);
    expect(round(cost.total)).toBe(11.0);
    expect(cost.isPartial).toBe(false);
  });

  it('gpt-5.5: with cache read', () => {
    const usage = basicUsage(100_000, 50_000, { cacheReadTokens: 900_000 });
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.5' });

    // CacheRead: 0.9M × $0.50 = $0.45
    expect(cost.cacheRead).toBeCloseTo(0.45, 5);
  });

  it('gpt-4.1: mid-tier model', () => {
    const usage = basicUsage(500_000, 500_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-4.1' });

    // Input: 0.5M × $2.00 = $1.00
    // Output: 0.5M × $8.00 = $4.00
    expect(round(cost.total)).toBe(5.0);
    expect(cost.isPartial).toBe(false);
  });

  it('o3: isPartial = true due to invisible reasoning tokens', () => {
    const usage = basicUsage(100_000, 50_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'o3' });

    // o3: Input $2.00/1M, Output $8.00/1M (includes invisible reasoning)
    expect(cost.input).toBeCloseTo(0.2, 5);
    expect(cost.output).toBeCloseTo(0.4, 5);
    expect(cost.isPartial).toBe(true); // hasInvisibleReasoningTokens
  });

  it('o4-mini: isPartial = true due to invisible reasoning tokens', () => {
    const usage = basicUsage(100_000, 100_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'o4-mini' });

    // o4-mini: Input $1.10/1M, Output $4.40/1M
    expect(cost.input).toBeCloseTo(0.11, 5);
    expect(cost.output).toBeCloseTo(0.44, 5);
    expect(cost.isPartial).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gemini — long-context branching
// ---------------------------------------------------------------------------

describe('computeCost — Gemini long-context branching', () => {
  it('gemini-3.1-pro-preview: short context (≤200k) uses standard rates', () => {
    const usage = basicUsage(100_000, 50_000); // well under 200k threshold
    const cost = computeCost({ usage, provider: 'gemini', model: 'gemini-3.1-pro-preview' });

    // Short-context: Input $2.00/1M, Output $12.00/1M
    expect(cost.input).toBeCloseTo(0.2, 5);
    expect(cost.output).toBeCloseTo(0.6, 5);
    expect(cost.isPartial).toBe(false);
  });

  it('gemini-3.1-pro-preview: long context (>200k) uses elevated rates', () => {
    const usage = basicUsage(250_000, 100_000); // over 200k threshold
    const cost = computeCost({ usage, provider: 'gemini', model: 'gemini-3.1-pro-preview' });

    // Long-context: Input $4.00/1M, Output $18.00/1M
    expect(cost.input).toBeCloseTo(1.0, 5); // 0.25M × $4.00
    expect(cost.output).toBeCloseTo(1.8, 5); // 0.1M × $18.00
    expect(cost.isPartial).toBe(false);
  });

  it('gemini-3.1-pro-preview: exactly at threshold (200k) uses standard rates', () => {
    const usage = basicUsage(200_000, 50_000); // exactly at threshold — NOT above
    const cost = computeCost({ usage, provider: 'gemini', model: 'gemini-3.1-pro-preview' });

    // inputTokens > 200_000 is false for exactly 200_000 — uses standard rates
    expect(cost.input).toBeCloseTo(0.4, 5); // 0.2M × $2.00
    expect(cost.output).toBeCloseTo(0.6, 5); // 0.05M × $12.00
  });

  it('gemini-3.1-pro-preview: long context with cache read', () => {
    const usage = basicUsage(300_000, 100_000, { cacheReadTokens: 50_000 });
    const cost = computeCost({ usage, provider: 'gemini', model: 'gemini-3.1-pro-preview' });

    // Long-context cache read: 0.05M × $0.40 = $0.02
    expect(cost.cacheRead).toBeCloseTo(0.02, 5);
  });

  it('gemini-2.5-pro: long-context tier applies', () => {
    const usage = basicUsage(300_000, 100_000);
    const cost = computeCost({ usage, provider: 'gemini', model: 'gemini-2.5-pro' });

    // Long-context: Input $2.50/1M, Output $15.00/1M
    expect(cost.input).toBeCloseTo(0.75, 5);
    expect(cost.output).toBeCloseTo(1.5, 5);
  });

  it('gemini-2.5-flash: flat pricing regardless of input size', () => {
    const usage = basicUsage(500_000, 500_000);
    const cost = computeCost({ usage, provider: 'gemini', model: 'gemini-2.5-flash' });

    // Flat: Input $0.30/1M, Output $2.50/1M — no tiered pricing
    expect(cost.input).toBeCloseTo(0.15, 5);
    expect(cost.output).toBeCloseTo(1.25, 5);
    expect(cost.isPartial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek — deprecated aliases
// ---------------------------------------------------------------------------

describe('computeCost — DeepSeek deprecated alias resolution', () => {
  it('deepseek-v4-flash: canonical ID, no warning', () => {
    const usage = basicUsage(1_000_000, 500_000);
    const cost = computeCost({ usage, provider: 'deepseek', model: 'deepseek-v4-flash' });

    // Input: 1M × $0.14 = $0.14
    // Output: 0.5M × $0.28 = $0.14
    expect(cost.input).toBeCloseTo(0.14, 5);
    expect(cost.output).toBeCloseTo(0.14, 5);
    expect(cost.isPartial).toBe(false);
    expect(warnCalls.filter((w) => w.event === 'pricing_deprecated_alias')).toHaveLength(0);
  });

  it('deepseek-chat: emits deprecation warning, returns v4-flash rates', () => {
    const usage = basicUsage(1_000_000, 500_000);
    const cost = computeCost({ usage, provider: 'deepseek', model: 'deepseek-chat' });

    // Same rates as deepseek-v4-flash
    expect(cost.input).toBeCloseTo(0.14, 5);
    expect(cost.output).toBeCloseTo(0.14, 5);
    // Deprecation warning must be emitted
    const depWarnings = warnCalls.filter((w) => w.event === 'pricing_deprecated_alias');
    expect(depWarnings.length).toBeGreaterThan(0);
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(depWarnings[0]?.data['model']).toBe('deepseek-chat');
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(depWarnings[0]?.data['deprecatedAliasFor']).toBe('deepseek-v4-flash');
  });

  it('deepseek-reasoner: emits deprecation warning, returns v4-flash rates', () => {
    const usage = basicUsage(500_000, 200_000);
    const cost = computeCost({ usage, provider: 'deepseek', model: 'deepseek-reasoner' });

    expect(cost.input).toBeCloseTo(0.07, 5); // 0.5M × $0.14
    expect(cost.output).toBeCloseTo(0.056, 5); // 0.2M × $0.28
    const depWarnings = warnCalls.filter((w) => w.event === 'pricing_deprecated_alias');
    expect(depWarnings.length).toBeGreaterThan(0);
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(depWarnings[0]?.data['model']).toBe('deepseek-reasoner');
  });

  it('deepseek-v4-pro: canonical ID, promotional pricing', () => {
    const usage = basicUsage(1_000_000, 1_000_000);
    const cost = computeCost({ usage, provider: 'deepseek', model: 'deepseek-v4-pro' });

    // Promotional: Input $0.435/1M, Output $0.87/1M
    expect(cost.input).toBeCloseTo(0.435, 5);
    expect(cost.output).toBeCloseTo(0.87, 5);
    expect(cost.isPartial).toBe(false);
    expect(warnCalls.filter((w) => w.event === 'pricing_deprecated_alias')).toHaveLength(0);
  });

  it('deepseek-v4-flash: with server-side cache read', () => {
    const usage = basicUsage(500_000, 200_000, { cacheReadTokens: 500_000 });
    const cost = computeCost({ usage, provider: 'deepseek', model: 'deepseek-v4-flash' });

    // CacheRead: 0.5M × $0.0028 = $0.0014
    expect(cost.cacheRead).toBeCloseTo(0.0014, 6);
  });
});

// ---------------------------------------------------------------------------
// Perplexity
// ---------------------------------------------------------------------------

describe('computeCost — Perplexity', () => {
  it('sonar: basic cost', () => {
    const usage = basicUsage(500_000, 300_000);
    const cost = computeCost({ usage, provider: 'perplexity', model: 'sonar' });

    // Input: 0.5M × $1.00 = $0.50
    // Output: 0.3M × $1.00 = $0.30
    expect(cost.input).toBeCloseTo(0.5, 5);
    expect(cost.output).toBeCloseTo(0.3, 5);
    expect(round(cost.total)).toBe(0.8);
    expect(cost.isPartial).toBe(false);
  });

  it('sonar-pro: higher rate', () => {
    const usage = basicUsage(100_000, 50_000);
    const cost = computeCost({ usage, provider: 'perplexity', model: 'sonar-pro' });

    // Input: 0.1M × $3.00 = $0.30
    // Output: 0.05M × $15.00 = $0.75
    expect(round(cost.total)).toBe(1.05);
    expect(cost.isPartial).toBe(false);
  });

  it('sonar-deep-research: isPartial = true', () => {
    const usage = basicUsage(100_000, 50_000);
    const cost = computeCost({ usage, provider: 'perplexity', model: 'sonar-deep-research' });

    // Token cost computable, but citation/search/reasoning fees are not
    expect(cost.input).toBeCloseTo(0.2, 5);
    expect(cost.output).toBeCloseTo(0.4, 5);
    expect(cost.isPartial).toBe(true); // partialCostCoverage
  });

  it('sonar-reasoning-pro: standard cost', () => {
    const usage = basicUsage(200_000, 100_000);
    const cost = computeCost({ usage, provider: 'perplexity', model: 'sonar-reasoning-pro' });

    // Input: 0.2M × $2.00 = $0.40
    // Output: 0.1M × $8.00 = $0.80
    expect(round(cost.total)).toBe(1.2);
    expect(cost.isPartial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown model
// ---------------------------------------------------------------------------

describe('computeCost — unknown model', () => {
  it('returns zero cost with isPartial = true and emits warning', () => {
    const usage = basicUsage(100_000, 50_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-nonexistent-9000' });

    expect(cost.input).toBe(0);
    expect(cost.output).toBe(0);
    expect(cost.cacheRead).toBe(0);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBe(0);
    expect(cost.isPartial).toBe(true);
    expect(warnCalls.some((w) => w.event === 'pricing_unknown_model')).toBe(true);
  });

  it('unknown provider also returns zero + warning', () => {
    const usage = basicUsage(100_000, 50_000);
    // Cast to satisfy types — runtime behavior is what we're testing
    const cost = computeCost({
      usage,
      provider: 'unknown-provider' as never,
      model: 'some-model',
    });

    expect(cost.total).toBe(0);
    expect(cost.isPartial).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Consumer override
// ---------------------------------------------------------------------------

describe('computeCost — pricing override', () => {
  it('uses custom pricing table when provided', () => {
    const customTable: PricingTable = {
      ...DEFAULT_PRICING_TABLE,
      anthropic: {
        'claude-sonnet-4-6': {
          inputPer1M: 99.0, // obviously custom
          outputPer1M: 199.0,
          verifiedAt: '2026-01-01',
          sourceUrl: 'custom',
        },
      },
    };

    const usage = basicUsage(1_000_000, 500_000);
    const cost = computeCost({
      usage,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      pricingTable: customTable,
    });

    expect(cost.input).toBeCloseTo(99.0, 5);
    expect(cost.output).toBeCloseTo(99.5, 5);
  });

  it('falls back to default table when no override', () => {
    const usage = basicUsage(1_000_000, 1_000_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-sonnet-4-6' });

    expect(cost.input).toBeCloseTo(3.0, 5);
    expect(cost.output).toBeCloseTo(15.0, 5);
  });
});

// ---------------------------------------------------------------------------
// Zero token edge cases
// ---------------------------------------------------------------------------

describe('computeCost — zero tokens', () => {
  it('handles zero input and output tokens gracefully', () => {
    const usage = basicUsage(0, 0);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-sonnet-4-6' });

    expect(cost.input).toBe(0);
    expect(cost.output).toBe(0);
    expect(cost.total).toBe(0);
    expect(cost.isPartial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_PRICING_TABLE integrity checks
// ---------------------------------------------------------------------------

describe('DEFAULT_PRICING_TABLE integrity', () => {
  it('has a versionedAt ISO date string', () => {
    expect(DEFAULT_PRICING_TABLE.versionedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('all model records have required fields', () => {
    const providers = ['anthropic', 'openai', 'gemini', 'deepseek', 'perplexity'] as const;
    for (const provider of providers) {
      const models = DEFAULT_PRICING_TABLE[provider];
      for (const [modelId, record] of Object.entries(models)) {
        expect(record.inputPer1M, `${provider}/${modelId} missing inputPer1M`).toBeTypeOf('number');
        expect(record.outputPer1M, `${provider}/${modelId} missing outputPer1M`).toBeTypeOf(
          'number'
        );
        expect(record.verifiedAt, `${provider}/${modelId} missing verifiedAt`).toBeTypeOf('string');
        expect(record.sourceUrl, `${provider}/${modelId} missing sourceUrl`).toBeTypeOf('string');
        // All prices must be non-negative
        expect(record.inputPer1M, `${provider}/${modelId} inputPer1M < 0`).toBeGreaterThanOrEqual(
          0
        );
        expect(record.outputPer1M, `${provider}/${modelId} outputPer1M < 0`).toBeGreaterThanOrEqual(
          0
        );
      }
    }
  });

  it('Anthropic cache write rates are consistent with multipliers', () => {
    // cacheWritePer1M should be 1.25× inputPer1M
    // cacheWrite1hPer1M should be 2× inputPer1M
    const { anthropic } = DEFAULT_PRICING_TABLE;
    for (const [model, record] of Object.entries(anthropic)) {
      if (record.cacheWritePer1M !== undefined) {
        const expectedWrite = Math.round(record.inputPer1M * 1.25 * 1000) / 1000;
        const actualWrite = Math.round(record.cacheWritePer1M * 1000) / 1000;
        expect(actualWrite, `${model} cacheWritePer1M should be 1.25× input`).toBeCloseTo(
          expectedWrite,
          2
        );
      }
      if (record.cacheWrite1hPer1M !== undefined) {
        const expectedWrite1h = Math.round(record.inputPer1M * 2.0 * 1000) / 1000;
        const actualWrite1h = Math.round(record.cacheWrite1hPer1M * 1000) / 1000;
        expect(actualWrite1h, `${model} cacheWrite1hPer1M should be 2× input`).toBeCloseTo(
          expectedWrite1h,
          2
        );
      }
    }
  });

  it('deprecated aliases point to canonical models', () => {
    const { deepseek } = DEFAULT_PRICING_TABLE;
    expect(deepseek['deepseek-chat']?.deprecatedAliasFor).toBe('deepseek-v4-flash');
    expect(deepseek['deepseek-reasoner']?.deprecatedAliasFor).toBe('deepseek-v4-flash');
    // Canonical models must exist
    expect(deepseek['deepseek-v4-flash']).toBeDefined();
    expect(deepseek['deepseek-v4-pro']).toBeDefined();
  });

  it('Gemini long-context models have paired threshold + rate fields', () => {
    const { gemini } = DEFAULT_PRICING_TABLE;
    const tieredModels = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3.1-pro'];
    for (const model of tieredModels) {
      const record = gemini[model];
      expect(record?.longContextThreshold, `${model} missing longContextThreshold`).toBeDefined();
      expect(record?.longContextInputPer1M, `${model} missing longContextInputPer1M`).toBeDefined();
      expect(
        record?.longContextOutputPer1M,
        `${model} missing longContextOutputPer1M`
      ).toBeDefined();
      expect(
        record?.longContextInputPer1M ?? 0,
        `${model} long-context input should be higher than standard`
      ).toBeGreaterThan(record?.inputPer1M ?? 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Date-strip fallback
// ---------------------------------------------------------------------------

describe('computeCost — date-strip fallback', () => {
  it('gpt-5.4-mini-2026-03-17: resolves to gpt-5.4-mini pricing (the prod leak case)', () => {
    // This is the exact model ID GEOAudit's afterCall hook receives from the
    // OpenAI Responses API. Before this fix, it returned { total: 0, isPartial: true }.
    const usage = basicUsage(1_000_000, 500_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.4-mini-2026-03-17' });

    // gpt-5.4-mini: Input $0.75/1M, Output $4.50/1M
    expect(cost.input).toBeCloseTo(0.75, 5);
    expect(cost.output).toBeCloseTo(2.25, 5);
    expect(cost.total).toBeGreaterThan(0);
    expect(cost.isPartial).toBe(false);
  });

  it('gpt-5.4-mini-2026-03-17: emits date-strip fallback warn', () => {
    const usage = basicUsage(100_000, 50_000);
    computeCost({ usage, provider: 'openai', model: 'gpt-5.4-mini-2026-03-17' });

    const fallbackWarns = warnCalls.filter((w) => w.event === 'pricing_date_strip_fallback');
    expect(fallbackWarns).toHaveLength(1);
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(fallbackWarns[0]?.data['model']).toBe('gpt-5.4-mini-2026-03-17');
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(fallbackWarns[0]?.data['alias']).toBe('gpt-5.4-mini');
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(fallbackWarns[0]?.data['provider']).toBe('openai');
  });

  it('claude-opus-4-7-20251101: strips -YYYYMMDD suffix, resolves to claude-opus-4-7', () => {
    const usage = basicUsage(100_000, 100_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-opus-4-7-20251101' });

    // claude-opus-4-7: Input $5.00/1M, Output $25.00/1M
    expect(cost.input).toBeCloseTo(0.5, 5);
    expect(cost.output).toBeCloseTo(2.5, 5);
    expect(cost.total).toBeGreaterThan(0);
    expect(cost.isPartial).toBe(false);
    // Date-strip warn should fire
    expect(warnCalls.some((w) => w.event === 'pricing_date_strip_fallback')).toBe(true);
  });

  it('claude-haiku-4-5-20251001: exact match wins, fallback never fires', () => {
    // This dated ID IS in the table as an explicit entry — exact match must win.
    const usage = basicUsage(1_000_000, 1_000_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-haiku-4-5-20251001' });

    // claude-haiku-4-5: Input $1.00/1M, Output $5.00/1M
    expect(cost.input).toBeCloseTo(1.0, 5);
    expect(cost.output).toBeCloseTo(5.0, 5);
    expect(cost.total).toBeGreaterThan(0);
    expect(cost.isPartial).toBe(false);
    // No date-strip fallback warn — exact match path
    expect(warnCalls.some((w) => w.event === 'pricing_date_strip_fallback')).toBe(false);
  });

  it('unknown-model-2026-01-01: strips to unknown-model, still not found → zero cost', () => {
    const usage = basicUsage(100_000, 50_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'unknown-model-2026-01-01' });

    expect(cost.total).toBe(0);
    expect(cost.isPartial).toBe(true);
    // Unknown model warn fires, not date-strip warn (alias also misses)
    expect(warnCalls.some((w) => w.event === 'pricing_unknown_model')).toBe(true);
    expect(warnCalls.some((w) => w.event === 'pricing_date_strip_fallback')).toBe(false);
  });

  it('deepseek-v4-flash: no date suffix, exact match, no fallback attempted', () => {
    const usage = basicUsage(1_000_000, 500_000);
    const cost = computeCost({ usage, provider: 'deepseek', model: 'deepseek-v4-flash' });

    expect(cost.total).toBeGreaterThan(0);
    expect(cost.isPartial).toBe(false);
    expect(warnCalls.some((w) => w.event === 'pricing_date_strip_fallback')).toBe(false);
    expect(warnCalls.some((w) => w.event === 'pricing_unknown_model')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Warn-once behavior
// ---------------------------------------------------------------------------

describe('computeCost — warn-once for repeated calls', () => {
  it('unknown model: warn fires exactly once across multiple calls', () => {
    // beforeEach already installed an injected logger that captures into warnCalls.
    const usage = basicUsage(100_000, 50_000);
    computeCost({ usage, provider: 'openai', model: 'gpt-unknown-9999' });
    computeCost({ usage, provider: 'openai', model: 'gpt-unknown-9999' });
    computeCost({ usage, provider: 'openai', model: 'gpt-unknown-9999' });

    const unknownWarns = warnCalls.filter((w) => w.event === 'pricing_unknown_model');
    expect(unknownWarns).toHaveLength(1);
  });

  it('date-strip fallback: warn fires exactly once for the same dated model ID', () => {
    const usage = basicUsage(100_000, 50_000);
    computeCost({ usage, provider: 'openai', model: 'gpt-5.4-mini-2026-03-17' });
    computeCost({ usage, provider: 'openai', model: 'gpt-5.4-mini-2026-03-17' });
    computeCost({ usage, provider: 'openai', model: 'gpt-5.4-mini-2026-03-17' });

    const fallbackWarns = warnCalls.filter((w) => w.event === 'pricing_date_strip_fallback');
    expect(fallbackWarns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// New model pricing rows — gpt-5.1/5.2/5.3 family (patch 2, 2026-05-18)
// ---------------------------------------------------------------------------

describe('computeCost — gpt-5.1/5.2/5.3 family (patch 2)', () => {
  it('gpt-5.1: correct input/output/cacheRead pricing', () => {
    const usage = basicUsage(1_000_000, 500_000, { cacheReadTokens: 1_000_000 });
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.1' });

    // Input: 1M × $1.25 = $1.25
    // Output: 0.5M × $10.00 = $5.00
    // CacheRead: 1M × $0.125 = $0.125
    expect(cost.input).toBeCloseTo(1.25, 5);
    expect(cost.output).toBeCloseTo(5.0, 5);
    expect(cost.cacheRead).toBeCloseTo(0.125, 5);
    expect(cost.isPartial).toBe(false);
  });

  it('gpt-5.1-2025-11-13: date-strip fallback resolves to gpt-5.1 pricing', () => {
    // A real dated variant returned by the OpenAI Responses API.
    // date-strip fallback should strip -2025-11-13 and match gpt-5.1.
    const usage = basicUsage(1_000_000, 500_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.1-2025-11-13' });

    // Same rates as gpt-5.1
    expect(cost.input).toBeCloseTo(1.25, 5);
    expect(cost.output).toBeCloseTo(5.0, 5);
    expect(cost.total).toBeGreaterThan(0);
    expect(cost.isPartial).toBe(false);
    // Date-strip warn must fire
    expect(warnCalls.some((w) => w.event === 'pricing_date_strip_fallback')).toBe(true);
  });

  it('gpt-5.1-codex-mini: lowest gpt-5.1 tier', () => {
    const usage = basicUsage(1_000_000, 1_000_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.1-codex-mini' });

    // Input: $0.25/1M, Output: $2.00/1M
    expect(cost.input).toBeCloseTo(0.25, 5);
    expect(cost.output).toBeCloseTo(2.0, 5);
    expect(round(cost.total)).toBe(2.25);
    expect(cost.isPartial).toBe(false);
  });

  it('gpt-5.2: same rates as gpt-5.3-chat-latest and gpt-5.3-codex', () => {
    const usage = basicUsage(1_000_000, 500_000);
    const c52 = computeCost({ usage, provider: 'openai', model: 'gpt-5.2' });
    const c53chat = computeCost({ usage, provider: 'openai', model: 'gpt-5.3-chat-latest' });
    const c53codex = computeCost({ usage, provider: 'openai', model: 'gpt-5.3-codex' });

    // Input: 1M × $1.75 = $1.75, Output: 0.5M × $14.00 = $7.00
    expect(c52.input).toBeCloseTo(1.75, 5);
    expect(c52.output).toBeCloseTo(7.0, 5);
    expect(c52.total).toBeCloseTo(c53chat.total, 5);
    expect(c52.total).toBeCloseTo(c53codex.total, 5);
    expect(c52.isPartial).toBe(false);
  });

  it('gpt-5.2-pro: premium tier with highest output rate', () => {
    const usage = basicUsage(100_000, 100_000, { cacheReadTokens: 100_000 });
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.2-pro' });

    // Input: 0.1M × $21.00 = $2.10
    // Output: 0.1M × $168.00 = $16.80
    // CacheRead: 0.1M × $2.10 = $0.21
    expect(cost.input).toBeCloseTo(2.1, 5);
    expect(cost.output).toBeCloseTo(16.8, 5);
    expect(cost.cacheRead).toBeCloseTo(0.21, 5);
    expect(cost.isPartial).toBe(false);
  });

  it('gpt-5.2-codex: same rates as gpt-5.2', () => {
    const usage = basicUsage(500_000, 200_000);
    const c52 = computeCost({ usage, provider: 'openai', model: 'gpt-5.2' });
    const c52codex = computeCost({ usage, provider: 'openai', model: 'gpt-5.2-codex' });

    expect(c52.total).toBeCloseTo(c52codex.total, 5);
  });
});

// ---------------------------------------------------------------------------
// New model pricing rows — smoke tests
// ---------------------------------------------------------------------------

describe('computeCost — new model rows (patch 1)', () => {
  it('claude-opus-4-5: correct pricing (same tier as claude-opus-4-7)', () => {
    const usage = basicUsage(1_000_000, 1_000_000);
    const cost = computeCost({ usage, provider: 'anthropic', model: 'claude-opus-4-5' });

    // Input: $5.00/1M, Output: $25.00/1M
    expect(cost.input).toBeCloseTo(5.0, 5);
    expect(cost.output).toBeCloseTo(25.0, 5);
    expect(round(cost.total)).toBe(30.0);
    expect(cost.isPartial).toBe(false);
  });

  it('gpt-5.4-nano: lowest OpenAI tier pricing', () => {
    const usage = basicUsage(1_000_000, 1_000_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-5.4-nano' });

    // Input: $0.20/1M, Output: $1.25/1M
    expect(cost.input).toBeCloseTo(0.2, 5);
    expect(cost.output).toBeCloseTo(1.25, 5);
    expect(cost.isPartial).toBe(false);
  });

  it('gpt-4o: mid-tier pricing with cache read', () => {
    const usage = basicUsage(1_000_000, 500_000, { cacheReadTokens: 500_000 });
    const cost = computeCost({ usage, provider: 'openai', model: 'gpt-4o' });

    // Input: 1M × $2.50 = $2.50
    // Output: 0.5M × $10.00 = $5.00
    // CacheRead: 0.5M × $1.25 = $0.625
    expect(cost.input).toBeCloseTo(2.5, 5);
    expect(cost.output).toBeCloseTo(5.0, 5);
    expect(cost.cacheRead).toBeCloseTo(0.625, 5);
    expect(cost.isPartial).toBe(false);
  });

  it('gemini-3.1-pro: long-context tier applies above 200k tokens', () => {
    // This is the non-preview variant added in patch 1.
    const usageShort = basicUsage(100_000, 50_000);
    const costShort = computeCost({
      usage: usageShort,
      provider: 'gemini',
      model: 'gemini-3.1-pro',
    });
    // Short-context: $2.00/1M input, $12.00/1M output
    expect(costShort.input).toBeCloseTo(0.2, 5);
    expect(costShort.output).toBeCloseTo(0.6, 5);

    const usageLong = basicUsage(250_000, 100_000);
    const costLong = computeCost({ usage: usageLong, provider: 'gemini', model: 'gemini-3.1-pro' });
    // Long-context: $4.00/1M input, $18.00/1M output
    expect(costLong.input).toBeCloseTo(1.0, 5);
    expect(costLong.output).toBeCloseTo(1.8, 5);
    expect(costLong.isPartial).toBe(false);
  });

  it('o3-mini: reasoning model, isPartial = true', () => {
    const usage = basicUsage(100_000, 100_000);
    const cost = computeCost({ usage, provider: 'openai', model: 'o3-mini' });

    // Input: $1.10/1M, Output: $4.40/1M
    expect(cost.input).toBeCloseTo(0.11, 5);
    expect(cost.output).toBeCloseTo(0.44, 5);
    expect(cost.isPartial).toBe(true); // hasInvisibleReasoningTokens
  });

  it('o1: reasoning model, isPartial = true, with cache read', () => {
    const usage = basicUsage(100_000, 50_000, { cacheReadTokens: 200_000 });
    const cost = computeCost({ usage, provider: 'openai', model: 'o1' });

    // Input: $15.00/1M, Output: $60.00/1M, CacheRead: $7.50/1M
    expect(cost.input).toBeCloseTo(1.5, 5);
    expect(cost.output).toBeCloseTo(3.0, 5);
    expect(cost.cacheRead).toBeCloseTo(1.5, 5);
    expect(cost.isPartial).toBe(true);
  });
});
