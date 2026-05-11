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
 * - Prompt cache (v0.4.3): cache_control injection on system block + tool definition,
 *   negative case (opt-in off), usage surfacing (cacheCreationTokens / cacheReadTokens)
 */

import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
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
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: mockCreate, stream: vi.fn() },
      };
    });
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

    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: {
          create: vi.fn(),
          stream: vi.fn().mockReturnValue(mockStream),
        },
      };
    });

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

    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: {
          create: vi.fn(),
          stream: vi.fn().mockReturnValue(mockStream),
        },
      };
    });

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

    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: {
          create: vi.fn(),
          stream: vi.fn().mockImplementation(() => {
            throw streamErr;
          }),
        },
      };
    });

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

    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: {
          create: vi.fn(),
          stream: vi.fn().mockReturnValue(mockStream),
        },
      };
    });

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
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: {
          create: vi.fn(),
          stream: mockStreamFn,
        },
      };
    });

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
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: mockCreate, stream: vi.fn() },
      };
    });
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

// ─── v0.4.0 — strict structured output tests ─────────────────────────────────

describe('Anthropic provider — structured() v0.4.0 strict mode (tool-use)', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: mockCreate, stream: vi.fn() },
      };
    });
  });

  it('(a) Zod 4 schema → SDK params include tools + forced tool_choice; data extracted from tool_use.input', async () => {
    const zodSchema = z.object({ topic: z.string(), bullets: z.array(z.string()) });

    // Simulate Anthropic response with a tool_use block
    const toolUseResponse = mockMessageResponse({
      content: [
        {
          type: 'tool_use',
          id: 'tool_abc',
          name: 'extract',
          input: { topic: 'TypeScript', bullets: ['strict types', 'inference'] },
        } as unknown as Anthropic.ContentBlock,
      ],
      stop_reason: 'tool_use',
    });
    mockCreate.mockResolvedValue(toolUseResponse);

    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Summarize' }], zodSchema);

    // Verify SDK was called with tools + tool_choice
    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(callArgs.tools).toHaveLength(1);
    expect(callArgs.tools?.[0]?.name).toBe('extract');
    expect(callArgs.tool_choice).toMatchObject({ type: 'tool', name: 'extract' });

    // Verify data extracted from tool_use.input
    expect(result.data.topic).toBe('TypeScript');
    expect(result.data.bullets).toEqual(['strict types', 'inference']);
    expect(result.model).toBe('claude-3-haiku-20240307');
    expect(result.id).toBe('msg_123');
  });

  it('(b) model emits text-only (no tool_use block) → throws LlmError with text in message', async () => {
    const zodSchema = z.object({ value: z.string() });

    // Simulate a response with only text content (no tool_use)
    const textOnlyResponse = mockMessageResponse({
      content: [{ type: 'text', text: 'I cannot provide structured data.', citations: null }],
      stop_reason: 'end_turn',
    });
    mockCreate.mockResolvedValue(textOnlyResponse);

    const client = createAnthropicProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], zodSchema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('did not call the extract tool'),
      retryable: false,
      kind: 'unknown',
    });
  });

  it('(c) narrow {parse} schema falls through to prompt-only path (json text response)', async () => {
    // A plain narrow schema (no _zod marker) should use the prompt-only fallback
    const narrowSchema = { parse: (data: unknown) => data as { ok: boolean } };

    // Prompt fallback uses complete() internally which calls messages.create
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [{ type: 'text', text: '{"ok":true}', citations: null }],
      })
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.structured(
      [{ role: 'user', content: 'Return data' }],
      narrowSchema
    );

    // No tools param (prompt fallback doesn't use tool-use)
    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(callArgs.tools).toBeUndefined();
    expect(result.data.ok).toBe(true);
  });
});

// ─── v0.4.2 — Fix A: per-call timeoutMs threads into SDK RequestOptions ───────

