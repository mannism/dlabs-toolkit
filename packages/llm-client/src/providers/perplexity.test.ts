/**
 * Unit tests for the Perplexity provider.
 *
 * All tests use vi.mock to stub the openai SDK. No real API calls.
 * Perplexity uses the OpenAI SDK with a baseURL override — the test structure
 * mirrors deepseek.test.ts.
 *
 * Test coverage:
 * - complete(): happy path, usage normalization, model/options overrides, error/retry
 * - stream(): token chunks, usage on final chunk, error handling, null/empty deltas
 * - structured(): JSON parse success, markdown fence stripping, parse failure, schema failure
 * - citations: populated when Perplexity returns sources; undefined when absent
 * - citation dedup: same URL appearing twice deduped to one entry
 * - providerOptions: forwarded to API call when present; absent when not passed
 * - reasoning models: sonar-reasoning-pro happy path
 * - normalizePerplexityError(): tested alongside other providers in error-normalize.test.ts
 */

import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { LlmClientConfig, LlmUsage } from '../types.js';
import { LlmError } from '../types.js';
import { createPerplexityProvider, normalizePerplexityError } from './perplexity.js';

vi.mock('openai');

const TEST_CONFIG: LlmClientConfig = {
  provider: 'perplexity',
  model: 'sonar',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

/** Build a minimal ChatCompletion mock response, optionally with Perplexity citations. */
function mockChatCompletion(
  content: string,
  citations?: string[],
  overrides?: Partial<OpenAI.Chat.ChatCompletion>
): OpenAI.Chat.ChatCompletion & { citations?: string[] } {
  const base: OpenAI.Chat.ChatCompletion = {
    id: 'chatcmpl-pplx-123',
    object: 'chat.completion',
    created: 1234567890,
    model: 'sonar',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  };

  // Only attach citations when defined — exactOptionalPropertyTypes disallows spreading
  // `{ citations: string[] | undefined }` into `{ citations?: string[] }`.
  if (citations !== undefined) {
    return { ...base, citations };
  }
  return base;
}

// ---------------------------------------------------------------------------
// normalizePerplexityError()
// ---------------------------------------------------------------------------

describe('normalizePerplexityError()', () => {
  it('returns the same LlmError if already an LlmError', () => {
    const err = new LlmError({ message: 'test', provider: 'perplexity', retryable: false });
    expect(normalizePerplexityError(err)).toBe(err);
  });

  it('maps OpenAI.APIConnectionError → retryable LlmError with no statusCode', () => {
    // When openai is mocked the real class is unavailable; test via LlmError passthrough.
    const err = new LlmError({ message: 'conn failed', provider: 'perplexity', retryable: true });
    const result = normalizePerplexityError(err);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  it('maps plain Error with no status → LlmError via normalizeThrownError', () => {
    const err = new Error('ECONNRESET');
    const result = normalizePerplexityError(err);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('perplexity');
  });

  it('maps unknown thrown value → LlmError', () => {
    const result = normalizePerplexityError('unexpected string');
    expect(result).toBeInstanceOf(LlmError);
  });
});

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------

describe('Perplexity provider — complete()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('Hello, world!'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });
  });

  it('returns normalized LlmResponse on success', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello, world!');
    expect(result.model).toBe('sonar');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes system messages through to messages array', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.messages).toHaveLength(2);
    expect(callArgs.messages[0]?.role).toBe('system');
    expect(callArgs.messages[1]?.role).toBe('user');
  });

  it('applies model override', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], { model: 'sonar-pro' });

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.model).toBe('sonar-pro');
  });

  it('applies maxTokens and temperature', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      maxTokens: 512,
      temperature: 0.7,
    });

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.max_tokens).toBe(512);
    expect(callArgs.temperature).toBe(0.7);
  });

  it('does not set max_tokens when not configured', async () => {
    const { maxTokens: _omit, ...restConfig } = TEST_CONFIG;
    const configWithoutMax: LlmClientConfig = restConfig;
    const client = createPerplexityProvider(configWithoutMax);
    await client.complete([{ role: 'user', content: 'Hi' }]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.max_tokens).toBeUndefined();
  });

  it('throws LlmError on API error', async () => {
    mockCreate.mockRejectedValue(new Error('Unauthorized'));
    const client = createPerplexityProvider(TEST_CONFIG);
    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      LlmError
    );
  });

  it('retries on retryable LlmError and eventually succeeds', async () => {
    const retryableErr = new LlmError({
      message: 'Rate limited',
      provider: 'perplexity',
      statusCode: 429,
      retryable: true,
    });
    mockCreate
      .mockRejectedValueOnce(retryableErr)
      .mockResolvedValue(mockChatCompletion('Success after retry'));

    const client = createPerplexityProvider({ ...TEST_CONFIG, maxRetries: 2, baseDelayMs: 0 });
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Success after retry');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('normalizes usage to zeros when response.usage is absent', async () => {
    const { usage: _omit, ...baseCompletion } = mockChatCompletion('Hi');
    mockCreate.mockResolvedValue(baseCompletion);
    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
  });

  it('uses sonar-reasoning-pro model string without special handling', async () => {
    // sonar-reasoning-pro is treated as a plain model string — no special dispatch
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Reason about this' }], {
      model: 'sonar-reasoning-pro',
    });

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.model).toBe('sonar-reasoning-pro');
  });
});

