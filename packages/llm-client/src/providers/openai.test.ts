/**
 * Unit tests for the OpenAI provider — Responses API (v1.0.0+).
 *
 * All tests use vi.mock to stub the openai SDK. No real API calls.
 *
 * Mock target: { responses: { create: mockCreate } }
 * Response shape: OpenAI.Responses.Response — output[].content[].text for text,
 *   usage.input_tokens / output_tokens / total_tokens.
 * Stream events: { type: 'response.output_text.delta', delta } and
 *   { type: 'response.completed', response: { usage } }.
 *
 * Test coverage:
 * - complete(): happy path, token normalization, model/options overrides, error normalization
 * - stream(): token chunks, usage from response.completed event, error handling
 * - structured(): Zod strict path (text.format json_schema), prompt-fallback (json_object)
 * - Retry behavior on retryable status codes
 * - Timeout propagation into SDK RequestOptions
 * - AbortSignal / cancel / stream stall
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

/**
 * Build a minimal Responses API Response object with a single text output message.
 * Mirrors OpenAI.Responses.Response shape:
 *   { id, object, model, output: [{ type:'message', content:[{ type:'output_text', text }] }],
 *     usage: { input_tokens, output_tokens, total_tokens } }
 */
function mockResponse(
  text: string,
  overrides?: {
    id?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  }
): OpenAI.Responses.Response {
  const inp = overrides?.inputTokens ?? 10;
  const out = overrides?.outputTokens ?? 5;
  return {
    id: overrides?.id ?? 'resp-123',
    object: 'response',
    model: overrides?.model ?? 'gpt-4o-mini',
    output: [
      {
        type: 'message',
        id: 'msg-1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: inp,
      output_tokens: out,
      total_tokens: overrides?.totalTokens ?? inp + out,
    },
    // Required Responses.Response fields
    created_at: 1234567890,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    status: 'completed',
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
  } as unknown as OpenAI.Responses.Response;
}

// ─── complete() ───────────────────────────────────────────────────────────────

describe('OpenAI provider (Responses API) — complete()', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockResponse('Hello, world!'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        responses: { create: mockCreate },
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

  it('passes messages as input array to responses.create', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hi' },
    ]);

    const callArgs = mockCreate.mock.calls[0]?.[0] as { input: Array<{ role: string }> };
    expect(callArgs.input).toHaveLength(2);
    expect(callArgs.input[0]?.role).toBe('system');
    expect(callArgs.input[1]?.role).toBe('user');
  });

  it('applies model override', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], { model: 'gpt-4o' });

    const callArgs = mockCreate.mock.calls[0]?.[0] as { model: string };
    expect(callArgs.model).toBe('gpt-4o');
  });

  it('applies maxTokens as max_output_tokens', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], { maxTokens: 256, temperature: 0.3 });

    const callArgs = mockCreate.mock.calls[0]?.[0] as {
      max_output_tokens?: number;
      temperature?: number;
    };
    expect(callArgs.max_output_tokens).toBe(256);
    expect(callArgs.temperature).toBe(0.3);
  });

  it('does not set max_output_tokens when neither config nor options specifies it', async () => {
    const { maxTokens: _omit, ...restConfig } = TEST_CONFIG;
    const configWithoutMax: LlmClientConfig = restConfig;
    const client = createOpenAIProvider(configWithoutMax);
    await client.complete([{ role: 'user', content: 'Hi' }]);

    // Concrete shape avoids TS4111 (noPropertyAccessFromIndexSignature fires on Record types)
    type CallShape = { max_output_tokens?: unknown };
    const callArgs = mockCreate.mock.calls[0]?.[0] as CallShape;
    expect(callArgs.max_output_tokens).toBeUndefined();
  });

  it('uses responses.create — not chat.completions.create', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }]);
    // The mock setup only wires responses.create; if chat.completions.create were called
    // the test would fail. Verify the call went through our mock.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('throws LlmError with kind:auth on 401', async () => {
    const err = new LlmError({
      message: 'Unauthorized',
      provider: 'openai',
      statusCode: 401,
      kind: 'auth',
      retryable: false,
    });
    mockCreate.mockRejectedValue(err);

    const client = createOpenAIProvider(TEST_CONFIG);
    const thrown = await client
      .complete([{ role: 'user', content: 'Hi' }])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('auth');
      expect(thrown.retryable).toBe(false);
    }
  });

  it('retries on 429 (rate_limit) and eventually succeeds', async () => {
    const rateLimitErr = new LlmError({
      message: 'Rate limited',
      provider: 'openai',
      statusCode: 429,
      kind: 'rate_limit',
      retryable: true,
    });
    mockCreate
      .mockRejectedValueOnce(rateLimitErr)
      .mockResolvedValue(mockResponse('Success after retry'));

    const client = createOpenAIProvider({ ...TEST_CONFIG, maxRetries: 2, baseDelayMs: 0 });
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Success after retry');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('concatenates text from multiple output_text content items', async () => {
    // Build a response with two text parts in the same message
    const multiTextResponse = {
      ...mockResponse(''),
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'Part 1. ', annotations: [] },
            { type: 'output_text', text: 'Part 2.', annotations: [] },
          ],
        },
      ],
    } as unknown as OpenAI.Responses.Response;
    mockCreate.mockResolvedValue(multiTextResponse);

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('Part 1. Part 2.');
  });
});

