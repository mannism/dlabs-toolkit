/**
 * Tests for provider capability matrix — getModelCapabilities().
 *
 * One representative model per provider + unknown model → null.
 * Verifies shape is correct and key capability flags match provider implementation.
 */

import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES_VERSIONED_AT,
  getModelCapabilities,
  type ModelCapabilities,
} from './capabilities.js';

describe('getModelCapabilities', () => {
  // ── Anthropic ────────────────────────────────────────────────────────────

  it('returns correct capabilities for claude-opus-4-7 (anthropic)', () => {
    const caps = getModelCapabilities('anthropic', 'claude-opus-4-7');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.contextWindow).toBe(1_000_000);
    expect(c.maxOutputTokens).toBe(32_000);
    expect(c.streaming).toBe(true);
    expect(c.tools).toBe(true);
    expect(c.parallelTools).toBe(true);
    expect(c.promptCache).toBe('ephemeral');
    expect(c.structuredOutput).toBe('tool-use');
    expect(c.responseIds).toBe('provider');
    expect(c.streamStructured).toBe(true);
    expect(c.reasoningEffort).toBe('anthropic-effort');
  });

  // ── OpenAI ───────────────────────────────────────────────────────────────

  it('returns correct capabilities for gpt-5.5 (openai)', () => {
    const caps = getModelCapabilities('openai', 'gpt-5.5');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.contextWindow).toBe(1_000_000);
    expect(c.streaming).toBe(true);
    expect(c.tools).toBe(true);
    expect(c.parallelTools).toBe(true);
    expect(c.promptCache).toBeNull();
    expect(c.structuredOutput).toBe('json-schema');
    expect(c.responseIds).toBe('provider');
    expect(c.streamStructured).toBe(true);
    expect(c.reasoningEffort).toBe('openai-effort');
  });

  // ── Gemini ───────────────────────────────────────────────────────────────

  it('returns correct capabilities for gemini-2.5-flash (gemini)', () => {
    const caps = getModelCapabilities('gemini', 'gemini-2.5-flash');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.contextWindow).toBe(1_000_000);
    expect(c.streaming).toBe(true);
    expect(c.tools).toBe(true);
    // Gemini has no parallelToolCalls flag — not supported
    expect(c.parallelTools).toBe(false);
    expect(c.promptCache).toBeNull();
    expect(c.structuredOutput).toBe('response-schema');
    // Gemini does not issue native response IDs
    expect(c.responseIds).toBe('synthesized');
    // streamStructured throws bad_request on Gemini
    expect(c.streamStructured).toBe(false);
    // Gemini 2.5 series uses thinkingBudget, not thinkingLevel — no reasoningEffort support.
    expect(c.reasoningEffort).toBeNull();
  });

  it('returns correct capabilities for gemini-3.5-flash (gemini)', () => {
    const caps = getModelCapabilities('gemini', 'gemini-3.5-flash');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.contextWindow).toBe(1_048_576);
    expect(c.maxOutputTokens).toBe(65_536);
    expect(c.streaming).toBe(true);
    expect(c.tools).toBe(true);
    expect(c.parallelTools).toBe(false);
    expect(c.promptCache).toBeNull();
    expect(c.structuredOutput).toBe('response-schema');
    expect(c.responseIds).toBe('synthesized');
    expect(c.streamStructured).toBe(false);
    expect(c.mediaInput.image.base64).toBe(true);
    expect(c.mediaInput.image.url).toBe(false);
    expect(c.mediaInput.document.pdfBase64).toBe(true);
    // Gemini 3.5 (Gemini 3+ generation) supports thinkingConfig.thinkingLevel.
    expect(c.reasoningEffort).toBe('gemini-thinking-level');
  });

  // ── DeepSeek ─────────────────────────────────────────────────────────────

  it('returns correct capabilities for deepseek-v4-flash (deepseek)', () => {
    const caps = getModelCapabilities('deepseek', 'deepseek-v4-flash');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.contextWindow).toBe(64_000);
    expect(c.streaming).toBe(true);
    expect(c.tools).toBe(true);
    expect(c.parallelTools).toBe(true);
    expect(c.promptCache).toBeNull();
    expect(c.structuredOutput).toBe('json-schema');
    expect(c.responseIds).toBe('provider');
    expect(c.streamStructured).toBe(true);
    expect(c.reasoningEffort).toBeNull();
  });

  // ── Perplexity ───────────────────────────────────────────────────────────

  it('returns correct capabilities for sonar (perplexity)', () => {
    const caps = getModelCapabilities('perplexity', 'sonar');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.contextWindow).toBe(127_072);
    expect(c.streaming).toBe(true);
    // Perplexity does not support tool calling
    expect(c.tools).toBe(false);
    expect(c.parallelTools).toBe(false);
    expect(c.promptCache).toBeNull();
    // Perplexity structured output is prompt-only
    expect(c.structuredOutput).toBeNull();
    expect(c.responseIds).toBe('provider');
    // streamStructured throws bad_request on Perplexity
    expect(c.streamStructured).toBe(false);
    expect(c.reasoningEffort).toBeNull();
  });

  // ── Unknown model → null ─────────────────────────────────────────────────

  it('returns null for an unknown model (does not throw)', () => {
    expect(getModelCapabilities('anthropic', 'claude-not-a-real-model')).toBeNull();
  });

  it('returns null for an unknown provider+model (does not throw)', () => {
    // Cast to satisfy the type — simulates a consumer passing an unrecognised provider at runtime
    expect(getModelCapabilities('anthropic', 'completely-unknown-model-xyz')).toBeNull();
  });

  // ── versionedAt sentinel ─────────────────────────────────────────────────

  it('CAPABILITIES_VERSIONED_AT is a valid ISO date string', () => {
    expect(CAPABILITIES_VERSIONED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(CAPABILITIES_VERSIONED_AT).getTime()).not.toBeNaN();
  });

  // ── mediaInput capabilities (v4.2.0) ──────────────────────────────────────

  it('Anthropic claude-sonnet-4-6: full media support', () => {
    const caps = getModelCapabilities('anthropic', 'claude-sonnet-4-6');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.mediaInput.image.base64).toBe(true);
    expect(c.mediaInput.image.url).toBe(true);
    expect(c.mediaInput.document.pdfBase64).toBe(true);
  });

  it('Anthropic claude-haiku-3: no media support', () => {
    const caps = getModelCapabilities('anthropic', 'claude-haiku-3');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.mediaInput.image.base64).toBe(false);
    expect(c.mediaInput.image.url).toBe(false);
    expect(c.mediaInput.document.pdfBase64).toBe(false);
  });

  it('OpenAI gpt-4.1: full media support', () => {
    const caps = getModelCapabilities('openai', 'gpt-4.1');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.mediaInput.image.base64).toBe(true);
    expect(c.mediaInput.image.url).toBe(true);
    expect(c.mediaInput.document.pdfBase64).toBe(true);
  });

  it('Gemini gemini-2.5-flash: base64 yes, URL no', () => {
    const caps = getModelCapabilities('gemini', 'gemini-2.5-flash');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.mediaInput.image.base64).toBe(true);
    expect(c.mediaInput.image.url).toBe(false);
    expect(c.mediaInput.document.pdfBase64).toBe(true);
  });

  it('Perplexity sonar-pro: no media support (smoke deferred)', () => {
    const caps = getModelCapabilities('perplexity', 'sonar-pro');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.mediaInput.image.base64).toBe(false);
    expect(c.mediaInput.image.url).toBe(false);
    expect(c.mediaInput.document.pdfBase64).toBe(false);
  });

  it('DeepSeek deepseek-v4-flash: no media support', () => {
    const caps = getModelCapabilities('deepseek', 'deepseek-v4-flash');
    expect(caps).not.toBeNull();
    const c = caps as ModelCapabilities;
    expect(c.mediaInput.image.base64).toBe(false);
    expect(c.mediaInput.image.url).toBe(false);
    expect(c.mediaInput.document.pdfBase64).toBe(false);
  });

  // ── reasoningEffort (v6.3.0) — new claude-opus-5 / GPT-5.6 rows ───────────

  describe('reasoningEffort — new model rows', () => {
    it('claude-opus-5 (anthropic): anthropic-effort, verified capability figures', () => {
      const caps = getModelCapabilities('anthropic', 'claude-opus-5');
      expect(caps).not.toBeNull();
      const c = caps as ModelCapabilities;
      expect(c.contextWindow).toBe(1_000_000);
      expect(c.maxOutputTokens).toBe(128_000);
      expect(c.reasoningEffort).toBe('anthropic-effort');
    });

    it.each(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const)(
      '%s (openai): openai-effort, verified capability figures',
      (model) => {
        const caps = getModelCapabilities('openai', model);
        expect(caps).not.toBeNull();
        const c = caps as ModelCapabilities;
        expect(c.contextWindow).toBe(1_000_000);
        expect(c.maxOutputTokens).toBe(128_000);
        expect(c.reasoningEffort).toBe('openai-effort');
      }
    );
  });

  // ── reasoningEffort (v6.4.0) — gpt-5.4-pro/nano + gemini-3.5-flash-lite/3.6-flash ──

  describe('reasoningEffort — gpt-5.4-pro/nano + gemini-3.5-flash-lite/3.6-flash rows', () => {
    it('gpt-5.4-nano (openai): openai-effort, verified capability figures', () => {
      const caps = getModelCapabilities('openai', 'gpt-5.4-nano');
      expect(caps).not.toBeNull();
      const c = caps as ModelCapabilities;
      expect(c.contextWindow).toBe(400_000);
      expect(c.maxOutputTokens).toBe(128_000);
      expect(c.reasoningEffort).toBe('openai-effort');
    });

    it('gpt-5.4-pro (openai): openai-effort, verified capability figures', () => {
      const caps = getModelCapabilities('openai', 'gpt-5.4-pro');
      expect(caps).not.toBeNull();
      const c = caps as ModelCapabilities;
      expect(c.contextWindow).toBe(1_000_000);
      expect(c.maxOutputTokens).toBe(128_000);
      expect(c.reasoningEffort).toBe('openai-effort');
    });

    it.each(['gemini-3.5-flash-lite', 'gemini-3.6-flash'] as const)(
      '%s (gemini): gemini-thinking-level, verified capability figures',
      (model) => {
        const caps = getModelCapabilities('gemini', model);
        expect(caps).not.toBeNull();
        const c = caps as ModelCapabilities;
        expect(c.contextWindow).toBe(1_048_576);
        expect(c.maxOutputTokens).toBe(65_536);
        expect(c.mediaInput.image.base64).toBe(true);
        expect(c.mediaInput.image.url).toBe(false);
        expect(c.mediaInput.document.pdfBase64).toBe(true);
        expect(c.reasoningEffort).toBe('gemini-thinking-level');
      }
    );
  });

  // ── reasoningEffort (v6.5.0) — claude-fable-5/opus-4-8/sonnet-5 rows ──────

  describe('reasoningEffort — claude-fable-5/opus-4-8/sonnet-5 rows', () => {
    it.each(['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5'] as const)(
      '%s (anthropic): anthropic-effort, verified capability figures',
      (model) => {
        const caps = getModelCapabilities('anthropic', model);
        expect(caps).not.toBeNull();
        const c = caps as ModelCapabilities;
        expect(c.contextWindow).toBe(1_000_000);
        expect(c.maxOutputTokens).toBe(128_000);
        expect(c.mediaInput.image.base64).toBe(true);
        expect(c.mediaInput.image.url).toBe(true);
        expect(c.mediaInput.document.pdfBase64).toBe(true);
        expect(c.reasoningEffort).toBe('anthropic-effort');
      }
    );
  });

  // ── reasoningEffort — null default across every Perplexity/DeepSeek row ───

  describe('reasoningEffort — null across all Perplexity/DeepSeek rows', () => {
    it.each([
      ['perplexity', 'sonar'],
      ['perplexity', 'sonar-pro'],
      ['perplexity', 'sonar-reasoning-pro'],
      ['perplexity', 'sonar-deep-research'],
      ['deepseek', 'deepseek-v4-flash'],
      ['deepseek', 'deepseek-v4-pro'],
    ] as const)(
      '%s/%s has reasoningEffort: null (no comparable API parameter)',
      (provider, model) => {
        const caps = getModelCapabilities(provider, model);
        expect(caps).not.toBeNull();
        expect((caps as ModelCapabilities).reasoningEffort).toBeNull();
      }
    );
  });

  // ── DeepSeek retired model IDs (2026-08-18) ───────────────────────────────
  // deepseek-chat / deepseek-reasoner were removed from the capability table when
  // DeepSeek retired both IDs on 2026-07-24. They must resolve as unknown models
  // (null) rather than live, routable capability entries — the client-side rejection
  // that stops calls to these IDs lives in providers/deepseek.ts, not this lookup.
  describe('DeepSeek retired model IDs — absent from the capability table', () => {
    it.each(['deepseek-chat', 'deepseek-reasoner'] as const)(
      'getModelCapabilities("deepseek", "%s") returns null',
      (model) => {
        expect(getModelCapabilities('deepseek', model)).toBeNull();
      }
    );
  });
});
