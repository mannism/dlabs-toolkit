/**
 * Unit tests for the Anthropic provider.
 *
 * All tests use vi.mock to stub @anthropic-ai/sdk. No real API calls.
 *
 * Test coverage:
 * - complete(): happy path, usage normalization, model override, error normalization
 * - stream(): token chunks, usage on final chunk, error handling
 * - structured(): JSON parse success, JSON parse failure, schema validation failure
 * - System message extraction
 * - Retry behavior on retryable status codes
 */

import Anthropic from '@anthropic-ai/sdk';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { LlmClientConfig, LlmUsage } from '../types.js';
import { LlmError } from '../types.js';
import { createAnthropicProvider } from './anthropic.js';

// Mock the Anthropic SDK so tests never make real API calls
vi.mock('@anthropic-ai/sdk');

const PROVIDER = 'anthropic';

const TEST_CONFIG: LlmClientConfig = {
  provider: 'anthropic',
  model: 'claude-3-haiku-20240307',
  apiKey: 'test-key',
  maxRetries: 0, // Disable retries in most tests for speed
  baseDelayMs: 0,
};

// Helper: create a mock Anthropic message response.
// Cast to unknown first to allow partial mock shapes — the SDK's Anthropic.Message
// has grown many required fields (container, stop_details, etc.) that are not
// relevant to these unit tests which mock the SDK entirely.
function mockMessageResponse(overrides?: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_123',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello, world!', citations: null }],
    model: 'claude-3-haiku-20240307',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage,
    ...overrides,
  } as unknown as Anthropic.Message;
}

describe('Anthropic provider — complete()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockMessageResponse());
    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: { create: mockCreate, stream: vi.fn() },
        }) as unknown as Anthropic
    );
  });

  it('returns normalized LlmResponse on success', async () => {
    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello, world!');
    expect(result.model).toBe('claude-3-haiku-20240307');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('extracts system message into Anthropic system param', async () => {
    const client = createAnthropicProvider(TEST_CONFIG);
    await client.complete([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hi' },
    ]);

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(callArgs.system).toBe('You are a helpful assistant.');
    expect(callArgs.messages).toHaveLength(1);
    expect(callArgs.messages[0]?.role).toBe('user');
  });

  it('applies model override from options', async () => {
    const client = createAnthropicProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      model: 'claude-3-5-sonnet-20241022',
    });

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(callArgs.model).toBe('claude-3-5-sonnet-20241022');
  });

  it('applies maxTokens and temperature from options', async () => {
    const client = createAnthropicProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      maxTokens: 512,
      temperature: 0.5,
    });

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(callArgs.max_tokens).toBe(512);
    expect(callArgs.temperature).toBe(0.5);
  });

  it('normalizes cache tokens when present', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          // Extended usage fields from prompt caching
          cache_creation_input_tokens: 80,
          cache_read_input_tokens: 20,
        } as Anthropic.Usage,
      })
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.usage.cacheCreationTokens).toBe(80);
    expect(result.usage.cacheReadTokens).toBe(20);
  });

  it('throws LlmError on a 401 status error', async () => {
    // Use a plain Error with .status — tests normalizeThrownError path
    // (SDK class constructors are not available when the module is mocked)
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockCreate.mockRejectedValue(err);
    const client = createAnthropicProvider(TEST_CONFIG);

    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      LlmError
    );
  });

  it('throws non-retryable LlmError on 401', async () => {
    // Simulate what normalizeAnthropicError does with a plain status error
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockCreate.mockRejectedValue(err);

    const client = createAnthropicProvider({ ...TEST_CONFIG, maxRetries: 0 });
    const thrown = await client
      .complete([{ role: 'user', content: 'Hi' }])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.retryable).toBe(false);
    }
  });

  it('retries on 429 and eventually succeeds', async () => {
    // LlmError with retryable: true simulates what normalizeAnthropicError produces for 429
    const retryableErr = new LlmError({
      message: 'Rate limited',
      provider: PROVIDER,
      statusCode: 429,
      retryable: true,
    });
    mockCreate.mockRejectedValueOnce(retryableErr).mockResolvedValue(mockMessageResponse());

    const clientWithRetry = createAnthropicProvider({
      ...TEST_CONFIG,
      maxRetries: 2,
      baseDelayMs: 0,
    });

    const result = await clientWithRetry.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('Hello, world!');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('concatenates multiple text blocks', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [
          { type: 'text', text: 'First. ', citations: null },
          { type: 'text', text: 'Second.', citations: null },
        ],
      })
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('First. Second.');
  });
});