describe('Anthropic provider — Fix A: timeout propagates to SDK RequestOptions', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockMessageResponse());
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: mockCreate, stream: vi.fn() },
      };
    });
  });

  it('complete(): per-call timeoutMs is passed as timeout in SDK RequestOptions', async () => {
    const client = createAnthropicProvider({ ...TEST_CONFIG, timeoutMs: 30_000 });
    await client.complete([{ role: 'user', content: 'Hi' }], { timeoutMs: 120_000 });

    // Second argument to messages.create() is the RequestOptions object
    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number; signal?: AbortSignal };
    expect(reqOpts.timeout).toBe(120_000);
  });

  it('complete(): falls back to config.timeoutMs when no per-call override', async () => {
    const client = createAnthropicProvider({ ...TEST_CONFIG, timeoutMs: 60_000 });
    await client.complete([{ role: 'user', content: 'Hi' }]);

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(60_000);
  });

  it('complete(): falls back to 30 000 ms hard default when neither config nor options sets timeoutMs', async () => {
    const { timeoutMs: _omit, ...restConfig } = TEST_CONFIG;
    const client = createAnthropicProvider(restConfig);
    await client.complete([{ role: 'user', content: 'Hi' }]);

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(30_000);
  });

  it('stream(): per-call timeoutMs is passed as timeout in SDK RequestOptions', async () => {
    const mockStreamFn = vi.fn().mockReturnValue({
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {},
      finalMessage: vi.fn(),
    });

    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: vi.fn(), stream: mockStreamFn },
      };
    });

    const client = createAnthropicProvider({ ...TEST_CONFIG, timeoutMs: 30_000 });
    for await (const _ of client.stream([{ role: 'user', content: 'Hi' }], {
      timeoutMs: 180_000,
    })) {
      /* consume */
    }

    const reqOpts = mockStreamFn.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(180_000);
  });

  it('structured() strict path: per-call timeoutMs is passed as timeout in SDK RequestOptions', async () => {
    const { z } = await import('zod');
    const zodSchema = z.object({ topic: z.string() });

    // Simulate Anthropic tool_use response for the strict path
    const toolUseResponse = mockMessageResponse({
      content: [
        {
          type: 'tool_use',
          id: 'tool_abc',
          name: 'extract',
          input: { topic: 'AI' },
        } as unknown as Anthropic.ContentBlock,
      ],
      stop_reason: 'tool_use',
    });
    mockCreate.mockResolvedValue(toolUseResponse);

    const client = createAnthropicProvider({ ...TEST_CONFIG, timeoutMs: 30_000 });
    await client.structured([{ role: 'user', content: 'Summarize' }], zodSchema, {
      timeoutMs: 240_000,
    });

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(240_000);
  });
});

// ─── v0.4.2 — Fix B: APIConnectionTimeoutError → kind:'timeout' ──────────────

describe('Anthropic provider — Fix B: APIConnectionTimeoutError classifies as kind:timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('complete(): APIConnectionTimeoutError thrown by SDK → LlmError kind:timeout, retryable:true', async () => {
    // Construct a real local class so instanceof checks fire, then assign it to
    // Anthropic.APIConnectionTimeoutError. The normalizer checks timeout before connection,
    // so the timeout branch fires before the generic connection branch.
    class FakeAPIConnectionTimeoutError extends Error {
      constructor() {
        super('Request timed out.');
        this.name = 'APIConnectionTimeoutError';
      }
    }

    // noPropertyAccessFromIndexSignature requires bracket notation on Record<string,unknown>.
    // Each access line carries its own biome-ignore for useLiteralKeys.
    const anthropicAsRecord = Anthropic as unknown as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation on Record<string,unknown>
    anthropicAsRecord['APIConnectionTimeoutError'] = FakeAPIConnectionTimeoutError;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation on Record<string,unknown>
    anthropicAsRecord['APIConnectionError'] = FakeAPIConnectionTimeoutError;

    const mockCreate = vi.fn().mockRejectedValue(new FakeAPIConnectionTimeoutError());
    vi.mocked(Anthropic).mockImplementation(function () {
      return { messages: { create: mockCreate, stream: vi.fn() } };
    });

    const client = createAnthropicProvider({ ...TEST_CONFIG, maxRetries: 0 });
    const thrown = await client
      .complete([{ role: 'user', content: 'Hi' }])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('timeout');
      expect(thrown.retryable).toBe(true);
    }
  });
});

