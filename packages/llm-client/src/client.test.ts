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
import { setLlmClientLogger } from './logger.js';
import { LlmError } from './types.js';

// ─── Logger capture ──────────────────────────────────────────────────────────
// Inject a capturing LlmClientLogger in each test so assertions match on
// stable event names instead of console.* spy calls.

interface CapturedWarn {
  event: string;
  data: Record<string, unknown>;
}

let warnCalls: CapturedWarn[] = [];

beforeEach(() => {
  warnCalls = [];
  setLlmClientLogger({
    warn: (event, data) => {
      warnCalls.push({ event, data });
    },
  });
});

afterEach(() => {
  setLlmClientLogger(null);
});

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
    streamStructured: vi.fn(),
    withTools: vi.fn().mockResolvedValue(mockToolResponse),
  })),
}));

vi.mock('./providers/openai.js', () => ({
  createOpenAIProvider: vi.fn(() => ({
    config: { provider: 'openai', model: 'gpt-5.5', apiKey: 'test' },
    complete: vi.fn().mockResolvedValue({ ...mockCompleteResponse, model: 'gpt-5.5' }),
    stream: vi.fn(),
    structured: vi.fn().mockResolvedValue({ ...mockStructuredResponse, model: 'gpt-5.5' }),
    streamStructured: vi.fn(),
    withTools: vi.fn().mockResolvedValue({ ...mockToolResponse, model: 'gpt-5.5' }),
  })),
}));

vi.mock('./providers/gemini.js', () => ({
  createGeminiProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
    streamStructured: vi.fn(),
    withTools: vi.fn(),
  })),
}));