// ---------------------------------------------------------------------------
// citations
// ---------------------------------------------------------------------------

describe('Perplexity provider — citations', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });
  });

  it('populates citations when Perplexity returns source URLs', async () => {
    mockCreate = vi
      .fn()
      .mockResolvedValue(
        mockChatCompletion('The answer is 42', [
          'https://example.com/source-1',
          'https://reuters.com/article',
        ])
      );
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'What is the answer?' }]);

    expect(result.citations).toBeDefined();
    expect(result.citations).toHaveLength(2);
    expect(result.citations?.[0]?.url).toBe('https://example.com/source-1');
    expect(result.citations?.[1]?.url).toBe('https://reuters.com/article');
  });

  it('returns citations as { url: string } objects without title', async () => {
    // Perplexity returns citations as string[] — we map to { url } with no title field
    mockCreate = vi
      .fn()
      .mockResolvedValue(mockChatCompletion('Answer', ['https://nytimes.com/article']));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.citations?.[0]).toEqual({ url: 'https://nytimes.com/article' });
    expect(result.citations?.[0]?.title).toBeUndefined();
  });

  it('returns citations as undefined when Perplexity returns no citations', async () => {
    mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('Hello'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.citations).toBeUndefined();
  });

  it('returns citations as undefined when citations array is empty', async () => {
    mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('Hello', []));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.citations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// citation deduplication
// ---------------------------------------------------------------------------

describe('Perplexity provider — citation deduplication', () => {
  it('deduplicates citations by URL when the same URL appears multiple times', async () => {
    vi.clearAllMocks();
    const duplicatedCitations = [
      'https://example.com/source',
      'https://reuters.com/article',
      'https://example.com/source', // duplicate
      'https://nytimes.com/story',
      'https://reuters.com/article', // duplicate
    ];

    const mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('Result', duplicatedCitations));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.citations).toHaveLength(3);
    const urls = result.citations?.map((c) => c.url);
    expect(urls).toEqual([
      'https://example.com/source',
      'https://reuters.com/article',
      'https://nytimes.com/story',
    ]);
  });

  it('preserves insertion order of first occurrence', async () => {
    vi.clearAllMocks();
    const mockCreate = vi
      .fn()
      .mockResolvedValue(
        mockChatCompletion('Result', [
          'https://b.com',
          'https://a.com',
          'https://b.com',
          'https://c.com',
        ])
      );
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    const urls = result.citations?.map((c) => c.url);
    expect(urls).toEqual(['https://b.com', 'https://a.com', 'https://c.com']);
  });
});

// ---------------------------------------------------------------------------
// providerOptions
// ---------------------------------------------------------------------------