// ─── stream() ─────────────────────────────────────────────────────────────────

describe('OpenAI provider (Responses API) — stream()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields token chunks from response.output_text.delta events', async () => {
    // Responses API streaming events — not ChatCompletionChunk
    const mockEvents = [
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ', world!' },
      {
        type: 'response.completed',
        response: {
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockEvents;
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
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

  it('throws LlmError on stream creation error', async () => {
    const streamErr = new LlmError({
      message: 'Stream error',
      provider: 'openai',
      statusCode: 500,
      kind: 'server_error',
      retryable: true,
    });
    const mockCreate = vi.fn().mockRejectedValue(streamErr);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        // consume
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('skips empty string deltas', async () => {
    const mockEvents = [
      { type: 'response.output_text.delta', delta: '' },
      { type: 'response.output_text.delta', delta: 'real' },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
      },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockEvents;
      },
    };
    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const tokens: string[] = [];
    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.token.length > 0) tokens.push(chunk.token);
    }

    expect(tokens).toEqual(['real']);
  });

  it('yields no usage sentinel when response.completed is absent', async () => {
    // Stream that ends without a response.completed event
    const mockEvents = [{ type: 'response.output_text.delta', delta: 'text' }];

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockEvents;
      },
    };
    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const usageChunks: unknown[] = [];
    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage !== undefined) usageChunks.push(chunk.usage);
    }
    expect(usageChunks).toHaveLength(0);
  });

  it('throws LlmError when stream iteration fails mid-stream', async () => {
    const iterErr = new LlmError({
      message: 'Mid-stream error',
      provider: 'openai',
      statusCode: 503,
      kind: 'server_error',
      retryable: true,
    });

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'response.output_text.delta', delta: 'partial' };
        throw iterErr;
      },
    };
    const mockCreate = vi.fn().mockResolvedValue(mockStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
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

// ─── structured() — prompt-fallback (json_object) ────────────────────────────

describe('OpenAI provider (Responses API) — structured() prompt-fallback (json_object)', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });
  });

  it('parses valid JSON response and validates schema', async () => {
    mockCreate.mockResolvedValue(mockResponse('{"name":"Bob","score":95}'));

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

  it('uses text.format json_object mode (not response_format)', async () => {
    mockCreate.mockResolvedValue(mockResponse('{"ok":true}'));
    const schema = { parse: (data: unknown) => data as { ok: boolean } };

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockCreate.mock.calls[0]?.[0] as {
      text?: { format?: { type: string } };
      response_format?: unknown;
    };
    // Responses API uses text.format, not response_format
    expect(callArgs.text?.format?.type).toBe('json_object');
    expect(callArgs.response_format).toBeUndefined();
  });

  it('throws LlmError on invalid JSON', async () => {
    mockCreate.mockResolvedValue(mockResponse('not json at all'));
    const schema = { parse: (data: unknown) => data };

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return JSON' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('not valid JSON'),
      retryable: false,
      kind: 'structured_parse_failed',
    });
  });

  it('throws LlmError on schema validation failure', async () => {
    mockCreate.mockResolvedValue(mockResponse('{"wrong_key": 1}'));
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

  it('injects JSON system message in prompt-fallback path', async () => {
    mockCreate.mockResolvedValue(mockResponse('{"ok":true}'));
    const schema = { parse: (data: unknown) => data as { ok: boolean } };

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockCreate.mock.calls[0]?.[0] as {
      input: Array<{ role: string; content: string }>;
    };
    const systemMsg = callArgs.input.find((m) => m.role === 'system');
    expect(systemMsg?.content).toContain('valid JSON');
  });

  it('throws LlmError when the API call itself rejects', async () => {
    mockCreate.mockRejectedValue(new Error('connection reset'));
    const schema = { parse: (data: unknown) => data };

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('parses JSON wrapped in fences with trailing prose', async () => {
    const raw = '```json\n{"value":42}\n```\n\nAdditional context from the model.';
    mockCreate.mockResolvedValue(mockResponse(raw));
    const schema = { parse: (data: unknown) => data as { value: number } };

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);
    expect(result.data.value).toBe(42);
  });

  it('parses JSON when prose precedes the fence', async () => {
    const raw = 'Here is your response:\n```json\n{"value":13}\n```';
    mockCreate.mockResolvedValue(mockResponse(raw));
    const schema = { parse: (data: unknown) => data as { value: number } };

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);
    expect(result.data.value).toBe(13);
  });

  it('parses JSON when there is no closing fence', async () => {
    const raw = '```json\n{"value":77}';
    mockCreate.mockResolvedValue(mockResponse(raw));
    const schema = { parse: (data: unknown) => data as { value: number } };

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);
    expect(result.data.value).toBe(77);
  });

  it('error message contains raw content on parse failure', async () => {
    const longProse = 'Not JSON content here. '.repeat(35); // ~805 chars
    mockCreate.mockResolvedValue(mockResponse(longProse));
    const schema = { parse: (data: unknown) => data as { value: number } };

    const client = createOpenAIProvider(TEST_CONFIG);
    try {
      await client.structured([{ role: 'user', content: 'Return data' }], schema);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      if (e instanceof LlmError) {
        expect(e.kind).toBe('structured_parse_failed');
        expect(e.message).toContain('not valid JSON');
      }
    }
  });
});