// ─── Abort / timeout / stall smoke tests ─────────────────────────────────────
//
// These tests use vi.useFakeTimers so we can advance time synthetically rather
// than waiting for real delays. Always use vi.advanceTimersByTimeAsync (async
// variant) — Promise.race() involves microtasks and the sync variant won't
// flush them, leaving tests hanging.

describe('Anthropic provider — abort / timeout / stall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('per-call timeoutMs override fires before client default', async () => {
    // create() respects the signal: rejects with AbortError when signal fires.
    // This mirrors real Anthropic SDK behavior — the SDK rejects with an AbortError
    // when the RequestOptions.signal is aborted.
    const mockCreate = vi
      .fn()
      .mockImplementation((_params: unknown, opts: { signal?: AbortSignal }) => {
        const sig = opts?.signal;
        let settled = false;
        return new Promise<Anthropic.Message>((_resolve, reject) => {
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

    vi.mocked(Anthropic).mockImplementation(function () {
      return { messages: { create: mockCreate, stream: vi.fn() } };
    });

    const client = createAnthropicProvider({ ...TEST_CONFIG, timeoutMs: 30_000, maxRetries: 0 });
    let caughtErr: unknown;
    const resultPromise = client
      .complete(
        [{ role: 'user', content: 'Hi' }],
        { timeoutMs: 100 } // far shorter than the client default
      )
      .catch((e: unknown) => {
        caughtErr = e;
      });

    // Advance past the per-call timeout
    await vi.advanceTimersByTimeAsync(100);
    await resultPromise;

    expect(caughtErr).toBeInstanceOf(Error);
    expect((caughtErr as { kind?: string }).kind).toBe('timeout');
    expect((caughtErr as { retryable?: boolean }).retryable).toBe(true);
  });

  it('caller signal aborts before SDK call → kind:"cancelled", mock called once', async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockMessageResponse());
    vi.mocked(Anthropic).mockImplementation(function () {
      return { messages: { create: mockCreate, stream: vi.fn() } };
    });

    const ac = new AbortController();
    ac.abort('user cancelled');

    const client = createAnthropicProvider(TEST_CONFIG);
    await expect(
      client.complete([{ role: 'user', content: 'Hi' }], { signal: ac.signal })
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false });

    // Pre-aborted signal → withRetry bails before calling fn → 0 SDK calls
    expect(mockCreate).toHaveBeenCalledTimes(0);
  });

  it('stream() stall → kind:"stream_stall" after first chunk', async () => {
    // Emit one chunk, then hang indefinitely.
    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'content_block_delta' as const,
          index: 0,
          delta: { type: 'text_delta' as const, text: 'hi' },
        };
        // Hang — stall detector should fire before this resolves
        await new Promise<void>(() => {});
      },
      finalMessage: vi.fn().mockResolvedValue(mockMessageResponse()),
    };

    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: {
          create: vi.fn(),
          stream: vi.fn().mockReturnValue(mockStream),
        },
      };
    });

    const client = createAnthropicProvider(TEST_CONFIG);
    const chunks: string[] = [];
    let caughtError: unknown;

    // Collect error explicitly so the promise is always settled before we assert.
    const consumePromise = (async () => {
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

    // Advance past stall timeout, then await the consumer
    await vi.advanceTimersByTimeAsync(500);
    await consumePromise;

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as { kind?: string }).kind).toBe('stream_stall');
    expect((caughtError as { retryable?: boolean }).retryable).toBe(true);
    expect(chunks).toContain('hi');
  });
});

// ─── v0.4.3 — Anthropic prompt cache ─────────────────────────────────────────
//
// These tests verify that:
// (1) cache_control: { type: 'ephemeral' } is injected on the system block when
//     providerOptions.promptCache === 'ephemeral'.
// (2) The marker is absent when the opt-in is not set (negative case).
// (3) In structured() strict mode, cache_control is also on the tool definition.
// (4) structuredPromptFallback() propagates the option to complete() so the system
//     block gets the marker through the delegation chain.
// (5) normalizeUsage() surfaces cacheCreationTokens and cacheReadTokens from the
//     SDK response when the API returns those extended fields.

