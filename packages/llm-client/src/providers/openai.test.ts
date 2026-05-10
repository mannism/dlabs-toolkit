/**
 * Unit tests for the OpenAI provider.
 *
 * All tests use vi.mock to stub the openai SDK. No real API calls.
 *
 * Test coverage:
 * - complete(): happy path, token normalization, model/options overrides, error normalization
 * - stream(): token chunks, usage on final chunk, error handling
 * - structured(): JSON mode, parse success/failure, schema validation failure
 * - Retry behavior on retryable status codes
 */

import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import type { LlmClientConfig, LlmUsage } from '../types.js';
import { LlmError } from '../types.js';
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
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });
  });

  it('returns normalized LlmResponse on success', async () => {
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
    expect(callArgs.max_completion_tokens).toBe(256);
    expect(callArgs.max_tokens).toBeUndefined();
    expect(callArgs.temperature).toBe(0.3);
  });

  it('does not set max_completion_tokens when neither config nor options specifies it', async () => {
    const { maxTokens: _omit, ...restConfig } = TEST_CONFIG;
    const configWithoutMax: LlmClientConfig = restConfig;
    const client = createOpenAIProvider(configWithoutMax);
    await client.complete([{ role: 'user', content: 'Hi' }]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    expect(callArgs.max_completion_tokens).toBeUndefined();
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
    // Plain Error with .status goes through normalizeThrownError (SDK classes are mocked)
    const err = Object.assign(new Error('Forbidden'), { status: 403 });
    mockCreate.mockRejectedValue(err);

    const client = createOpenAIProvider({ ...TEST_CONFIG, maxRetries: 0 });
    const thrown = await client
      .complete([{ role: 'user', content: 'Hi' }])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.retryable).toBe(false);
      // normalizeThrownError reads .status — verify via retryable flag
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
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
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

  it('throws LlmError on stream error', async () => {
    // Use a pre-constructed LlmError — avoids instanceof issues with mocked SDK classes
    const streamErr = new LlmError({
      message: 'Stream error',
      provider: 'openai',
      statusCode: 500,
      retryable: true,
    });
    const mockCreate = vi.fn().mockRejectedValue(streamErr);
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });

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
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });

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
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });

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
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });

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
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
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

// ─── v0.4.0 — strict structured output tests ─────────────────────────────────

describe('OpenAI provider — structured() v0.4.0 strict mode', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        chat: { completions: { create: mockCreate } },
      };
    });
  });

  it('(a) Zod 4 schema → SDK params include response_format.type json_schema with strict:true', async () => {
    const zodSchema = z.object({ name: z.string(), score: z.number() });
    mockCreate.mockResolvedValue(
      mockChatCompletion('{"name":"Alice","score":99}', { model: 'gpt-5.4-mini' })
    );

    const client = createOpenAIProvider({ ...TEST_CONFIG, model: 'gpt-5.4-mini' });
    const result = await client.structured([{ role: 'user', content: 'Return data' }], zodSchema);

    // Verify SDK was called with strict json_schema response_format.
    // Cast through typed interface to avoid SDK union type overlap errors and Biome useLiteralKeys.
    type JsonSchemaRF = {
      type: string;
      json_schema: { strict: boolean; name: string; schema: unknown };
    };
    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const rf = callArgs.response_format as unknown as JsonSchemaRF;
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.name).toBe('response');
    expect(typeof rf.json_schema.schema).toBe('object');

    // Verify return shape
    expect(result.data.name).toBe('Alice');
    expect(result.data.score).toBe(99);
    expect(result.model).toBe('gpt-5.4-mini');
    expect(result.id).toBe('chatcmpl-123');
  });

  it('(b) model refusal in strict mode → throws LlmError with refusal text', async () => {
    const zodSchema = z.object({ value: z.string() });
    // Simulate a refusal response (message.content is null, refusal is populated)
    const refusalResponse: OpenAI.Chat.ChatCompletion = {
      id: 'chatcmpl-refusal',
      object: 'chat.completion',
      created: 1234567890,
      model: 'gpt-5.4-mini',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            refusal: 'I cannot generate that content.',
          },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    mockCreate.mockResolvedValue(refusalResponse);

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], zodSchema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('refused'),
      retryable: false,
    });
  });

  it('(c) narrow {parse} schema falls through to json_object path (prompt mode)', async () => {
    // A plain narrow schema (no _zod marker) should use the json_object fallback
    const narrowSchema = { parse: (data: unknown) => data as { ok: boolean } };
    mockCreate.mockResolvedValue(mockChatCompletion('{"ok":true}'));

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], narrowSchema);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    const rf = callArgs.response_format as unknown as { type: string };
    // Falls through to json_object (prompt fallback), not json_schema
    expect(rf.type).toBe('json_object');
  });
});

// ─── Abort / timeout / stall smoke tests ─────────────────────────────────────

describe('OpenAI provider — abort / timeout / stall', () => {
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

    const client = createOpenAIProvider({ ...TEST_CONFIG, timeoutMs: 30_000, maxRetries: 0 });
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

    const client = createOpenAIProvider(TEST_CONFIG);
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
        model: 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null, logprobs: null }],
        usage: null,
      },
    ];

    let settled = false;
    const hangStream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk> = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockChunks as OpenAI.Chat.ChatCompletionChunk[];
        await new Promise<void>(() => {});
        settled = true;
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(hangStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { chat: { completions: { create: mockCreate } } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
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
    expect((caughtError as { retryable?: boolean }).retryable).toBe(true);
    expect(chunks).toContain('hi');
    expect(settled).toBe(false); // generator not fully consumed
  });
});