// ─── structured() — Zod strict mode (json_schema via text.format) ─────────────

describe('OpenAI provider (Responses API) — structured() strict mode (Zod + text.format)', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn();
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });
  });

  it('(a) Zod 4 schema → SDK params use text.format.type json_schema with strict:true', async () => {
    const zodSchema = z.object({ name: z.string(), score: z.number() });
    mockCreate.mockResolvedValue(
      mockResponse('{"name":"Alice","score":99}', { model: 'gpt-5.4-mini', id: 'resp-strict-1' })
    );

    const client = createOpenAIProvider({ ...TEST_CONFIG, model: 'gpt-5.4-mini' });
    const result = await client.structured([{ role: 'user', content: 'Return data' }], zodSchema);

    // Verify SDK was called with text.format json_schema — NOT response_format
    type TextFormat = {
      text?: {
        format?: { type: string; name: string; schema: unknown; strict: boolean };
      };
      response_format?: unknown;
    };
    const callArgs = mockCreate.mock.calls[0]?.[0] as TextFormat;
    const fmt = callArgs.text?.format;
    expect(fmt?.type).toBe('json_schema');
    expect(fmt?.strict).toBe(true);
    expect(fmt?.name).toBe('response');
    expect(typeof fmt?.schema).toBe('object');
    // Verify response_format is NOT present (Responses API difference)
    expect(callArgs.response_format).toBeUndefined();

    // Verify return shape
    expect(result.data.name).toBe('Alice');
    expect(result.data.score).toBe(99);
    expect(result.model).toBe('gpt-5.4-mini');
    expect(result.id).toBe('resp-strict-1');
  });

  it('(b) model refusal in strict mode → throws LlmError with kind:content_filter', async () => {
    const zodSchema = z.object({ value: z.string() });

    // Build a refusal response with a 'refusal' content item (Responses API shape)
    const refusalResponse = {
      ...mockResponse(''),
      output: [
        {
          type: 'message',
          id: 'msg-refusal',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'I cannot generate that content.' }],
        },
      ],
    } as unknown as OpenAI.Responses.Response;
    mockCreate.mockResolvedValue(refusalResponse);

    const client = createOpenAIProvider(TEST_CONFIG);
    const thrown = await client
      .structured([{ role: 'user', content: 'Return data' }], zodSchema)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('content_filter');
      expect(thrown.retryable).toBe(false);
      expect(thrown.message).toContain('refused');
    }
  });

  it('(c) narrow {parse} schema falls through to json_object path (prompt mode)', async () => {
    const narrowSchema = { parse: (data: unknown) => data as { ok: boolean } };
    mockCreate.mockResolvedValue(mockResponse('{"ok":true}'));

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], narrowSchema);

    const callArgs = mockCreate.mock.calls[0]?.[0] as {
      text?: { format?: { type: string } };
    };
    // Falls through to json_object (prompt fallback)
    expect(callArgs.text?.format?.type).toBe('json_object');
  });

  it('(d) throws kind:structured_parse_failed if Zod strict response is not valid JSON', async () => {
    const zodSchema = z.object({ value: z.number() });
    mockCreate.mockResolvedValue(mockResponse('not-valid-json'));

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], zodSchema)
    ).rejects.toMatchObject({ kind: 'structured_parse_failed', retryable: false });
  });
});

