/**
 * Unit tests for the OpenAI provider.
 *
 * All tests use vi.mock to stub the openai SDK. No real API calls.
 *
 * Test coverage:
 * - complete(): happy path, token normalisation, model/options overrides, error normalisation
 * - stream(): token chunks, usage on final chunk, error handling
 * - structured(): JSON mode, parse success/failure, schema validation failure
 * - Retry behaviour on retryable status codes
 */

import OpenAI from 'openai';
import { type MockInstance, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../types.js';
import type { LlmClientConfig } from '../types.js';
import { createOpenAIProvider } from './openai.js';

vi.mock('openai');

const TEST_CONFIG: LlmClientConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

// Helper: create a mock ChatCompletion response
function mockChatCompletion(
  content: string,
  overrides?: Partial<OpenAI.Chat.ChatCompletion>
): OpenAI.Chat.ChatCompletion {
  return {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1234567890,
    model: 'gpt-4o-mini',
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
}

describe('OpenAI provider — complete()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockChatCompletion('Hello, world!'));
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );
  });

  it('returns normalised LlmResponse on success', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello, world!');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('passes system messages through to OpenAI messages array', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
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
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.model).toBe('gpt-4o');
  });

  it('applies maxTokens and temperature', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      maxTokens: 256,
      temperature: 0.3,
    });

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.max_tokens).toBe(256);
    expect(callArgs.temperature).toBe(0.3);
  });

  it('does not set max_tokens when neither config nor options specifies it', async () => {
    const { maxTokens: _omit, ...restConfig } = TEST_CONFIG;
    const configWithoutMax: LlmClientConfig = restConfig;
    const client = createOpenAIProvider(configWithoutMax);
    await client.complete([{ role: 'user', content: 'Hi' }]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.max_tokens).toBeUndefined();
  });

  it('throws LlmError on APIStatusError 401', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockCreate.mockRejectedValue(err);

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      LlmError
    );
  });

  it('throws non-retryable LlmError on 403', async () => {
    // Plain Error with .status goes through normaliseThrownError (SDK classes are mocked)
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    mockCreate.mockRejectedValue(err);

    const client = createOpenAIProvider({ ...TEST_CONFIG, maxRetries: 0 });
    const thrown = await client
      .complete([{ role: 'user', content: 'Hi' }])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.retryable).toBe(false);
      // normaliseThrownError reads .status — verify via retryable flag
      expect(thrown.message).toContain('Forbidden');
    }
  });

  it('retries on 429 and eventually succeeds', async () => {
    // Use LlmError directly with retryable: true — avoids SDK class instanceof issues
    const rateLimitErr = new LlmError({
      message: 'Rate limited',
      provider: 'openai',
      statusCode: 429,
      retryable: true,
    });
    mockCreate
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValue(mockChatCompletion('Success after retry'));

    const client = createOpenAIProvider({ ...TEST_CONFIG, maxRetries: 2, baseDelayMs: 0 });
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Success after retry');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('concatenates multiple choice contents', async () => {
    mockCreate.mockResolvedValue({
      ...mockChatCompletion(''),
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Part 1. ' },
          finish_reason: 'stop',
          logprobs: null,
        },
        {
          index: 1,
          message: { role: 'assistant', content: 'Part 2.' },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('Part 1. Part 2.');
  });
});

describe('OpenAI provider — stream()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields token chunks and usage on final sentinel', async () => {
    const mockChunks: OpenAI.Chat.ChatCompletionChunk[] = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null, logprobs: null }],
        usage: null,
      },
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-4o-mini',
        choices: [
          { index: 0, delta: { content: ', world!' }, finish_reason: 'stop', logprobs: null },
        ],
        usage: null,
      },
      {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-4o-mini',
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
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );

    const client = createOpenAIProvider(TEST_CONFIG);
    const tokens: string[] = [];
    let usageChunk = undefined;

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

  it('throws LlmError on stream error', async () => {
    // Use a pre-constructed LlmError — avoids instanceof issues with mocked SDK classes
    const streamErr = new LlmError({
      message: 'Stream error',
      provider: 'openai',
      statusCode: 500,
      retryable: true,
    });
    const mockCreate = vi.fn().mockRejectedValue(streamErr);
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );

    const client = createOpenAIProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        // consume
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('skips empty string and null content deltas', async () => {
    const mockChunks: OpenAI.Chat.ChatCompletionChunk[] = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: null }, finish_reason: null, logprobs: null }],
        usage: null,
      },
      {
        id: 'c2',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: '' }, finish_reason: null, logprobs: null }],
        usage: null,
      },
      {
        id: 'c3',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o-mini',
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
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );

    const client = createOpenAIProvider(TEST_CONFIG);
    const tokens: string[] = [];
    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.token.length > 0) tokens.push(chunk.token);
    }

    // null and empty string deltas are skipped, only 'real' comes through
    expect(tokens).toEqual(['real']);
  });

  it('yields no usage when stream_options usage is absent', async () => {
    const mockChunks: OpenAI.Chat.ChatCompletionChunk[] = [
      {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: 'text' }, finish_reason: 'stop', logprobs: null }],
        usage: null,
      },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockChunks;
      },
    };
    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );

    const client = createOpenAIProvider(TEST_CONFIG);
    const usageChunks: unknown[] = [];
    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage !== undefined) usageChunks.push(chunk.usage);
    }
    expect(usageChunks).toHaveLength(0);
  });

  it('throws LlmError when stream iteration fails', async () => {
    const iterErr = new LlmError({
      message: 'Mid-stream error',
      provider: 'openai',
      statusCode: 503,
      retryable: true,
    });

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'gpt-4o-mini',
          choices: [
            { index: 0, delta: { content: 'partial' }, finish_reason: null, logprobs: null },
          ],
          usage: null,
        } as OpenAI.Chat.ChatCompletionChunk;
        throw iterErr;
      },
    };
    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );

    const client = createOpenAIProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        /* consume */
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });
});

describe('OpenAI provider — structured()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as OpenAI
    );
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

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return a result' }], schema);

    expect(result.data.name).toBe('Bob');
    expect(result.data.score).toBe(95);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('sets response_format to json_object', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('{"ok":true}'));
    const schema = { parse: (data: unknown) => data as { ok: boolean } };

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.response_format).toEqual({ type: 'json_object' });
  });

  it('throws LlmError on invalid JSON', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('not json at all'));
    const schema = { parse: (data: unknown) => data };

    const client = createOpenAIProvider(TEST_CONFIG);
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

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('schema validation'),
      retryable: false,
    });
  });

  it('injects JSON system message', async () => {
    mockCreate.mockResolvedValue(mockChatCompletion('{"ok":true}'));
    const schema = { parse: (data: unknown) => data as { ok: boolean } };

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const systemMsg = callArgs.messages.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('valid JSON');
  });

  it('throws LlmError when the API call itself rejects', async () => {
    // Exercises the catch block in structured()'s withRetry callback (openai.ts lines 231-232).
    // maxRetries: 0 so the error propagates immediately without retry.
    mockCreate.mockRejectedValue(new Error('connection reset'));
    const schema = { parse: (data: unknown) => data };

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toBeInstanceOf(LlmError);
  });
});