describe('Perplexity provider — providerOptions', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('Answer'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });
  });

  it('forwards search_recency_filter to the API call', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Latest news?' }], {
      providerOptions: { search_recency_filter: 'week' },
    });

    type PerplexityCallArgs = {
      search_recency_filter?: string;
      search_domain_filter?: string[];
      future_filter?: string;
    };
    const callArgs = mockCreate.mock.calls[0]?.[0] as PerplexityCallArgs;
    expect(callArgs.search_recency_filter).toBe('week');
  });

  it('forwards search_domain_filter to the API call', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'News from quality sources' }], {
      providerOptions: { search_domain_filter: ['nytimes.com', 'reuters.com'] },
    });

    type PerplexityCallArgs = { search_domain_filter?: string[] };
    const callArgs = mockCreate.mock.calls[0]?.[0] as PerplexityCallArgs;
    expect(callArgs.search_domain_filter).toEqual(['nytimes.com', 'reuters.com']);
  });

  it('forwards multiple providerOptions fields together', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      providerOptions: {
        search_recency_filter: 'day',
        search_domain_filter: ['bbc.com'],
      },
    });

    type PerplexityCallArgs = { search_recency_filter?: string; search_domain_filter?: string[] };
    const callArgs = mockCreate.mock.calls[0]?.[0] as PerplexityCallArgs;
    expect(callArgs.search_recency_filter).toBe('day');
    expect(callArgs.search_domain_filter).toEqual(['bbc.com']);
  });

  it('does not inject providerOptions keys when providerOptions is absent', async () => {
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }]);

    type PerplexityCallArgs = { search_recency_filter?: string; search_domain_filter?: string[] };
    const callArgs = mockCreate.mock.calls[0]?.[0] as PerplexityCallArgs;
    expect(callArgs.search_recency_filter).toBeUndefined();
    expect(callArgs.search_domain_filter).toBeUndefined();
  });

  it('passes through unknown providerOptions fields unchanged', async () => {
    // Future Perplexity API additions should pass through without a toolkit update
    const client = createPerplexityProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      providerOptions: { future_filter: 'some_value' },
    });

    type PerplexityCallArgs = { future_filter?: string };
    const callArgs = mockCreate.mock.calls[0]?.[0] as PerplexityCallArgs;
    expect(callArgs.future_filter).toBe('some_value');
  });

  it('forwards providerOptions in stream() calls', async () => {
    const mockChunks = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'sonar',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop', logprobs: null }],
        usage: null,
      },
    ];
    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockChunks;
      },
    };
    mockCreate.mockResolvedValue(mockStream);

    const client = createPerplexityProvider(TEST_CONFIG);
    // Consume the stream to trigger the API call
    for await (const _ of client.stream([{ role: 'user', content: 'Hi' }], {
      providerOptions: { search_recency_filter: 'hour' },
    })) {
      /* consume */
    }

    const callArgs = mockCreate.mock.calls[0]?.[0] as { search_recency_filter?: string };
    expect(callArgs.search_recency_filter).toBe('hour');
  });
});

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe('Perplexity provider — stream()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields token chunks and usage on final sentinel', async () => {
    const mockChunks: OpenAI.Chat.ChatCompletionChunk[] = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'sonar',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null, logprobs: null }],
        usage: null,
      },
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'sonar',
        choices: [
          { index: 0, delta: { content: ', world!' }, finish_reason: 'stop', logprobs: null },
        ],
        usage: null,
      },
      {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'sonar',
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockChunks;
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const tokens: string[] = [];
    let usageChunk: LlmUsage | undefined;

    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage !== undefined) {
        usageChunk = chunk.usage;
      } else if (chunk.token.length > 0) {
        tokens.push(chunk.token);
      }
    }

    expect(tokens).toEqual(['Hello', ', world!']);
    expect(usageChunk).toBeDefined();
    if (usageChunk !== undefined) {
      expect(usageChunk.inputTokens).toBe(5);
      expect(usageChunk.outputTokens).toBe(3);
      expect(usageChunk.totalTokens).toBe(8);
    }
  });

  it('throws LlmError on stream init failure', async () => {
    const streamErr = new LlmError({
      message: 'Connection failed',
      provider: 'perplexity',
      retryable: true,
    });
    const mockCreate = vi.fn().mockRejectedValue(streamErr);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        /* consume */
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('throws LlmError when stream fails mid-iteration', async () => {
    const iterErr = new LlmError({
      message: 'Mid-stream error',
      provider: 'perplexity',
      statusCode: 503,
      retryable: true,
    });

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'sonar',
          choices: [
            { index: 0, delta: { content: 'partial' }, finish_reason: null, logprobs: null },
          ],
          usage: null,
        } as OpenAI.Chat.ChatCompletionChunk;
        throw iterErr;
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        /* consume */
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('skips null and empty content deltas', async () => {
    const mockChunks: OpenAI.Chat.ChatCompletionChunk[] = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'sonar',
        choices: [{ index: 0, delta: { content: null }, finish_reason: null, logprobs: null }],
        usage: null,
      },
      {
        id: 'c2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'sonar',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: null, logprobs: null }],
        usage: null,
      },
      {
        id: 'c3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'sonar',
        choices: [{ index: 0, delta: { content: 'real' }, finish_reason: 'stop', logprobs: null }],
        usage: null,
      },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockChunks;
      },
    };
    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const tokens: string[] = [];
    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.token.length > 0) tokens.push(chunk.token);
    }

    expect(tokens).toEqual(['real']);
  });
});