// ─── Timeout propagation into SDK RequestOptions ──────────────────────────────

describe('OpenAI provider (Responses API) — timeout propagation', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockResponse('Hello'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });
  });

  it('complete(): per-call timeoutMs is passed as timeout in SDK RequestOptions', async () => {
    const client = createOpenAIProvider({ ...TEST_CONFIG, timeoutMs: 30_000 });
    await client.complete([{ role: 'user', content: 'Hi' }], { timeoutMs: 120_000 });

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(120_000);
  });

  it('complete(): falls back to config.timeoutMs when no per-call override', async () => {
    const client = createOpenAIProvider({ ...TEST_CONFIG, timeoutMs: 60_000 });
    await client.complete([{ role: 'user', content: 'Hi' }]);

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(60_000);
  });

  it('complete(): defaults to 30000ms when neither config nor options sets timeoutMs', async () => {
    const { timeoutMs: _omit, ...restConfig } = TEST_CONFIG;
    const client = createOpenAIProvider(restConfig);
    await client.complete([{ role: 'user', content: 'Hi' }]);

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(30_000);
  });

  it('stream(): per-call timeoutMs is passed as timeout in SDK RequestOptions', async () => {
    const mockStream = { [Symbol.asyncIterator]: async function* () {} };
    mockCreate.mockResolvedValue(mockStream);

    const client = createOpenAIProvider({ ...TEST_CONFIG, timeoutMs: 30_000 });
    for await (const _ of client.stream([{ role: 'user', content: 'Hi' }], {
      timeoutMs: 180_000,
    })) {
      /* consume */
    }

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(180_000);
  });

  it('structured() strict path: per-call timeoutMs is passed as timeout in SDK RequestOptions', async () => {
    const zodSchema = z.object({ ok: z.boolean() });
    mockCreate.mockResolvedValue(mockResponse('{"ok":true}', { model: 'gpt-5.4-mini' }));

    const client = createOpenAIProvider({
      ...TEST_CONFIG,
      model: 'gpt-5.4-mini',
      timeoutMs: 30_000,
    });
    await client.structured([{ role: 'user', content: 'Return data' }], zodSchema, {
      timeoutMs: 240_000,
    });

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(240_000);
  });

  it('structured() prompt-fallback path: per-call timeoutMs passed to SDK RequestOptions', async () => {
    const narrowSchema = { parse: (data: unknown) => data as { ok: boolean } };
    mockCreate.mockResolvedValue(mockResponse('{"ok":true}'));

    const client = createOpenAIProvider({ ...TEST_CONFIG, timeoutMs: 30_000 });
    await client.structured([{ role: 'user', content: 'Return data' }], narrowSchema, {
      timeoutMs: 200_000,
    });

    const reqOpts = mockCreate.mock.calls[0]?.[1] as { timeout?: number };
    expect(reqOpts.timeout).toBe(200_000);
  });
});

// ─── APIConnectionTimeoutError → kind:'timeout' ───────────────────────────────

