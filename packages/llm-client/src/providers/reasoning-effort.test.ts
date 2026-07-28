/**
 * Unit tests for reasoning-effort.ts — resolveReasoningEffort() and
 * assertReasoningEffortUnsupported(). Pure functions, no SDK mocking needed
 * (mirrors the content-blocks.test.ts convention for assertBlocksSupported()).
 *
 * Test coverage:
 * - resolveReasoningEffort(): undefined passthrough, per-provider accepted value sets,
 *   Gemini uppercase mapping, bad_request rejection for out-of-range values.
 * - assertReasoningEffortUnsupported(): no-op when unset, bad_request when set,
 *   for both Perplexity and DeepSeek.
 * - Cross-provider divergence: the same LlmReasoningEffort value behaves differently
 *   per provider — this is the actual risk the enum mismatch creates.
 */

import { describe, expect, it } from 'vitest';
import type { LlmReasoningEffort } from '../types.js';
import { LlmError } from '../types.js';
import { assertReasoningEffortUnsupported, resolveReasoningEffort } from './reasoning-effort.js';

describe('resolveReasoningEffort — undefined passthrough', () => {
  it('returns undefined when effort is unset, for every provider', () => {
    expect(resolveReasoningEffort(undefined, 'anthropic')).toBeUndefined();
    expect(resolveReasoningEffort(undefined, 'openai')).toBeUndefined();
    expect(resolveReasoningEffort(undefined, 'gemini')).toBeUndefined();
  });
});

describe('resolveReasoningEffort — anthropic', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    "returns '%s' unchanged (lowercase, matches Anthropic.OutputConfig['effort'])",
    (value) => {
      expect(resolveReasoningEffort(value, 'anthropic')).toBe(value);
    }
  );

  it.each(['none', 'minimal'] as const)(
    "throws bad_request for '%s' — Anthropic has no 'none'/'minimal' effort levels",
    (value) => {
      expect(() => resolveReasoningEffort(value, 'anthropic')).toThrow(LlmError);
      try {
        resolveReasoningEffort(value, 'anthropic');
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        const e = err as LlmError;
        expect(e.kind).toBe('bad_request');
        expect(e.retryable).toBe(false);
        expect(e.provider).toBe('anthropic');
        expect(e.message).toContain('anthropic');
        expect(e.message).toContain(value);
      }
    }
  );
});

describe('resolveReasoningEffort — openai', () => {
  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    "returns '%s' unchanged — OpenAI accepts all 7 LlmReasoningEffort values",
    (value) => {
      expect(resolveReasoningEffort(value, 'openai')).toBe(value);
    }
  );
});

describe('resolveReasoningEffort — gemini', () => {
  it.each([
    ['minimal', 'MINIMAL'],
    ['low', 'LOW'],
    ['medium', 'MEDIUM'],
    ['high', 'HIGH'],
  ] as const)("maps '%s' to uppercase '%s' (ThinkingLevel enum)", (value, expected) => {
    expect(resolveReasoningEffort(value, 'gemini')).toBe(expected);
  });

  it.each(['none', 'xhigh', 'max'] as const)(
    "throws bad_request for '%s' — Gemini has no 'none'/'xhigh'/'max' thinking levels",
    (value) => {
      expect(() => resolveReasoningEffort(value, 'gemini')).toThrow(LlmError);
      try {
        resolveReasoningEffort(value, 'gemini');
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        const e = err as LlmError;
        expect(e.kind).toBe('bad_request');
        expect(e.retryable).toBe(false);
        expect(e.provider).toBe('gemini');
        expect(e.message).toContain('gemini');
      }
    }
  );
});

describe('assertReasoningEffortUnsupported — perplexity, deepseek', () => {
  it.each(['perplexity', 'deepseek'] as const)(
    '%s: no-op when reasoningEffort is unset',
    (provider) => {
      expect(() => assertReasoningEffortUnsupported(undefined, provider)).not.toThrow();
      expect(() => assertReasoningEffortUnsupported({}, provider)).not.toThrow();
    }
  );

  it.each(['perplexity', 'deepseek'] as const)(
    '%s: throws bad_request naming the provider when reasoningEffort is set',
    (provider) => {
      expect(() => assertReasoningEffortUnsupported({ reasoningEffort: 'high' }, provider)).toThrow(
        LlmError
      );
      try {
        assertReasoningEffortUnsupported({ reasoningEffort: 'high' }, provider);
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError);
        const e = err as LlmError;
        expect(e.kind).toBe('bad_request');
        expect(e.retryable).toBe(false);
        expect(e.provider).toBe(provider);
        expect(e.message).toContain(provider);
      }
    }
  );
});

describe('cross-provider divergence — the same value behaves differently per provider', () => {
  it("'minimal' succeeds on OpenAI and Gemini but throws on Anthropic", () => {
    expect(resolveReasoningEffort('minimal', 'openai')).toBe('minimal');
    expect(resolveReasoningEffort('minimal', 'gemini')).toBe('MINIMAL');
    expect(() => resolveReasoningEffort('minimal', 'anthropic')).toThrow(LlmError);
  });

  it("'xhigh' and 'max' succeed on Anthropic and OpenAI but throw on Gemini", () => {
    for (const value of ['xhigh', 'max'] as const) {
      expect(resolveReasoningEffort(value, 'anthropic')).toBe(value);
      expect(resolveReasoningEffort(value, 'openai')).toBe(value);
      expect(() => resolveReasoningEffort(value, 'gemini')).toThrow(LlmError);
    }
  });

  it("'none' succeeds only on OpenAI", () => {
    expect(resolveReasoningEffort('none', 'openai')).toBe('none');
    expect(() => resolveReasoningEffort('none', 'anthropic')).toThrow(LlmError);
    expect(() => resolveReasoningEffort('none', 'gemini')).toThrow(LlmError);
  });

  it('every LlmReasoningEffort value is handled by at least one provider without throwing', () => {
    const allValues: LlmReasoningEffort[] = [
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ];
    for (const value of allValues) {
      const results = (['anthropic', 'openai', 'gemini'] as const).map((provider) => {
        try {
          return resolveReasoningEffort(value, provider);
        } catch {
          return null;
        }
      });
      expect(results.some((r) => r !== null)).toBe(true);
    }
  });
});