describe('Anthropic provider — prompt cache (v0.4.3): complete()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockMessageResponse());
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: mockCreate, stream: vi.fn() },
      };
    });
  });

  it('injects cache_control on system block when promptCache is ephemeral', async () => {
    const client = createAnthropicProvider(TEST_CONFIG);
    await client.complete(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hi' },
      ],
      { providerOptions: { promptCache: 'ephemeral' } }
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    // system should be an array of text blocks, not a plain string
    expect(Array.isArray(callArgs.system)).toBe(true);
    const systemBlocks = callArgs.system as Anthropic.TextBlockParam[];
    expect(systemBlocks).toHaveLength(1);
    expect(systemBlocks[0]?.text).toBe('You are a helpful assistant.');
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT inject cache_control when promptCache is not set (negative case)', async () => {
    const client = createAnthropicProvider(TEST_CONFIG);
    await client.complete([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hi' },
    ]);

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    // system should be a plain string — no block array wrapping
    expect(typeof callArgs.system).toBe('string');
    expect(callArgs.system).toBe('You are a helpful assistant.');
  });

  it('does NOT inject cache_control when there is no system message', async () => {
    const client = createAnthropicProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      providerOptions: { promptCache: 'ephemeral' },
    });

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    // No system message → system param should not be present at all
    expect(callArgs.system).toBeUndefined();
  });

  it('surfaces cacheCreationTokens and cacheReadTokens from SDK response', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        usage: {
          input_tokens: 6302,
          output_tokens: 100,
          cache_creation_input_tokens: 6000,
          cache_read_input_tokens: 0,
        } as Anthropic.Usage,
      })
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.complete(
      [
        { role: 'system', content: 'System prompt.' },
        { role: 'user', content: 'Hi' },
      ],
      { providerOptions: { promptCache: 'ephemeral' } }
    );

    expect(result.usage.cacheCreationTokens).toBe(6000);
    expect(result.usage.cacheReadTokens).toBe(0);
  });

  it('surfaces cacheReadTokens > 0 on a cache hit response', async () => {
    mockCreate.mockResolvedValue(
      mockMessageResponse({
        usage: {
          input_tokens: 302,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 6000,
        } as Anthropic.Usage,
      })
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    const result = await client.complete(
      [
        { role: 'system', content: 'System prompt.' },
        { role: 'user', content: 'Hi' },
      ],
      { providerOptions: { promptCache: 'ephemeral' } }
    );

    expect(result.usage.cacheReadTokens).toBe(6000);
    expect(result.usage.cacheCreationTokens).toBe(0);
  });
});

describe('Anthropic provider — prompt cache (v0.4.3): stream()', () => {
  it('injects cache_control on system block when promptCache is ephemeral', async () => {
    const mockStream = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {},
      finalMessage: vi.fn().mockResolvedValue(mockMessageResponse()),
    };

    const mockStreamFn = vi.fn().mockReturnValue(mockStream);
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: vi.fn(), stream: mockStreamFn },
      };
    });

    const client = createAnthropicProvider(TEST_CONFIG);
    for await (const _ of client.stream(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hi' },
      ],
      { providerOptions: { promptCache: 'ephemeral' } }
    )) {
      /* consume */
    }

    const callArgs = mockStreamFn.mock.calls[0]?.[0] as Anthropic.MessageStreamParams;
    expect(Array.isArray(callArgs.system)).toBe(true);
    const systemBlocks = callArgs.system as Anthropic.TextBlockParam[];
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT inject cache_control when promptCache is not set (negative case)', async () => {
    const mockStream = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {},
      finalMessage: vi.fn().mockResolvedValue(mockMessageResponse()),
    };

    const mockStreamFn = vi.fn().mockReturnValue(mockStream);
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: vi.fn(), stream: mockStreamFn },
      };
    });

    const client = createAnthropicProvider(TEST_CONFIG);
    for await (const _ of client.stream([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hi' },
    ])) {
      /* consume */
    }

    const callArgs = mockStreamFn.mock.calls[0]?.[0] as Anthropic.MessageStreamParams;
    expect(typeof callArgs.system).toBe('string');
  });
});