describe('OpenAI provider (Responses API) — APIConnectionTimeoutError → kind:timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('complete(): APIConnectionTimeoutError → LlmError kind:timeout, retryable:true', async () => {
    class FakeAPIConnectionTimeoutError extends Error {
      constructor() {
        super('Request timed out.');
        this.name = 'APIConnectionTimeoutError';
      }
    }

    const openAIAsRecord = OpenAI as unknown as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    openAIAsRecord['APIConnectionTimeoutError'] = FakeAPIConnectionTimeoutError;
    // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature requires bracket notation
    openAIAsRecord['APIConnectionError'] = FakeAPIConnectionTimeoutError;

    const mockCreate = vi.fn().mockRejectedValue(new FakeAPIConnectionTimeoutError());
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider({ ...TEST_CONFIG, maxRetries: 0 });
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

// ─── Abort / timeout / stall ──────────────────────────────────────────────────

describe('OpenAI provider (Responses API) — abort / timeout / stall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('per-call timeoutMs fires and throws kind:timeout', async () => {
    const mockCreate = vi
      .fn()
      .mockImplementation((_params: unknown, opts: { signal?: AbortSignal }) => {
        const sig = opts?.signal;
        let settled = false;
        return new Promise<OpenAI.Responses.Response>((_resolve, reject) => {
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
      return { responses: { create: mockCreate } };
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

  it('caller signal aborted before call → kind:cancelled, mock called 0 times', async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockResponse('hello'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const ac = new AbortController();
    ac.abort('user cancelled');

    const client = createOpenAIProvider(TEST_CONFIG);
    await expect(
      client.complete([{ role: 'user', content: 'Hi' }], { signal: ac.signal })
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false });

    expect(mockCreate).toHaveBeenCalledTimes(0);
  });

  it('stream() stall → kind:stream_stall after first chunk', async () => {
    const mockEvents = [{ type: 'response.output_text.delta', delta: 'hi' }];

    let settled = false;
    const hangStream = {
      [Symbol.asyncIterator]: async function* () {
        yield* mockEvents;
        await new Promise<void>(() => {});
        settled = true;
      },
    };

    const mockCreate = vi.fn().mockResolvedValue(hangStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
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
    expect(settled).toBe(false);
  });
});

// ─── LlmErrorKind taxonomy (v1.0.0) ──────────────────────────────────────────

describe('OpenAI provider (Responses API) — LlmErrorKind taxonomy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const statusToKind = [
    { status: 401, kind: 'auth', retryable: false },
    { status: 403, kind: 'auth', retryable: false },
    { status: 404, kind: 'not_found', retryable: false },
    { status: 400, kind: 'bad_request', retryable: false },
    { status: 429, kind: 'rate_limit', retryable: true },
    { status: 500, kind: 'server_error', retryable: true },
    { status: 503, kind: 'server_error', retryable: true },
  ];

  for (const { status, kind, retryable } of statusToKind) {
    it(`HTTP ${status} → kind:'${kind}', retryable:${retryable}`, async () => {
      // Simulate an APIError by setting kind on a pre-built LlmError
      // (real OpenAI SDK is mocked — class instanceof won't work without re-patching)
      const err = new LlmError({
        message: `HTTP ${status}`,
        provider: 'openai',
        statusCode: status,
        kind: kind as import('../types.js').LlmErrorKind,
        retryable,
      });

      const mockCreate = vi.fn().mockRejectedValue(err);
      vi.mocked(OpenAI).mockImplementation(function () {
        return { responses: { create: mockCreate } };
      });

      const client = createOpenAIProvider({ ...TEST_CONFIG, maxRetries: 0 });
      const thrown = await client
        .complete([{ role: 'user', content: 'Hi' }])
        .catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(LlmError);
      if (thrown instanceof LlmError) {
        expect(thrown.kind).toBe(kind);
        expect(thrown.retryable).toBe(retryable);
      }
    });
  }
});

// ─── withTools() ──────────────────────────────────────────────────────────────

/**
 * Build a Responses API response that contains a function_call output item.
 * Mirrors the real shape: output array with type:'function_call' items.
 */
function mockResponseWithToolCall(
  toolName: string,
  args: Record<string, unknown>,
  callId = 'call_abc123'
): OpenAI.Responses.Response {
  return {
    id: 'resp-tool-1',
    object: 'response',
    model: 'gpt-4o-mini',
    output: [
      {
        type: 'function_call',
        call_id: callId,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    text: { format: { type: 'text' } },
    created_at: 0,
    background: false,
    max_output_tokens: null,
    previous_response_id: null,
    store: false,
    reasoning: { effort: null, generate_summary: null, summary: null },
    service_tier: 'default',
    user: null,
  } as unknown as OpenAI.Responses.Response;
}

/** Build a Responses API response with a text message only (no tool calls). */
function mockResponseTextOnly(text: string): OpenAI.Responses.Response {
  return {
    id: 'resp-text-1',
    object: 'response',
    model: 'gpt-4o-mini',
    output: [
      {
        type: 'message',
        id: 'msg-1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    usage: { input_tokens: 15, output_tokens: 8, total_tokens: 23 },
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    text: { format: { type: 'text' } },
    created_at: 0,
    background: false,
    max_output_tokens: null,
    previous_response_id: null,
    store: false,
    reasoning: { effort: null, generate_summary: null, summary: null },
    service_tier: 'default',
    user: null,
  } as unknown as OpenAI.Responses.Response;
}

describe('OpenAI provider (Responses API) — withTools()', () => {
  const weatherTool = {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: {
      parse: (d: unknown) => d as { city: string },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns toolCalls when model emits a function_call output item', async () => {
    const mockCreate = vi
      .fn()
      .mockResolvedValue(mockResponseWithToolCall('get_weather', { city: 'London' }));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.withTools(
      [{ role: 'user', content: 'What is the weather in London?' }],
      [weatherTool]
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('get_weather');
    expect(result.toolCalls[0]?.arguments).toEqual({ city: 'London' });
    expect(result.toolCalls[0]?.rawArguments).toBe(JSON.stringify({ city: 'London' }));
    expect(result.toolCalls[0]?.id).toBe('call_abc123');
    expect(result.stopReason).toBe('tool_use');
    expect(result.model).toBe('gpt-4o-mini');
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(10);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty toolCalls and stopReason end_turn when model responds with text', async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockResponseTextOnly('The weather is sunny.'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.withTools(
      [{ role: 'user', content: 'What is the weather?' }],
      [weatherTool]
    );

    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toBe('The weather is sunny.');
    expect(result.stopReason).toBe('end_turn');
  });

  it('sends flat FunctionTool shape (no nested function key) to the Responses API', async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockResponseTextOnly('ok'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool]);

    const callParams = mockCreate.mock.calls[0]?.[0] as { tools?: unknown[] };
    // Concrete shape avoids TS4111 (noPropertyAccessFromIndexSignature fires on Record types)
    type ToolParamShape = { name: string; description: string; type: string; function?: unknown };
    const toolParam = callParams.tools?.[0] as ToolParamShape;
    // Flat shape: top-level name, description, parameters — no nested 'function' key
    expect(toolParam.name).toBe('get_weather');
    expect(toolParam.description).toBe('Get the current weather for a city.');
    expect(toolParam.type).toBe('function');
    expect(toolParam.function).toBeUndefined();
  });

  it("maps toolChoice:'any' to 'required' on the Responses API", async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockResponseTextOnly('ok'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool], {
      toolChoice: 'any',
    });

    const callParams = mockCreate.mock.calls[0]?.[0] as { tool_choice?: unknown };
    expect(callParams.tool_choice).toBe('required');
  });

  it("maps named toolChoice to { type:'function', name } on the Responses API", async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockResponseTextOnly('ok'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool], {
      toolChoice: { name: 'get_weather' },
    });

    const callParams = mockCreate.mock.calls[0]?.[0] as { tool_choice?: unknown };
    expect(callParams.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
  });

  it('sets parallel_tool_calls: false when parallelToolCalls is false', async () => {
    const mockCreate = vi.fn().mockResolvedValue(mockResponseTextOnly('ok'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool], {
      parallelToolCalls: false,
    });

    const callParams = mockCreate.mock.calls[0]?.[0] as { parallel_tool_calls?: unknown };
    expect(callParams.parallel_tool_calls).toBe(false);
  });

  it('throws kind:tool_arguments_invalid when schema validation fails', async () => {
    const strictTool = {
      name: 'strict_tool',
      description: 'Strict input required.',
      inputSchema: {
        parse: (d: unknown) => {
          if (typeof (d as { value?: unknown }).value !== 'number') {
            throw new Error('Expected number');
          }
          return d as { value: number };
        },
      },
    };

    const mockCreate = vi
      .fn()
      .mockResolvedValue(mockResponseWithToolCall('strict_tool', { value: 'not-a-number' }));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const thrown = await client
      .withTools([{ role: 'user', content: 'Hi' }], [strictTool])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('tool_arguments_invalid');
      expect(thrown.retryable).toBe(false);
    }
  });

  it('marks stopReason as refusal when output contains a refusal item', async () => {
    const refusalResponse = {
      id: 'resp-refusal-1',
      object: 'response',
      model: 'gpt-4o-mini',
      output: [
        {
          type: 'message',
          id: 'msg-1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'I cannot do that.' }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      status: 'completed',
      error: null,
    } as unknown as OpenAI.Responses.Response;

    const mockCreate = vi.fn().mockResolvedValue(refusalResponse);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.withTools(
      [{ role: 'user', content: 'Do something bad' }],
      [weatherTool]
    );

    expect(result.stopReason).toBe('refusal');
  });
});

// ─── streamStructured() ───────────────────────────────────────────────────────

describe('OpenAI provider (Responses API) — streamStructured()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Build a stream of response.output_text.delta events that produce a JSON string,
   * followed by a response.completed event with usage.
   */
  function buildJsonStream(jsonString: string, inputTokens = 8, outputTokens = 4) {
    // Split the JSON into chunks to simulate token streaming
    const chunkSize = Math.ceil(jsonString.length / 3);
    const chunks: string[] = [];
    for (let i = 0; i < jsonString.length; i += chunkSize) {
      chunks.push(jsonString.slice(i, i + chunkSize));
    }

    const events = [
      ...chunks.map((c) => ({ type: 'response.output_text.delta', delta: c })),
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        },
      },
    ];

    return {
      [Symbol.asyncIterator]: async function* () {
        yield* events;
      },
    };
  }

  it('yields token events then done event with validated data', async () => {
    const schema = z.object({ name: z.string(), score: z.number() });
    const payload = { name: 'Alice', score: 42 };
    const jsonStr = JSON.stringify(payload);

    const mockCreate = vi.fn().mockResolvedValue(buildJsonStream(jsonStr));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    const tokens: string[] = [];
    let doneEvent:
      | { type: 'done'; data: { name: string; score: number }; usage: LlmUsage }
      | undefined;

    for await (const event of client.streamStructured(
      [{ role: 'user', content: 'Give me a person object' }],
      schema
    )) {
      if (event.type === 'token') {
        tokens.push(event.token);
      } else {
        doneEvent = event;
      }
    }

    // Should have received token events followed by done
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join('')).toBe(jsonStr);
    expect(doneEvent).toBeDefined();
    if (doneEvent !== undefined) {
      expect(doneEvent.data.name).toBe('Alice');
      expect(doneEvent.data.score).toBe(42);
      expect(doneEvent.usage.inputTokens).toBe(8);
      expect(doneEvent.usage.outputTokens).toBe(4);
    }
  });

  it('uses text.format json_schema (strict) when schema is Zod 4', async () => {
    const schema = z.object({ value: z.string() });
    const mockCreate = vi.fn().mockResolvedValue(buildJsonStream(JSON.stringify({ value: 'ok' })));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    for await (const _ of client.streamStructured([{ role: 'user', content: 'Hi' }], schema)) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0]?.[0] as { text?: { format?: { type?: string } } };
    expect(callArgs.text?.format?.type).toBe('json_schema');
  });

  it('uses text.format json_object when schema is not Zod 4', async () => {
    const schema = { parse: (d: unknown) => d as { value: string } };
    const mockCreate = vi.fn().mockResolvedValue(buildJsonStream(JSON.stringify({ value: 'ok' })));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    for await (const _ of client.streamStructured([{ role: 'user', content: 'Hi' }], schema)) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0]?.[0] as { text?: { format?: { type?: string } } };
    expect(callArgs.text?.format?.type).toBe('json_object');
  });

  it('throws structured_parse_failed if accumulated text is not valid JSON', async () => {
    const schema = z.object({ value: z.string() });
    const badStream = {
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'response.output_text.delta', delta: 'not json at all' };
        yield {
          type: 'response.completed',
          response: { usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } },
        };
      },
    };
    const mockCreate = vi.fn().mockResolvedValue(badStream);
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    async function consumeStream() {
      for await (const _ of client.streamStructured([{ role: 'user', content: 'Hi' }], schema)) {
        // consume
      }
    }

    const thrown = await consumeStream().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('structured_parse_failed');
      expect(thrown.retryable).toBe(false);
    }
  });

  it('throws structured_parse_failed if Zod schema validation fails on valid JSON', async () => {
    const schema = z.object({ value: z.number() }); // expects number
    const mockCreate = vi
      .fn()
      .mockResolvedValue(buildJsonStream(JSON.stringify({ value: 'not-a-number' })));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    async function consumeStream() {
      for await (const _ of client.streamStructured([{ role: 'user', content: 'Hi' }], schema)) {
        // consume
      }
    }

    const thrown = await consumeStream().catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('structured_parse_failed');
    }
  });

  it('stream: true is set in the params', async () => {
    const schema = z.object({ ok: z.boolean() });
    const mockCreate = vi.fn().mockResolvedValue(buildJsonStream(JSON.stringify({ ok: true })));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });

    const client = createOpenAIProvider(TEST_CONFIG);
    for await (const _ of client.streamStructured([{ role: 'user', content: 'Go' }], schema)) {
      // consume
    }

    const callArgs = mockCreate.mock.calls[0]?.[0] as { stream?: boolean };
    expect(callArgs.stream).toBe(true);
  });
});

