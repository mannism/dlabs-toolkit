/**
 * Unit tests for client.ts — createClient and createClientFromEnv.
 *
 * Test coverage:
 * - createClient: dispatches to the correct provider for all four implemented providers
 * - createClient: stub provider (perplexity) throws "not yet implemented"
 * - createClientFromEnv: reads correct env var per provider
 * - createClientFromEnv: throws LlmError when env var is missing
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, createClientFromEnv } from './client.js';
import { LlmError } from './types.js';

// Mock all four implemented provider modules to avoid real SDK initialisation.
// vi.mock is hoisted to the top of the file — factories cannot reference local variables.
vi.mock('./providers/anthropic.js', () => ({
  createAnthropicProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
  })),
}));

vi.mock('./providers/openai.js', () => ({
  createOpenAIProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
  })),
}));

vi.mock('./providers/gemini.js', () => ({
  createGeminiProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
  })),
}));

vi.mock('./providers/deepseek.js', () => ({
  createDeepSeekProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
  })),
}));

// We do NOT mock stubs.ts — we test that perplexity throws at runtime

describe('createClient', () => {
  it('returns an object with LlmClient shape for anthropic', () => {
    const client = createClient({
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
    expect(typeof client.stream).toBe('function');
    expect(typeof client.structured).toBe('function');
  });

  it('returns an object with LlmClient shape for openai', () => {
    const client = createClient({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
  });

  it('returns an object with LlmClient shape for gemini', () => {
    const client = createClient({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
    expect(typeof client.stream).toBe('function');
    expect(typeof client.structured).toBe('function');
  });

  it('returns an object with LlmClient shape for deepseek', () => {
    const client = createClient({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
    expect(typeof client.stream).toBe('function');
    expect(typeof client.structured).toBe('function');
  });

  it('returns an object with LlmClient shape for perplexity (fully implemented)', () => {
    // Perplexity was a stub until Week 5. It is now fully implemented.
    // Verify the factory returns a real client object (not a stub that throws on config access).
    const client = createClient({ provider: 'perplexity', model: 'sonar', apiKey: 'test-key' });
    expect(typeof client.complete).toBe('function');
    expect(typeof client.stream).toBe('function');
    expect(typeof client.structured).toBe('function');
    // config accessor must not throw — real provider, not a stub
    expect(client.config.provider).toBe('perplexity');
    expect(client.config.model).toBe('sonar');
  });
});

describe('createClientFromEnv', () => {
  const originalEnv = process.env;

  // setTestEnv uses bracket notation to satisfy noPropertyAccessFromIndexSignature.
  // process.env is an index-signature type; the tsconfig rule blocks dot notation on it.
  function setTestEnv(key: string, value: string | undefined): void {
    (process.env as NodeJS.ProcessEnv)[key] = value;
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads ANTHROPIC_API_KEY for anthropic provider', () => {
    setTestEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const client = createClientFromEnv('anthropic', 'claude-3-haiku-20240307');
    expect(client).toBeDefined();
  });

  it('reads OPENAI_API_KEY for openai provider', () => {
    setTestEnv('OPENAI_API_KEY', 'sk-openai-test');
    const client = createClientFromEnv('openai', 'gpt-4o-mini');
    expect(client).toBeDefined();
  });

  it('throws LlmError when ANTHROPIC_API_KEY is not set', () => {
    setTestEnv('ANTHROPIC_API_KEY', undefined);
    expect(() => createClientFromEnv('anthropic', 'claude-3-haiku-20240307')).toThrow(LlmError);
  });

  it('throws LlmError when OPENAI_API_KEY is empty string', () => {
    setTestEnv('OPENAI_API_KEY', '   ');
    expect(() => createClientFromEnv('openai', 'gpt-4o-mini')).toThrow(LlmError);
  });

  it('includes the env var name in the error message', () => {
    setTestEnv('ANTHROPIC_API_KEY', undefined);
    let thrown: unknown;
    try {
      createClientFromEnv('anthropic', 'claude-3-haiku-20240307');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.message).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('throws LlmError when GOOGLE_AI_API_KEY is missing', () => {
    setTestEnv('GOOGLE_AI_API_KEY', undefined);
    // Throws on env resolution, before calling the provider
    expect(() => createClientFromEnv('gemini', 'gemini-2.0-flash')).toThrow(LlmError);
  });

  it('throws LlmError when DEEPSEEK_API_KEY is missing', () => {
    setTestEnv('DEEPSEEK_API_KEY', undefined);
    expect(() => createClientFromEnv('deepseek', 'deepseek-chat')).toThrow(LlmError);
  });

  it('reads GOOGLE_AI_API_KEY for gemini provider', () => {
    setTestEnv('GOOGLE_AI_API_KEY', 'aistudio-test-key');
    const client = createClientFromEnv('gemini', 'gemini-2.0-flash');
    expect(client).toBeDefined();
  });

  it('reads DEEPSEEK_API_KEY for deepseek provider', () => {
    setTestEnv('DEEPSEEK_API_KEY', 'sk-deepseek-test');
    const client = createClientFromEnv('deepseek', 'deepseek-chat');
    expect(client).toBeDefined();
  });

  it('applies overrides to the config', () => {
    setTestEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    // Should not throw — overrides are applied on top of resolved env key
    const client = createClientFromEnv('anthropic', 'claude-3-haiku-20240307', {
      maxRetries: 5,
      timeoutMs: 60_000,
    });
    expect(client).toBeDefined();
  });
});