describe('Anthropic provider — prompt cache (v0.4.3): structured() strict mode (tool-use)', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: mockCreate, stream: vi.fn() },
      };
    });
  });

  it('injects cache_control on system block AND tool definition when promptCache is ephemeral', async () => {
    const { z } = await import('zod');
    const zodSchema = z.object({ topic: z.string() });

    const toolUseResponse = mockMessageResponse({
      content: [
        {
          type: 'tool_use',
          id: 'tool_abc',
          name: 'extract',
          input: { topic: 'AI' },
        } as unknown as Anthropic.ContentBlock,
      ],
      stop_reason: 'tool_use',
    });
    mockCreate.mockResolvedValue(toolUseResponse);

    const client = createAnthropicProvider(TEST_CONFIG);
    await client.structured(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Summarize' },
      ],
      zodSchema,
      { providerOptions: { promptCache: 'ephemeral' } }
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;

    // System block should carry cache_control
    expect(Array.isArray(callArgs.system)).toBe(true);
    const systemBlocks = callArgs.system as Anthropic.TextBlockParam[];
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });

    // Tool definition should also carry cache_control
    expect(callArgs.tools).toHaveLength(1);
    const tool = callArgs.tools?.[0] as Anthropic.Tool & { cache_control?: unknown };
    expect(tool.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT inject cache_control on system or tool when promptCache is not set (negative case)', async () => {
    const { z } = await import('zod');
    const zodSchema = z.object({ topic: z.string() });

    const toolUseResponse = mockMessageResponse({
      content: [
        {
          type: 'tool_use',
          id: 'tool_abc',
          name: 'extract',
          input: { topic: 'AI' },
        } as unknown as Anthropic.ContentBlock,
      ],
      stop_reason: 'tool_use',
    });
    mockCreate.mockResolvedValue(toolUseResponse);

    const client = createAnthropicProvider(TEST_CONFIG);
    await client.structured(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Summarize' },
      ],
      zodSchema
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;

    // System should be plain string
    expect(typeof callArgs.system).toBe('string');

    // Tool definition should have no cache_control
    const tool = callArgs.tools?.[0] as Anthropic.Tool & { cache_control?: unknown };
    expect(tool.cache_control).toBeUndefined();
  });
});

describe('Anthropic provider — prompt cache (v0.4.3): structuredPromptFallback() delegation', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(Anthropic).mockImplementation(function () {
      return {
        messages: { create: mockCreate, stream: vi.fn() },
      };
    });
  });

  it('cache_control reaches SDK call when promptCache is set via structuredMode:prompt fallback', async () => {
    // Use a narrow (non-Zod) schema to force the prompt fallback path
    const narrowSchema = { parse: (data: unknown) => data as { ok: boolean } };

    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [{ type: 'text', text: '{"ok":true}', citations: null }],
      })
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    await client.structured(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Return data' },
      ],
      narrowSchema,
      { providerOptions: { promptCache: 'ephemeral' } }
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    // The fallback prepends a JSON instruction as a system message, which gets concatenated
    // with the caller's system message. The combined block should carry cache_control.
    expect(Array.isArray(callArgs.system)).toBe(true);
    const systemBlocks = callArgs.system as Anthropic.TextBlockParam[];
    expect(systemBlocks[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT inject cache_control via prompt fallback when opt-in is not set (negative case)', async () => {
    const narrowSchema = { parse: (data: unknown) => data as { ok: boolean } };

    mockCreate.mockResolvedValue(
      mockMessageResponse({
        content: [{ type: 'text', text: '{"ok":true}', citations: null }],
      })
    );

    const client = createAnthropicProvider(TEST_CONFIG);
    await client.structured(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Return data' },
      ],
      narrowSchema
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(typeof callArgs.system).toBe('string');
  });
});