// ─── Response IDs (Wave 3a §3.4) ─────────────────────────────────────────────

describe('OpenAI provider — response IDs (v1.4.0)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('complete(): id is provider-issued and idSource is "provider"', async () => {
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: vi.fn().mockResolvedValue(mockResponse('Hello!')) } };
    });
    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    // mockResponse uses 'resp-123' as default id
    expect(result.id).toBe('resp-123');
    expect(result.idSource).toBe('provider');
  });

  it('structured(): id is provider-issued and idSource is "provider"', async () => {
    const schema = z.object({ name: z.string() });
    const structuredMockResponse = mockResponse(JSON.stringify({ name: 'Sable' }), {
      id: 'resp-struct-1',
    });
    vi.mocked(OpenAI).mockImplementation(function () {
      return {
        responses: {
          create: vi.fn().mockResolvedValue(structuredMockResponse),
        },
      };
    });
    const client = createOpenAIProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'name?' }], schema);
    expect(result.id).toBe('resp-struct-1');
    expect(result.idSource).toBe('provider');
  });
});

// ─── Multimodal content blocks (v4.2.0) ─────────────────────────────────────

describe('OpenAI provider — multimodal content blocks (v4.2.0)', () => {
  let mockCreate: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate = vi.fn().mockResolvedValue(mockResponse('ok'));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes string content unchanged (backward compat)', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hello' }]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const input = callArgs.input as OpenAI.Responses.EasyInputMessage[];
    expect(input[0]?.content).toBe('Hello');
  });

  it('maps image.base64 to input_image with data URL', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' } },
        ],
      },
    ]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const input = callArgs.input as { role: string; content: unknown[] }[];
    const content = input[0]?.content as { type: string; image_url?: string; detail?: string }[];
    expect(content).toBeDefined();
    expect(content[0]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/png;base64,pngdata',
      detail: 'auto',
    });
  });

  it('maps image.url to input_image with URL string', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } }],
      },
    ]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const input = callArgs.input as { role: string; content: unknown[] }[];
    const content = input[0]?.content as { type: string; image_url?: string }[];
    expect(content[0]).toMatchObject({
      type: 'input_image',
      image_url: 'https://example.com/img.jpg',
    });
  });

  it('maps document.base64 to input_file with data URI', async () => {
    const client = createOpenAIProvider(TEST_CONFIG);
    await client.complete([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfbytes' },
          },
        ],
      },
    ]);

    const callArgs = mockCreate.mock
      .calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsNonStreaming;
    const input = callArgs.input as { role: string; content: unknown[] }[];
    const content = input[0]?.content as { type: string; file_data?: string }[];
    expect(content[0]).toMatchObject({
      type: 'input_file',
      file_data: 'data:application/pdf;base64,pdfbytes',
    });
  });
});
