/**
 * Tests for server tool fees and the total-prompt-token long-context threshold
 * in computeCost() — @diabolicallabs/llm-pricing (xAI Grok server-side tools).
 *
 * Covers:
 * - Golden cost case from a real grok-4.7 response (billed cost matches to the cent)
 * - serverTools component presence/absence, zero-count handling
 * - isPartial when a non-zero count has no fee entry
 * - xai table completeness and tool fee values
 * - Long-context tier selected by total prompt tokens (uncached + cached)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { _resetWarnSetsForTesting, computeCost } from './compute.js';
import { setPricingLogger } from './logger.js';
import { DEFAULT_PRICING_TABLE } from './table.js';
import type { LlmUsage, PricingTable } from './types.js';

beforeEach(() => {
  _resetWarnSetsForTesting();
  // Silence pricing diagnostics (unknown model etc.) — these tests assert on cost, not logs.
  setPricingLogger({ warn: () => undefined });
});

/** Build a usage record with totalTokens derived from input + output. */
function usageOf(
  inputTokens: number,
  outputTokens: number,
  overrides: Partial<LlmUsage> = {}
): LlmUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...overrides };
}

describe('computeCost — server tool fees', () => {
  it('golden: grok-4.7 live probe (cached + 5 web + 14 posts + 11 profiles) = $0.3419', () => {
    // Real xAI response, 2026-10-04: billed cost_in_usd_ticks = 3,418,640,000 = $0.341864.
    // input_tokens (108,146) INCLUDES cached (61,568), so uncached = 46,578.
    const usage = usageOf(46_578, 2_154, {
      cacheReadTokens: 61_568,
      serverToolUsage: {
        webSearchCalls: 5,
        xSearchCalls: 7, // not billed: fee is 0
        xPostsFetched: 14,
        xUsersFetched: 11,
      },
    });
    const cost = computeCost({ usage, provider: 'xai', model: 'grok-4.7' });

    expect(Math.abs(cost.total - 0.3419)).toBeLessThan(0.00005);
    expect(cost.input).toBeCloseTo(0.093156, 6); // 46,578 x $2/1M
    expect(cost.cacheRead).toBeCloseTo(0.030784, 6); // 61,568 x $0.50/1M
    expect(cost.output).toBeCloseTo(0.012924, 6); // 2,154 x $6/1M
    expect(cost.serverTools).toBeCloseTo(0.205, 6); // 5x.005 + 14x.005 + 11x.01
    expect(cost.isPartial).toBe(false);
  });

  it('omits serverTools and leaves total unchanged when no tool usage is reported', () => {
    const cost = computeCost({
      usage: usageOf(100_000, 100_000),
      provider: 'xai',
      model: 'grok-4.7',
    });
    expect(cost.serverTools).toBeUndefined();
    expect(cost.total).toBeCloseTo(0.8, 6);
  });

  it('ignores zero counts (no serverTools component, not partial)', () => {
    const cost = computeCost({
      usage: usageOf(1_000, 1_000, { serverToolUsage: { webSearchCalls: 0 } }),
      provider: 'xai',
      model: 'grok-4.7',
    });
    expect(cost.serverTools).toBeUndefined();
    expect(cost.isPartial).toBe(false);
  });

  it('marks isPartial when a non-zero count has no fee entry', () => {
    const table: PricingTable = {
      ...DEFAULT_PRICING_TABLE,
      xai: {
        'grok-test': {
          inputPer1M: 1,
          outputPer1M: 1,
          serverToolFees: { webSearchCalls: 0.005 },
          verifiedAt: '2026-10-04',
          sourceUrl: 'test',
        },
      },
    };
    const cost = computeCost({
      usage: usageOf(0, 0, { serverToolUsage: { webSearchCalls: 2, imageGenerationCalls: 1 } }),
      provider: 'xai',
      model: 'grok-test',
      pricingTable: table,
    });
    expect(cost.serverTools).toBeCloseTo(0.01, 6); // only the priced key counts
    expect(cost.total).toBeCloseTo(0.01, 6);
    expect(cost.isPartial).toBe(true);
  });

  it('marks isPartial when the model has no serverToolFees at all', () => {
    const cost = computeCost({
      usage: usageOf(1_000, 1_000, { serverToolUsage: { webSearchCalls: 3 } }),
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    });
    expect(cost.isPartial).toBe(true);
    expect(cost.serverTools).toBe(0);
  });

  it('every xai table entry exists and carries the documented tool fees', () => {
    const entries = Object.entries(DEFAULT_PRICING_TABLE.xai);
    expect(entries.map(([id]) => id).sort()).toEqual(
      [
        'grok-4.20-0309-non-reasoning',
        'grok-4.20-0309-reasoning',
        'grok-4.20-multi-agent-0309',
        'grok-4.3',
        'grok-4.5',
        'grok-4.6',
        'grok-4.7',
        'grok-build-0.1',
      ].sort()
    );
    for (const [id, record] of entries) {
      expect(record.serverToolFees, `${id} serverToolFees`).toMatchObject({
        webSearchCalls: 0.005,
        xPostsFetched: 0.005,
        xUsersFetched: 0.01,
        codeInterpreterCalls: 0.005,
        fileSearchCalls: 0.0025,
        mcpCalls: 0,
      });
    }
  });
});

describe('computeCost — long-context threshold uses total prompt tokens', () => {
  it('a mostly-cached large prompt takes the long-context tier (grok-4.7)', () => {
    // 10k uncached + 250k cached = 260k total prompt tokens > 200k threshold,
    // even though inputTokens alone (10k) is far below it.
    const cost = computeCost({
      usage: usageOf(10_000, 1_000_000, { cacheReadTokens: 250_000 }),
      provider: 'xai',
      model: 'grok-4.7',
    });
    expect(cost.input).toBeCloseTo(0.04, 6); // 10k x $4 long-context
    expect(cost.cacheRead).toBeCloseTo(0.25, 6); // 250k x $1 long-context
    expect(cost.output).toBeCloseTo(12, 6); // 1M x $12 long-context
  });

  it('counts cacheCreationTokens toward the threshold too', () => {
    const cost = computeCost({
      usage: usageOf(10_000, 0, { cacheCreationTokens: 250_000 }),
      provider: 'xai',
      model: 'grok-4.7',
    });
    expect(cost.input).toBeCloseTo(0.04, 6); // long-context $4/1M
  });

  it('stays on the base tier when total prompt tokens are at or under the threshold', () => {
    const cost = computeCost({
      usage: usageOf(100_000, 0, { cacheReadTokens: 100_000 }),
      provider: 'xai',
      model: 'grok-4.7',
    });
    expect(cost.input).toBeCloseTo(0.2, 6); // $2/1M base
    expect(cost.cacheRead).toBeCloseTo(0.05, 6); // $0.50/1M base
  });
});