describe('Anthropic provider — stream()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields token chunks from stream events', async () => {
    // Mock the SDK stream as an async iterable of events.
    // Cast to unknown[] first — the SDK adds many required fields (container, stop_details, etc.)
    // that are irrelevant for unit tests that mock the SDK module entirely.
    const mockEvents = [
      {
        type: 'message_start',
        message: mockMessageResponse({
          usage: { input_tokens: 5, output_tokens: 0 } as Anthropic.Usage,
        }),
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world!' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    ] as unknown as Anthropic.MessageStreamEvent[];

    const mockFinalMessage = mockMessageResponse({
      usage: { input_tokens: 5, output_tokens: 3 } as Anthropic.Usage,
    });

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockEvents;
      },
      finalMessage: vi.fn().mockResolvedValue(mockFinalMessage),
    };

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: vi.fn(),
            stream: vi.fn().mockReturnValue(mockStream),
          },
        }) as unknown as Anthropic
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    const chunks: string[] = [];
    let finalUsage: LlmUsage | undefined;

    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage !== undefined) {
        finalUsage = chunk.usage;
      } else {
        chunks.push(chunk.token);
      }
    }

    expect(chunks).toEqual(['Hello', ', world!']);
    expect(finalUsage).toBeDefined();
    if (finalUsage !== undefined) {
      expect(finalUsage.inputTokens).toBe(5);
      expect(finalUsage.outputTokens).toBe(3);
    }
  });

  it('throws LlmError when stream() fails mid-stream', async () => {
    const streamErr = new LlmError({
      message: 'Stream broken',
      provider: PROVIDER,
      statusCode: 500,
      retryable: false,
    });

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'content_block_delta' as const,
          index: 0,
          delta: { type: 'text_delta' as const, text: 'partial' },
        };
        throw streamErr;
      },
      finalMessage: vi.fn().mockResolvedValue(mockMessageResponse()),
    };

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: vi.fn(),
            stream: vi.fn().mockReturnValue(mockStream),
          },
        }) as unknown as Anthropic
    );

    const client = createAnthropicProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        // consume
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('throws LlmError when stream() init fails', async () => {
    const streamErr = new LlmError({
      message: 'Connection failed',
      provider: PROVIDER,
      retryable: true,
    });

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: vi.fn(),
            stream: vi.fn().mockImplementation(() => {
              throw streamErr;
            }),
          },
        }) as unknown as Anthropic
    );

    const client = createAnthropicProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        // consume
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('yields no usage chunk when no message_delta event fires', async () => {
    // Stream with only text events — no message_delta — no usage chunk emitted
    const mockEvents: Anthropic.MessageStreamEvent[] = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_stop' },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockEvents;
      },
      finalMessage: vi.fn(),
    };

    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: vi.fn(),
            stream: vi.fn().mockReturnValue(mockStream),
          },
        }) as unknown as Anthropic
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    const usageChunks: unknown[] = [];

    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage !== undefined) usageChunks.push(chunk.usage);
    }

    // No message_delta → no usage chunk
    expect(usageChunks).toHaveLength(0);
  });

  it('applies temperature to stream params when set', async () => {
    const mockStream = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {},
      finalMessage: vi.fn(),
    };

    const mockStreamFn = vi.fn().mockReturnValue(mockStream);
    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: {
            create: vi.fn(),
            stream: mockStreamFn,
          },
        }) as unknown as Anthropic
    );

    const client = createAnthropicProvider({ ...TEST_CONFIG, temperature: 0.7 });

    for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
      // consume
    }

    const callArgs = mockStreamFn.mock.calls[0]?.[0] as Anthropic.MessageStreamParams;
    expect(callArgs.temperature).toBe(0.7);
  });
});

describe('Anthropic provider — structured()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(Anthropic).mockImplementation(
      () =>
        ({
          messages: { create: mockCreate, stream: vi.fn() },
        }) as unknown as Anthropic
    );
  });

  it('parses valid JSON response and validates schema', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [{ type: 'text', text: '{"name":"Alice","age":30}', citations: null }],
      })
    );

    const schema = {
      parse: (data: unknown) => {
        const d = data as { name: string; age: number };
        if (typeof d.name !== 'string') throw new Error('name must be string');
        if (typeof d.age !== 'number') throw new Error('age must be number');
        return d;
      },
    };

    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.structured(
      [{ role: 'user', content: 'Return a person object' }],
      schema
    );

    expect(result.data.name).toBe('Alice');
    expect(result.data.age).toBe(30);
    expect(result.usage.inputTokens).toBe(10);
  });

  it('strips markdown code fences from response', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [{ type: 'text', text: '```json\n{"value": 42}\n```', citations: null }],
      })
    );

    const schema = { parse: (data: unknown) => data as { value: number } };
    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return a value' }], schema);

    expect(result.data.value).toBe(42);
  });

  it('throws LlmError on invalid JSON response', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [{ type: 'text', text: 'This is not JSON', citations: null }],
      })
    );

    const schema = { parse: (data: unknown) => data };
    const client = createAnthropicProvider(TEST_CONFIG);

    await expect(
      client.structured([{ role: 'user', content: 'Return JSON' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('not valid JSON'),
      retryable: false,
    });
  });

  it('throws LlmError on schema validation failure', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [{ type: 'text', text: '{"wrong": "shape"}', citations: null }],
      })
    );

    const schema = {
      parse: (data: unknown) => {
        const d = data as Record<string, unknown>;
        if (!('required_field' in d)) throw new Error('missing required_field');
        return d;
      },
    };

    const client = createAnthropicProvider(TEST_CONFIG);

    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('schema validation'),
      retryable: false,
    });
  });

  it('injects JSON instruction as system message', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({ content: [{ type: 'text', text: '{"ok":true}', citations: null }] })
    );

    const schema = { parse: (data: unknown) => data as { ok: boolean } };
    const client = createAnthropicProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    // System should contain the JSON instruction
    expect(callArgs.system).toContain('valid JSON');
  });
});