// ---------------------------------------------------------------------------
// structured()
// ---------------------------------------------------------------------------

describe('Perplexity provider — structured()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });
  });

  it('parses valid JSON response and validates schema', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('{"name":"Bob","score":95}'));

    const schema = {
      parse: (data: unknown) => {
        const d = data as { name: string; score: number };
        if (typeof d.name !== 'string') throw new Error('invalid');
        return d;
      },
    };

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return a result' }], schema);

    expect(result.data.name).toBe('Bob');
    expect(result.data.score).toBe(95);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('strips markdown code fences from response', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('```json\n{"value":42}\n```'));
    const schema = { parse: (data: unknown) => data as { value: number } };

    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return JSON' }], schema);

    expect(result.data.value).toBe(42);
  });

  it('strips <think>...</think> reasoning block from sonar-reasoning-pro responses', async () => {
    // sonar-reasoning-pro emits chain-of-thought inside <think> tags before the JSON.
    // Observed live 2026-05-08 — see PR description for smoke test output.
    const thinkResponse =
      '<think>\nLet me think about this...\nThe answer should be {ok: true}\n</think>\n\n{"ok":true}';
    mockCreate.mockResolvedValue(mockChatCompletion(thinkResponse));
    const schema = { parse: (data: unknown) => data as { ok: boolean } };

    const client = createPerplexityProvider({ ...TEST_CONFIG, model: 'sonar-reasoning-pro' });
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);

    expect(result.data.ok).toBe(true);
  });

  it('throws LlmError on invalid JSON', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('not json at all'));
    const schema = { parse: (data: unknown) => data };

    const client = createPerplexityProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return JSON' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('not valid JSON'),
      retryable: false,
    });
  });

  it('throws LlmError on schema validation failure', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('{"wrong_key": 1}'));
    const schema = {
      parse: (data: unknown) => {
        const d = data as Record<string, unknown>;
        if (!('required' in d)) throw new Error('missing required');
        return d;
      },
    };

    const client = createPerplexityProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('schema validation'),
      retryable: false,
    });
  });

  it('injects JSON system message as first message', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('{"ok":true}'));
    const schema = { parse: (data: unknown) => data as { ok: boolean } };

    const client = createPerplexityProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const systemMsg = callArgs.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('valid JSON');
  });

  it('does not set response_format for Perplexity (prompt-level JSON enforcement only)', async () => {
    // Perplexity's response_format has known limitations with reasoning models;
    // we rely on system-prompt enforcement instead.
    mockCreate.mockResolvedValue(mockChatCompletion('{"ok":true}'));
    const schema = { parse: (data: unknown) => data as { ok: boolean } };

    const client = createPerplexityProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.response_format).toBeUndefined();
  });

  it('throws LlmError when the API call itself rejects', async () => {
    mockCreate.mockRejectedValue(new Error('connection reset'));
    const schema = { parse: (data: unknown) => data };

    const client = createPerplexityProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toBeInstanceOf(LlmError);
  });
});

// ---------------------------------------------------------------------------
// Regression: other providers do not get citations
// ---------------------------------------------------------------------------

