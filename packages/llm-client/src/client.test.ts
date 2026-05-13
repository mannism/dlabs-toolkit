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

const mockCompleteResponse = {
  content: 'hello',
  model: 'claude-sonnet-4-6',
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  latencyMs: 100,
};

const mockStructuredResponse = {
  data: { answer: 42 },
  model: 'claude-sonnet-4-6',
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  latencyMs: 100,
};

const mockToolResponse = {
  content: '',
  toolCalls: [],
  model: 'claude-sonnet-4-6',
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  latencyMs: 100,
  stopReason: 'end_turn' as const,
};

vi.mock('./providers/anthropic.js', () => ({
  createAnthropicProvider: vi.fn(() => ({
    config: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test' },
    complete: vi.fn().mockResolvedValue(mockCompleteResponse),
    stream: vi.fn(),
    structured: vi.fn().mockResolvedValue(mockStructuredResponse),
    withTools: vi.fn().mockResolvedValue(mockToolResponse),
  })),
}));

vi.mock('./providers/openai.js', () => ({
  createOpenAIProvider: vi.fn(() => ({
    config: { provider: 'openai', model: 'gpt-5.5', apiKey: 'test' },
    complete: vi.fn().mockResolvedValue({ ...mockCompleteResponse, model: 'gpt-5.5' }),
    stream: vi.fn(),
    structured: vi.fn().mockResolvedValue({ ...mockStructuredResponse, model: 'gpt-5.5' }),
    withTools: vi.fn().mockResolvedValue({ ...mockToolResponse, model: 'gpt-5.5' }),
  })),
}));

vi.mock('./providers/gemini.js', () => ({
  createGeminiProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
    withTools: vi.fn(),
  })),
}));

vi.mock('./providers/deepseek.js', () => ({
  createDeepSeekProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
    withTools: vi.fn(),
  })),
}));

// Mock @diabolicallabs/llm-pricing for the pricing integration tests.
vi.mock('@diabolicallabs/llm-pricing', () => ({
  computeCost: vi.fn(
    ({
      usage,
      provider,
      model,
    }: {
      usage: { inputTokens: number; outputTokens: number };
      provider: string;
      model: string;
    }) => ({
      input: (usage.inputTokens / 1_000_000) * 3.0,
      output: (usage.outputTokens / 1_000_000) * 15.0,
      cacheRead: 0,
      cacheWrite: 0,
      total: (usage.inputTokens / 1_000_000) * 3.0 + (usage.outputTokens / 1_000_000) * 15.0,
      currency: 'USD' as const,
      isPartial: false,
      _provider: provider,
      _model: model,
    })
  ),
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

// ---------------------------------------------------------------------------
// Pricing integration (v1.1.0)
// ---------------------------------------------------------------------------

describe('createClient — pricing integration', () => {
  it('pricing off: cost is undefined on complete() response', async () => {
    const client = createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      // no pricing config
    });
    const response = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(response.cost).toBeUndefined();
  });

  it('pricing on: cost is attached to complete() response', async () => {
    const client = createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      pricing: { computeOnEveryCall: true },
    });
    const response = await client.complete([{ role: 'user', content: 'hi' }]);
    // cost is defined when pricing is configured
    expect(response.cost).toBeDefined();
    expect(response.cost?.currency).toBe('USD');
    expect(typeof response.cost?.total).toBe('number');
    expect(response.cost?.isPartial).toBe(false);
  });

  it('pricing on: cost is attached to structured() response', async () => {
    const client = createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      pricing: { computeOnEveryCall: true },
    });
    const schema = { parse: (d: unknown) => d as { answer: number } };
    const response = await client.structured([{ role: 'user', content: 'hi' }], schema);
    expect(response.cost).toBeDefined();
    expect(response.cost?.currency).toBe('USD');
  });

  it('pricing on: cost is attached to withTools() response', async () => {
    const client = createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      pricing: { computeOnEveryCall: true },
    });
    const response = await client.withTools([{ role: 'user', content: 'hi' }], []);
    expect(response.cost).toBeDefined();
    expect(response.cost?.currency).toBe('USD');
  });

  it('pricing on: cost math matches expected values for 100k in + 50k out at $3/$15 per 1M', async () => {
    const client = createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      pricing: { computeOnEveryCall: true },
    });
    const response = await client.complete([{ role: 'user', content: 'hi' }]);
    // mockCompleteResponse: 100k input, 50k output
    // Mock computeCost: input = 100000/1M × $3 = $0.0003; output = 50000/1M × $15 = $0.00075
    expect(response.cost?.input).toBeCloseTo(0.0003, 6);
    expect(response.cost?.output).toBeCloseTo(0.00075, 6);
    expect(response.cost?.total).toBeCloseTo(0.00105, 6);
  });
});