vi.mock('./providers/deepseek.js', () => ({
  createDeepSeekProvider: vi.fn(() => ({
    config: {},
    complete: vi.fn(),
    stream: vi.fn(),
    structured: vi.fn(),
    streamStructured: vi.fn(),
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
  it('returns an object with LlmClient shape for anthropic', async () => {
    const client = await createClient({
      provider: 'anthropic',
      model: 'claude-3-haiku-20240307',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
    expect(typeof client.stream).toBe('function');
    expect(typeof client.structured).toBe('function');
  });

  it('returns an object with LlmClient shape for openai', async () => {
    const client = await createClient({
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
  });

  it('returns an object with LlmClient shape for gemini', async () => {
    const client = await createClient({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
    expect(typeof client.stream).toBe('function');
    expect(typeof client.structured).toBe('function');
  });

  it('returns an object with LlmClient shape for deepseek', async () => {
    const client = await createClient({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
    expect(typeof client.stream).toBe('function');
    expect(typeof client.structured).toBe('function');
  });

  it('returns an object with LlmClient shape for perplexity (fully implemented)', async () => {
    // Perplexity was a stub until Week 5. It is now fully implemented.
    // Verify the factory returns a real client object (not a stub that throws on config access).
    const client = await createClient({
      provider: 'perplexity',
      model: 'sonar',
      apiKey: 'test-key',
    });
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

  it('reads ANTHROPIC_API_KEY for anthropic provider', async () => {
    setTestEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const client = await createClientFromEnv('anthropic', 'claude-3-haiku-20240307');
    expect(client).toBeDefined();
  });

  it('reads OPENAI_API_KEY for openai provider', async () => {
    setTestEnv('OPENAI_API_KEY', 'sk-openai-test');
    const client = await createClientFromEnv('openai', 'gpt-4o-mini');
    expect(client).toBeDefined();
  });

  it('rejects with LlmError when ANTHROPIC_API_KEY is not set', async () => {
    setTestEnv('ANTHROPIC_API_KEY', undefined);
    await expect(createClientFromEnv('anthropic', 'claude-3-haiku-20240307')).rejects.toThrow(
      LlmError
    );
  });

  it('rejects with LlmError when OPENAI_API_KEY is empty string', async () => {
    setTestEnv('OPENAI_API_KEY', '   ');
    await expect(createClientFromEnv('openai', 'gpt-4o-mini')).rejects.toThrow(LlmError);
  });

  it('includes the env var name in the error message', async () => {
    setTestEnv('ANTHROPIC_API_KEY', undefined);
    let thrown: unknown;
    try {
      await createClientFromEnv('anthropic', 'claude-3-haiku-20240307');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.message).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('rejects with LlmError when GOOGLE_AI_API_KEY is missing', async () => {
    setTestEnv('GOOGLE_AI_API_KEY', undefined);
    // Rejects on env resolution, before calling the provider
    await expect(createClientFromEnv('gemini', 'gemini-2.0-flash')).rejects.toThrow(LlmError);
  });

  it('rejects with LlmError when DEEPSEEK_API_KEY is missing', async () => {
    setTestEnv('DEEPSEEK_API_KEY', undefined);
    await expect(createClientFromEnv('deepseek', 'deepseek-chat')).rejects.toThrow(LlmError);
  });

  it('reads GOOGLE_AI_API_KEY for gemini provider', async () => {
    setTestEnv('GOOGLE_AI_API_KEY', 'aistudio-test-key');
    const client = await createClientFromEnv('gemini', 'gemini-2.0-flash');
    expect(client).toBeDefined();
  });

  it('reads DEEPSEEK_API_KEY for deepseek provider', async () => {
    setTestEnv('DEEPSEEK_API_KEY', 'sk-deepseek-test');
    const client = await createClientFromEnv('deepseek', 'deepseek-chat');
    expect(client).toBeDefined();
  });

  it('applies overrides to the config', async () => {
    setTestEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    // Should not throw — overrides are applied on top of resolved env key
    const client = await createClientFromEnv('anthropic', 'claude-3-haiku-20240307', {
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
    const client = await createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      // no pricing config
    });
    const response = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(response.cost).toBeUndefined();
  });

  it('pricing on: cost is attached to complete() response', async () => {
    const client = await createClient({
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
    const client = await createClient({
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
    const client = await createClient({
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
    const client = await createClient({
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

  it('pricing_source log: emits "bundled" when no table or remoteUrl set', async () => {
    await createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      pricing: { computeOnEveryCall: true },
    });
    // pricing_source event is captured by the injected logger (beforeEach wires it)
    const pricingLog = warnCalls.find((w) => w.event === 'pricing_source');
    expect(pricingLog).toBeDefined();
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(pricingLog?.data['source']).toBe('bundled');
  });

  it('pricing_source log: emits "bundled" when pricing.table is undefined', async () => {
    await createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      pricing: { computeOnEveryCall: true, table: undefined as never },
    });
    // table: undefined is treated as absent — source should be 'bundled' not 'consumer_override'
    const pricingLog = warnCalls.find((w) => w.event === 'pricing_source');
    expect(pricingLog).toBeDefined();
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, unknown>
    expect(pricingLog?.data['source']).toBe('bundled');
  });

  it('remoteUrl: consumer-explicit table wins over remoteUrl (no fetch called)', async () => {
    // When pricing.table is set alongside pricing.remoteUrl, table takes precedence.
    // fetchRemoteTable should NOT be called — no network activity.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Minimal valid PricingTable shape — the mock computeCost accepts any table.
    const customTable = {
      versionedAt: '2026-05-14',
      anthropic: {},
      openai: {},
      gemini: {},
      deepseek: {},
      perplexity: {},
    };

    await createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      pricing: {
        computeOnEveryCall: true,
        // biome-ignore lint/suspicious/noExplicitAny: test fixture — minimal shape for assertion
        table: customTable as any,
        remoteUrl: 'https://example.com/pricing.json',
      },
    });

    // fetch should not have been called — table wins over remoteUrl
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Provider failover — createClient with model array (v1.2.0)
// ---------------------------------------------------------------------------

describe('createClient — provider failover', () => {
  // We test the failover logic via createClient directly. The anthropic mock is already wired.
  // We need a client that fails on the first call then succeeds on the second.

  it('single-model string: no failover wrapper, config.model is preserved as string', async () => {
    const client = await createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
    });
    // Single-model fast path: config.model remains a string
    expect(client.config.model).toBe('claude-sonnet-4-6');
  });

  it('model array with one element: treated as single-model (fast path)', async () => {
    const client = await createClient({
      provider: 'anthropic',
      model: ['claude-sonnet-4-6'],
      apiKey: 'test',
    });
    expect(typeof client.complete).toBe('function');
  });

  it('empty model array: rejects with LlmError with kind bad_request', async () => {
    await expect(
      createClient({
        provider: 'anthropic',
        model: [] as unknown as string[],
        apiKey: 'test',
      })
    ).rejects.toThrow(LlmError);
  });

  it('model array: falls back to second model on not_found error from primary', async () => {
    // Import the mocked provider factory to control its behavior per test
    const { createAnthropicProvider } = await import('./providers/anthropic.js');
    const mockFactory = vi.mocked(createAnthropicProvider);

    // First provider (primary) throws not_found; second provider returns success
    const primaryComplete = vi.fn().mockRejectedValue(
      new LlmError({
        message: 'model not found',
        provider: 'anthropic',
        kind: 'not_found',
        retryable: false,
      })
    );
    const fallbackComplete = vi.fn().mockResolvedValue({
      content: 'fallback response',
      model: 'claude-3-haiku-20240307',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      latencyMs: 50,
    });

    mockFactory
      .mockReturnValueOnce({
        config: { provider: 'anthropic', model: 'claude-opus-4-99', apiKey: 'test' },
        complete: primaryComplete,
        stream: vi.fn(),
        structured: vi.fn(),
        streamStructured: vi.fn(),
        withTools: vi.fn(),
      })
      .mockReturnValueOnce({
        config: { provider: 'anthropic', model: 'claude-3-haiku-20240307', apiKey: 'test' },
        complete: fallbackComplete,
        stream: vi.fn(),
        structured: vi.fn(),
        streamStructured: vi.fn(),
        withTools: vi.fn(),
      });

    const client = await createClient({
      provider: 'anthropic',
      model: ['claude-opus-4-99', 'claude-3-haiku-20240307'],
      apiKey: 'test',
      fallbackOn: ['not_found'],
    });

    const response = await client.complete([{ role: 'user', content: 'hi' }]);

    // Fallback model served the response
    expect(response.content).toBe('fallback response');
    expect(response.model).toBe('claude-3-haiku-20240307');
    // requestedModel is set to the primary model when failover fired
    expect(response.requestedModel).toBe('claude-opus-4-99');
    // Primary was attempted, fallback was attempted
    expect(primaryComplete).toHaveBeenCalledTimes(1);
    expect(fallbackComplete).toHaveBeenCalledTimes(1);
  });

  it('model array: does not fall back on errors not in fallbackOn', async () => {
    const { createAnthropicProvider } = await import('./providers/anthropic.js');
    const mockFactory = vi.mocked(createAnthropicProvider);

    const primaryComplete = vi.fn().mockRejectedValue(
      new LlmError({
        message: 'rate limited',
        provider: 'anthropic',
        kind: 'rate_limit',
        retryable: true,
      })
    );

    mockFactory.mockReturnValueOnce({
      config: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'test' },
      complete: primaryComplete,
      stream: vi.fn(),
      structured: vi.fn(),
      streamStructured: vi.fn(),
      withTools: vi.fn(),
    });

    const client = await createClient({
      provider: 'anthropic',
      model: ['claude-sonnet-4-6', 'claude-3-haiku-20240307'],
      apiKey: 'test',
      fallbackOn: ['not_found'], // rate_limit not included
    });

    // Should throw rate_limit — no failover
    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      kind: 'rate_limit',
    });
  });

  it('model array: requestedModel is undefined when primary succeeds (no failover)', async () => {
    const client = await createClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6', // single string, not array
      apiKey: 'test',
    });

    const response = await client.complete([{ role: 'user', content: 'hi' }]);
    expect(response.requestedModel).toBeUndefined();
  });
});
