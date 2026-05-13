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
});