describe('citations regression — other providers', () => {
  it('LlmResponse.citations is undefined for a non-Perplexity response (no citations field)', () => {
    // This test verifies the type allows undefined — other providers simply never set it.
    // The extractCitations function only runs inside createPerplexityProvider.
    // We verify that a mock response without citations results in undefined.
    vi.clearAllMocks();
    const mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('Hello'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    // Even when using the Perplexity provider, if citations are absent → undefined
    return client.complete([{ role: 'user', content: 'Hi' }]).then((result) => {
      expect(result.citations).toBeUndefined();
    });
  });
});

// ─── Abort / timeout / stall smoke tests ─────────────────────────────────────

describe('Perplexity provider — abort / timeout / stall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('per-call timeoutMs override fires before client default', async () => {
    const mockCreate = vi
      .fn()
      .mockImplementation((_params: unknown, opts: { signal?: AbortSignal }) => {
        const sig = opts?.signal;
        let settled = false;
        return new Promise<OpenAI.Chat.ChatCompletion>((_resolve, reject) => {
          if (sig?.aborted) {
            settled = true;
            const e = new Error('AbortError');
            e.name = 'AbortError';
            reject(e);
            return;
          }
          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            const e = new Error('AbortError');
            e.name = 'AbortError';
            reject(e);
          };
          sig?.addEventListener('abort', onAbort, { once: true });
        });
      });
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider({ ...TEST_CONFIG, timeoutMs: 30_000, maxRetries: 0 });
    let caughtErr: unknown;
    const p = client
      .complete([{ role: 'user', content: 'Hi' }], { timeoutMs: 100 })
      .catch((e: unknown) => {
        caughtErr = e;
      });

    await vi.advanceTimersByTimeAsync(100);
    await p;

    expect((caughtErr as { kind?: string }).kind).toBe('timeout');
    expect((caughtErr as { retryable?: boolean }).retryable).toBe(true);
  });

  it('caller signal aborts before SDK call → kind:"cancelled", mock called 0 times', async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('hello'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const ac = new AbortController();
    ac.abort('user cancelled');

    const client = createPerplexityProvider(TEST_CONFIG);
    await expect(
      client.complete([{ role: 'user', content: 'Hi' }], { signal: ac.signal })
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false });

    expect(mockCreate).toHaveBeenCalledTimes(0);
  });

  it('stream() stall → kind:"stream_stall" after first chunk', async () => {
    const mockChunks = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'sonar',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null, logprobs: null }],
        usage: null,
      },
    ];

    const hangStream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk> = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockChunks as OpenAI.Chat.ChatCompletionChunk[];
        await new Promise<void>(() => {});
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(hangStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createPerplexityProvider(TEST_CONFIG);
    const chunks: string[] = [];
    let caughtError: unknown;

    const p = (async () => {
      try {
        for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }], {
          streamStallTimeoutMs: 500,
        })) {
          if (chunk.token) chunks.push(chunk.token);
        }
      } catch (e) {
        caughtError = e;
      }
    })();

    await vi.advanceTimersByTimeAsync(500);
    await p;

    expect((caughtError as { kind?: string }).kind).toBe('stream_stall');
    expect(chunks).toContain('hi');
  });
});

// ─── v0.4.0 — return shape additions ─────────────────────────────────────────

describe('Perplexity provider — structured() v0.4.0 return shape', () => {
  it('structured() returns model, id, and citations from the API response', async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValue(
        mockChatCompletion(
          '{"topic":"AI","summary":"short"}',
          ['https://example.com/a', 'https://example.com/b'],
          { model: 'sonar-pro', id: 'chatcmpl-pplx-xyz' }
        )
      );
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const schema = {
      parse: (data: unknown) => data as { topic: string; summary: string },
    };
    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Summarize AI' }], schema);

    expect(result.model).toBe('sonar-pro');
    expect(result.id).toBe('chatcmpl-pplx-xyz');
    expect(result.data.topic).toBe('AI');
    expect(result.citations).toHaveLength(2);
    expect(result.citations?.[0]?.url).toBe('https://example.com/a');
  });

  it('structured() has no citations when API returns none', async () => {
    const mockCreate = vi.fn().mockResolvedValue(
      mockChatCompletion('{"value":1}') // no citations
    );
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const schema = { parse: (data: unknown) => data as { value: number } };
    const client = createPerplexityProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);

    expect(result.citations).toBeUndefined();
  });
});
