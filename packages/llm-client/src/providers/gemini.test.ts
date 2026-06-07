/**
 * Unit tests for the Gemini provider.
 *
 * All tests use vi.mock to stub @google/genai. No real API calls.
 *
 * Test coverage:
 * - complete(): happy path, usage normalization, model override, system message, error handling
 * - stream(): token chunks, usage on final chunk, error handling
 * - structured(): JSON parse success, markdown fence stripping, parse failure, schema failure
 *
 * Note: normalizeGeminiError() is tested separately in error-normalize.test.ts which
 * does not mock @google/genai, allowing real ApiError instanceof checks to work correctly.
 */

import { GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import type { LlmClientConfig, LlmUsage } from '../types.js';
import { LlmError } from '../types.js';
import { createGeminiProvider } from './gemini.js';

// Mock the @google/genai SDK so tests never make real API calls
vi.mock('@google/genai');

const TEST_CONFIG: LlmClientConfig = {
  provider: 'gemini',
  model: 'gemini-2.0-flash',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

/** Build a minimal GenerateContentResponse mock. */
function mockGeminiResponse(overrides?: {
  text?: string;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}) {
  return {
    text: overrides?.text ?? 'Hello, world!',
    usageMetadata: {
      promptTokenCount: overrides?.promptTokenCount ?? 10,
      candidatesTokenCount: overrides?.candidatesTokenCount ?? 5,
      totalTokenCount: overrides?.totalTokenCount ?? 15,
    },
  };
}

describe('Gemini provider — complete()', () => {
  let mockGenerateContent: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent = vi.fn().mockResolvedValue(mockGeminiResponse());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });
  });

  it('returns normalized LlmResponse on success', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello, world!');
    expect(result.model).toBe('gemini-2.0-flash');
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(15);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('extracts system message and passes via config.systemInstruction', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.complete([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hi' },
    ]);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      model: string;
      contents: unknown[];
      config?: { systemInstruction?: string };
    };
    expect(callArgs.config?.systemInstruction).toBe('You are a helpful assistant.');
    // System message should not appear in contents
    expect(callArgs.contents).toHaveLength(1);
  });

  it('maps assistant role to model role in contents', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.complete([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Goodbye' },
    ]);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      contents: Array<{ role: string }>;
    };
    expect(callArgs.contents[1]?.role).toBe('model');
  });

  it('applies model override from options', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      model: 'gemini-1.5-pro',
    });

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as { model: string };
    expect(callArgs.model).toBe('gemini-1.5-pro');
  });

  it('applies maxTokens and temperature when set', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hi' }], {
      maxTokens: 256,
      temperature: 0.3,
    });

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: { maxOutputTokens?: number; temperature?: number };
    };
    expect(callArgs.config?.maxOutputTokens).toBe(256);
    expect(callArgs.config?.temperature).toBe(0.3);
  });

  it('returns empty string content when response.text is undefined', async () => {
    mockGenerateContent.mockResolvedValue({ text: undefined, usageMetadata: undefined });
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('');
  });

  it('normalizes usage to zeros when usageMetadata is absent', async () => {
    mockGenerateContent.mockResolvedValue({ text: 'Hi', usageMetadata: undefined });
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
  });

  it('throws LlmError on error', async () => {
    // Use a pre-constructed LlmError to simulate what normalizeGeminiError produces.
    // Real ApiError instanceof checks are tested in error-normalize.test.ts (unmocked).
    const err = new LlmError({
      message: 'Unauthorized',
      provider: 'gemini',
      statusCode: 401,
      retryable: false,
    });
    mockGenerateContent.mockRejectedValue(err);
    const client = createGeminiProvider(TEST_CONFIG);
    await expect(client.complete([{ role: 'user', content: 'Hi' }])).rejects.toBeInstanceOf(
      LlmError
    );
  });

  it('retries on 429 and eventually succeeds', async () => {
    const retryableErr = new LlmError({
      message: 'Rate limited',
      provider: 'gemini',
      statusCode: 429,
      retryable: true,
    });
    mockGenerateContent.mockRejectedValueOnce(retryableErr).mockResolvedValue(mockGeminiResponse());

    const clientWithRetry = createGeminiProvider({
      ...TEST_CONFIG,
      maxRetries: 2,
      baseDelayMs: 0,
    });

    const result = await clientWithRetry.complete([{ role: 'user', content: 'Hi' }]);
    expect(result.content).toBe('Hello, world!');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});

describe('Gemini provider — stream()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('yields token chunks and usage from stream', async () => {
    const chunks = [
      { text: 'Hello', usageMetadata: undefined },
      { text: ', world!', usageMetadata: undefined },
      {
        text: undefined,
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    ];

    async function* fakeStream() {
      yield* chunks;
    }

    const mockGenerateContentStream = vi.fn().mockResolvedValue(fakeStream());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: vi.fn(),
          generateContentStream: mockGenerateContentStream,
        },
      };
    });

    const client = createGeminiProvider(TEST_CONFIG);
    const tokens: string[] = [];
    let finalUsage: LlmUsage | undefined;

    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage !== undefined) {
        finalUsage = chunk.usage;
      } else if (chunk.token.length > 0) {
        tokens.push(chunk.token);
      }
    }

    expect(tokens).toEqual(['Hello', ', world!']);
    expect(finalUsage).toBeDefined();
    if (finalUsage !== undefined) {
      expect((finalUsage as { inputTokens: number }).inputTokens).toBe(10);
      expect((finalUsage as { outputTokens: number }).outputTokens).toBe(5);
    }
  });

  it('throws LlmError when stream init fails', async () => {
    const err = new LlmError({ message: 'Connection failed', provider: 'gemini', retryable: true });
    const mockGenerateContentStream = vi.fn().mockRejectedValue(err);
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: vi.fn(),
          generateContentStream: mockGenerateContentStream,
        },
      };
    });

    const client = createGeminiProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        // consume
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('throws LlmError when stream fails mid-iteration', async () => {
    const streamErr = new LlmError({
      message: 'Stream broken',
      provider: 'gemini',
      statusCode: 500,
      retryable: false,
    });

    async function* failingStream() {
      yield { text: 'partial', usageMetadata: undefined };
      throw streamErr;
    }

    const mockGenerateContentStream = vi.fn().mockResolvedValue(failingStream());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: vi.fn(),
          generateContentStream: mockGenerateContentStream,
        },
      };
    });

    const client = createGeminiProvider(TEST_CONFIG);

    async function consumeStream() {
      for await (const _ of client.stream([{ role: 'user', content: 'Hi' }])) {
        // consume
      }
    }

    await expect(consumeStream()).rejects.toBeInstanceOf(LlmError);
  });

  it('yields no usage chunk when no chunk has usageMetadata', async () => {
    async function* noUsageStream() {
      yield { text: 'token', usageMetadata: undefined };
    }

    const mockGenerateContentStream = vi.fn().mockResolvedValue(noUsageStream());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: vi.fn(),
          generateContentStream: mockGenerateContentStream,
        },
      };
    });

    const client = createGeminiProvider(TEST_CONFIG);
    const usageChunks: unknown[] = [];

    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage !== undefined) usageChunks.push(chunk.usage);
    }

    expect(usageChunks).toHaveLength(0);
  });

  it('skips empty text chunks', async () => {
    async function* streamWithEmpty() {
      yield { text: '', usageMetadata: undefined };
      yield { text: 'real', usageMetadata: undefined };
    }

    const mockGenerateContentStream = vi.fn().mockResolvedValue(streamWithEmpty());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: vi.fn(),
          generateContentStream: mockGenerateContentStream,
        },
      };
    });

    const client = createGeminiProvider(TEST_CONFIG);
    const tokens: string[] = [];

    for await (const chunk of client.stream([{ role: 'user', content: 'Hi' }])) {
      if (chunk.usage === undefined) tokens.push(chunk.token);
    }

    expect(tokens).toEqual(['real']);
  });
});

describe('Gemini provider — structured()', () => {
  let mockGenerateContent: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent = vi.fn();
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });
  });

  it('parses valid JSON response and validates schema', async () => {
    mockGenerateContent.mockResolvedValue(
      mockGeminiResponse({ text: '{"name":"Alice","age":30}' })
    );

    const schema = {
      parse: (data: unknown) => {
        const d = data as { name: string; age: number };
        if (typeof d.name !== 'string') throw new Error('name must be string');
        if (typeof d.age !== 'number') throw new Error('age must be number');
        return d;
      },
    };

    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured(
      [{ role: 'user', content: 'Return a person object' }],
      schema
    );

    expect(result.data.name).toBe('Alice');
    expect(result.data.age).toBe(30);
    expect(result.usage.inputTokens).toBe(10);
  });

  it('strips markdown code fences from response', async () => {
    mockGenerateContent.mockResolvedValue(
      mockGeminiResponse({ text: '```json\n{"value":42}\n```' })
    );

    const schema = { parse: (data: unknown) => data as { value: number } };
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return JSON' }], schema);

    expect(result.data.value).toBe(42);
  });

  it('throws LlmError on invalid JSON response', async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiResponse({ text: 'This is not JSON' }));

    const schema = { parse: (data: unknown) => data };
    const client = createGeminiProvider(TEST_CONFIG);

    await expect(
      client.structured([{ role: 'user', content: 'Return JSON' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('not valid JSON'),
      retryable: false,
    });
  });

  it('throws LlmError on schema validation failure', async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiResponse({ text: '{"wrong":"shape"}' }));

    const schema = {
      parse: (data: unknown) => {
        const d = data as Record<string, unknown>;
        if (!('required_field' in d)) throw new Error('missing required_field');
        return d;
      },
    };

    const client = createGeminiProvider(TEST_CONFIG);

    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toMatchObject({
      message: expect.stringContaining('schema validation'),
      retryable: false,
    });
  });

  it('passes responseMimeType: application/json in config', async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiResponse({ text: '{"ok":true}' }));

    const schema = { parse: (data: unknown) => data as { ok: boolean } };
    const client = createGeminiProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: { responseMimeType?: string };
    };
    expect(callArgs.config?.responseMimeType).toBe('application/json');
  });

  it('injects JSON system instruction', async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiResponse({ text: '{"ok":true}' }));

    const schema = { parse: (data: unknown) => data as { ok: boolean } };
    const client = createGeminiProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], schema);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: { systemInstruction?: string };
    };
    expect(callArgs.config?.systemInstruction).toContain('valid JSON');
  });

  it('throws LlmError when the API call itself rejects', async () => {
    // Exercises the catch block in structured()'s withRetry callback (gemini.ts line 255).
    // maxRetries: 0 so the error propagates immediately without retry.
    mockGenerateContent.mockRejectedValue(
      new LlmError({
        message: 'Service unavailable',
        provider: 'gemini',
        statusCode: 503,
        retryable: false,
      })
    );
    const schema = { parse: (data: unknown) => data };

    const client = createGeminiProvider(TEST_CONFIG);
    await expect(
      client.structured([{ role: 'user', content: 'Return data' }], schema)
    ).rejects.toBeInstanceOf(LlmError);
  });
});

// ─── Abort / timeout / stall smoke tests ─────────────────────────────────────
//
// Gemini uses Promise.race rather than a direct SDK signal. The mock here lets
// the SDK promise hang while the abort-race promise wins.

describe('Gemini provider — abort / timeout / stall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('per-call timeoutMs override fires before client default', async () => {
    // generateContent never resolves — Promise.race wins via abort-rejection.
    const mockGenerateContent = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });

    const client = createGeminiProvider({ ...TEST_CONFIG, timeoutMs: 30_000, maxRetries: 0 });
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
    const mockGenerateContent = vi.fn().mockResolvedValue(mockGeminiResponse());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });

    const ac = new AbortController();
    ac.abort('user cancelled');

    const client = createGeminiProvider(TEST_CONFIG);
    await expect(
      client.complete([{ role: 'user', content: 'Hi' }], { signal: ac.signal })
    ).rejects.toMatchObject({ kind: 'cancelled', retryable: false });

    // Pre-aborted signal → withRetry throws before calling fn → 0 SDK calls
    expect(mockGenerateContent).toHaveBeenCalledTimes(0);
  });

  it('stream() stall → kind:"stream_stall" after first chunk', async () => {
    const hangStream = {
      [Symbol.asyncIterator]: async function* () {
        yield mockGeminiResponse({ text: 'hi' });
        await new Promise<void>(() => {}); // hang
      },
    };

    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: vi.fn(),
          generateContentStream: vi.fn().mockResolvedValue(hangStream),
        },
      };
    });

    const client = createGeminiProvider(TEST_CONFIG);
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

// ─── v0.4.0 — strict structured output tests ─────────────────────────────────

describe('Gemini provider — structured() v0.4.0 strict mode (responseSchema)', () => {
  let mockGenerateContent: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent = vi.fn();
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });
  });

  it('(a) Zod 4 schema → SDK params include responseSchema; data validated against schema', async () => {
    const zodSchema = z.object({ topic: z.string(), bullets: z.array(z.string()) });
    mockGenerateContent.mockResolvedValue(
      mockGeminiResponse({ text: '{"topic":"AI","bullets":["fast","cheap"]}' })
    );

    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Summarize' }], zodSchema);

    // Verify responseSchema was passed to the SDK
    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: { responseSchema?: unknown; responseMimeType?: string };
    };
    expect(callArgs?.config?.responseSchema).toBeDefined();
    expect(callArgs?.config?.responseMimeType).toBe('application/json');

    // Verify data
    expect(result.data.topic).toBe('AI');
    expect(result.data.bullets).toEqual(['fast', 'cheap']);
    expect(result.model).toBe('gemini-2.0-flash');
  });

  it('(b) Gemini emits fenced JSON despite responseSchema → fence-strip absorbs and data parses', async () => {
    const zodSchema = z.object({ value: z.number() });
    // Simulate Gemini wrapping JSON in markdown fences despite responseSchema
    mockGenerateContent.mockResolvedValue(
      mockGeminiResponse({ text: '```json\n{"value":42}\n```' })
    );

    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured(
      [{ role: 'user', content: 'Return a value' }],
      zodSchema
    );

    // Fence-strip absorbed; data should be correctly parsed
    expect(result.data.value).toBe(42);
  });

  it('(c) narrow {parse} schema falls through to prompt-only path (no responseSchema)', async () => {
    const narrowSchema = { parse: (data: unknown) => data as { ok: boolean } };
    mockGenerateContent.mockResolvedValue(mockGeminiResponse({ text: '{"ok":true}' }));

    const client = createGeminiProvider(TEST_CONFIG);
    await client.structured([{ role: 'user', content: 'Return data' }], narrowSchema);

    // Prompt fallback: responseSchema should not be set
    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: { responseSchema?: unknown; responseMimeType?: string };
    };
    expect(callArgs?.config?.responseSchema).toBeUndefined();
    // responseMimeType still set (prompt fallback also sets it)
    expect(callArgs?.config?.responseMimeType).toBe('application/json');
  });
});

// ─── v0.4.4 — robust JSON extraction in prompt-fallback ──────────────────────

describe('Gemini provider — structured() prompt-fallback: robust JSON extraction (v0.4.4)', () => {
  let mockGenerateContent: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent = vi.fn();
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: mockGenerateContent, generateContentStream: vi.fn() },
      };
    });
  });

  // Use a narrow (non-Zod) schema to force the prompt fallback path.
  const schema = { parse: (data: unknown) => data as { value: number } };

  it('parses JSON wrapped in fences with trailing prose', async () => {
    const raw = '```json\n{"value":21}\n```\n\nHere is some follow-up text from Gemini.';
    mockGenerateContent.mockResolvedValue({ text: raw, usageMetadata: undefined });

    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);
    expect(result.data.value).toBe(21);
  });

  it('parses JSON when prose precedes the fence', async () => {
    const raw = 'Here is the requested JSON:\n```json\n{"value":99}\n```';
    mockGenerateContent.mockResolvedValue({ text: raw, usageMetadata: undefined });

    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);
    expect(result.data.value).toBe(99);
  });

  it('parses JSON when there is no closing fence', async () => {
    const raw = '```json\n{"value":33}';
    mockGenerateContent.mockResolvedValue({ text: raw, usageMetadata: undefined });

    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'Return data' }], schema);
    expect(result.data.value).toBe(33);
  });

  it('error message contains ≥500 chars of raw content on parse failure', async () => {
    const longProse = 'Completely unstructured text here. '.repeat(25); // ~875 chars
    mockGenerateContent.mockResolvedValue({ text: longProse, usageMetadata: undefined });

    const client = createGeminiProvider(TEST_CONFIG);
    try {
      await client.structured([{ role: 'user', content: 'Return data' }], schema);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      if (e instanceof LlmError) {
        const prefix = 'Gemini structured output: response is not valid JSON. Raw: ';
        const rawPortion = e.message.slice(prefix.length);
        expect(rawPortion.length).toBeGreaterThanOrEqual(500);
      }
    }
  });
});

// ─── withTools() ──────────────────────────────────────────────────────────────

/**
 * Build a Gemini response shape with a functionCall part in the first candidate.
 * Gemini does not issue call IDs — the provider synthesizes them.
 */
function mockGeminiToolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  finishReason = 'STOP'
) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: toolName, args } }],
        },
        finishReason,
      },
    ],
    usageMetadata: {
      promptTokenCount: 20,
      candidatesTokenCount: 10,
      totalTokenCount: 30,
    },
    modelVersion: 'gemini-2.0-flash',
  };
}

/** Gemini response with a text part only (no function calls). */
function mockGeminiTextResponse(text: string, finishReason = 'STOP') {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }],
        },
        finishReason,
      },
    ],
    usageMetadata: {
      promptTokenCount: 15,
      candidatesTokenCount: 8,
      totalTokenCount: 23,
    },
    modelVersion: 'gemini-2.0-flash',
  };
}

describe('Gemini provider — withTools()', () => {
  let mockGenerateContent: MockInstance;

  // kind:'zod' fixture — standard path
  const weatherTool = {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: {
      kind: 'zod' as const,
      schema: z.object({ city: z.string() }),
    },
  };

  // kind:'jsonSchema' with validate
  const weatherToolJsonSchemaValidate = {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: {
      kind: 'jsonSchema' as const,
      schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      validate: (d: unknown) => d as { city: string },
    },
  };

  // kind:'jsonSchema' without validate
  const weatherToolJsonSchema = {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    inputSchema: {
      kind: 'jsonSchema' as const,
      schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent = vi
      .fn()
      .mockResolvedValue(mockGeminiToolCallResponse('get_weather', { city: 'Tokyo' }));
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });
  });

  it('returns toolCalls with synthesized IDs when model emits a functionCall part', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.withTools(
      [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      [weatherTool]
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('get_weather');
    expect(result.toolCalls[0]?.arguments).toEqual({ city: 'Tokyo' });
    // Synthesized ID — just check it is a non-empty string
    expect(typeof result.toolCalls[0]?.id).toBe('string');
    expect(result.toolCalls[0]?.id.length).toBeGreaterThan(0);
    expect(result.stopReason).toBe('tool_use');
    expect(result.model).toBe('gemini-2.0-flash');
    expect(result.usage.inputTokens).toBe(20);
    expect(result.usage.outputTokens).toBe(10);
  });

  it('returns empty toolCalls and stopReason end_turn when model responds with text', async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiTextResponse('It is sunny.'));

    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.withTools([{ role: 'user', content: 'Hello' }], [weatherTool]);

    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toBe('It is sunny.');
    expect(result.stopReason).toBe('end_turn');
  });

  it('sends functionDeclarations with parametersJsonSchema field (not parameters)', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool]);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: {
        tools?: Array<{ functionDeclarations?: unknown[] }>;
      };
    };
    const decls = callArgs.config?.tools?.[0]?.functionDeclarations;
    expect(Array.isArray(decls)).toBe(true);
    // Concrete shape avoids TS4111 (noPropertyAccessFromIndexSignature fires on Record types)
    type DeclShape = { name: string; parametersJsonSchema?: unknown; parameters?: unknown };
    const decl = decls?.[0] as DeclShape;
    expect(decl.name).toBe('get_weather');
    // parametersJsonSchema is the plain JSON Schema field (not Gemini's Schema type 'parameters')
    expect(decl.parametersJsonSchema).toBeDefined();
    expect(decl.parameters).toBeUndefined();
  });

  it("maps toolChoice:'none' to mode:'NONE' in toolConfig", async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiTextResponse('ok'));
    const client = createGeminiProvider(TEST_CONFIG);
    await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool], {
      toolChoice: 'none',
    });

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: { toolConfig?: { function_calling_config?: { mode?: string } } };
    };
    expect(callArgs.config?.toolConfig?.function_calling_config?.mode).toBe('NONE');
  });

  it("maps toolChoice:'any' to mode:'ANY' in toolConfig", async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool], {
      toolChoice: 'any',
    });

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      config?: { toolConfig?: { function_calling_config?: { mode?: string } } };
    };
    expect(callArgs.config?.toolConfig?.function_calling_config?.mode).toBe('ANY');
  });

  it('maps SAFETY finishReason to stopReason content_filter', async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiTextResponse('', 'SAFETY'));
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool]);
    expect(result.stopReason).toBe('content_filter');
  });

  it('maps MAX_TOKENS finishReason to stopReason max_tokens', async () => {
    mockGenerateContent.mockResolvedValue(mockGeminiTextResponse('partial', 'MAX_TOKENS'));
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.withTools([{ role: 'user', content: 'Hi' }], [weatherTool]);
    expect(result.stopReason).toBe('max_tokens');
  });

  it('throws kind:tool_arguments_invalid when schema validation fails (kind:zod)', async () => {
    const strictTool = {
      name: 'strict_tool',
      description: 'Strict.',
      inputSchema: {
        kind: 'zod' as const,
        schema: z.object({ count: z.number() }),
      },
    };

    mockGenerateContent.mockResolvedValue(
      mockGeminiToolCallResponse('strict_tool', { count: 'wrong' })
    );

    const client = createGeminiProvider(TEST_CONFIG);
    const thrown = await client
      .withTools([{ role: 'user', content: 'Hi' }], [strictTool])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('tool_arguments_invalid');
      expect(thrown.retryable).toBe(false);
    }
  });

  it('validates with kind:jsonSchema validate function when present', async () => {
    mockGenerateContent.mockResolvedValue(
      mockGeminiToolCallResponse('get_weather', { city: 'Seoul' })
    );
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.withTools(
      [{ role: 'user', content: 'Weather in Seoul?' }],
      [weatherToolJsonSchemaValidate]
    );
    expect(result.toolCalls[0]?.arguments).toEqual({ city: 'Seoul' });
  });

  it('passes raw args through when kind:jsonSchema has no validate function', async () => {
    mockGenerateContent.mockResolvedValue(
      mockGeminiToolCallResponse('get_weather', { city: 'Amsterdam' })
    );
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.withTools(
      [{ role: 'user', content: 'Weather in Amsterdam?' }],
      [weatherToolJsonSchema]
    );
    expect(result.toolCalls[0]?.arguments).toEqual({ city: 'Amsterdam' });
  });

  it('throws kind:tool_schema_invalid for legacy bare { parse: fn } inputSchema', async () => {
    const legacyTool = {
      name: 'legacy_tool',
      description: 'Legacy.',
      // biome-ignore lint/suspicious/noExplicitAny: intentionally testing legacy shape rejection
      inputSchema: { parse: (d: unknown) => d } as any,
    };

    const client = createGeminiProvider(TEST_CONFIG);
    const thrown = await client
      .withTools([{ role: 'user', content: 'Hi' }], [legacyTool])
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('tool_schema_invalid');
      expect(thrown.retryable).toBe(false);
      expect(thrown.message).toContain('v5 migration');
    }
  });
});

// ─── streamStructured() pre-call throw ───────────────────────────────────────

describe('Gemini provider — streamStructured() pre-call throw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws LlmError with kind:bad_request immediately without calling the API', async () => {
    const mockGenerateContent = vi.fn();
    const mockGenerateContentStream = vi.fn();
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: mockGenerateContentStream,
        },
      };
    });

    const client = createGeminiProvider({
      ...TEST_CONFIG,
      model: 'gemini-1.5-flash',
    });

    const thrown = await (async () => {
      for await (const _ of client.streamStructured([{ role: 'user', content: 'Hi' }], {
        parse: (d: unknown) => d,
      })) {
        // consume
      }
    })().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(LlmError);
    if (thrown instanceof LlmError) {
      expect(thrown.kind).toBe('bad_request');
      expect(thrown.retryable).toBe(false);
      expect(thrown.message).toContain('streamStructured()');
    }

    // No API call should have been made
    expect(mockGenerateContent).not.toHaveBeenCalled();
    expect(mockGenerateContentStream).not.toHaveBeenCalled();
  });
});

// ─── Response IDs (Wave 3a §3.4) ─────────────────────────────────────────────

describe('Gemini provider — response IDs (v1.4.0)', () => {
  let mockGenerateContent: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent = vi.fn().mockResolvedValue(mockGeminiResponse());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });
  });

  it('complete(): id is synthesized (non-empty string) and idSource is "synthesized"', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.complete([{ role: 'user', content: 'Hi' }]);
    // Gemini does not issue native response IDs — toolkit synthesizes a UUID v7-style ID.
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.idSource).toBe('synthesized');
  });

  it('structured(): id is synthesized and idSource is "synthesized"', async () => {
    const schema = z.object({ name: z.string() });
    mockGenerateContent.mockResolvedValue({
      ...mockGeminiResponse(),
      text: JSON.stringify({ name: 'Sable' }),
    });
    const client = createGeminiProvider(TEST_CONFIG);
    const result = await client.structured([{ role: 'user', content: 'name?' }], schema);
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.idSource).toBe('synthesized');
  });
});

// ─── Multimodal content blocks (v4.2.0) ─────────────────────────────────────

describe('Gemini provider — multimodal content blocks (v4.2.0)', () => {
  let mockGenerateContent: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateContent = vi.fn().mockResolvedValue(mockGeminiResponse());
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: {
          generateContent: mockGenerateContent,
          generateContentStream: vi.fn(),
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes string content unchanged (backward compat)', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.complete([{ role: 'user', content: 'Hello' }]);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      contents: { parts: { text?: string }[] }[];
    };
    expect(callArgs.contents[0]?.parts[0]?.text).toBe('Hello');
  });

  it('maps image.base64 to inlineData part', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.complete([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' } },
          { type: 'text', text: 'What is in this image?' },
        ],
      },
    ]);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      contents: { parts: { inlineData?: { mimeType: string; data: string }; text?: string }[] }[];
    };
    const parts = callArgs.contents[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({ inlineData: { mimeType: 'image/png', data: 'pngdata' } });
    expect(parts[1]).toMatchObject({ text: 'What is in this image?' });
  });

  it('maps document.base64 to inlineData PDF part', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await client.complete([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfdatahere' },
          },
          { type: 'text', text: 'Summarize this PDF.' },
        ],
      },
    ]);

    const callArgs = mockGenerateContent.mock.calls[0]?.[0] as {
      contents: { parts: { inlineData?: { mimeType: string; data: string } }[] }[];
    };
    const parts = callArgs.contents[0]?.parts ?? [];
    expect(parts[0]).toMatchObject({
      inlineData: { mimeType: 'application/pdf', data: 'pdfdatahere' },
    });
  });

  it('rejects image.url with bad_request before any SDK call', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    await expect(
      client.complete([
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } }],
        },
      ])
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false });

    // SDK must NOT have been called
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('error message for image.url rejection names provider and source type', async () => {
    const client = createGeminiProvider(TEST_CONFIG);
    try {
      await client.complete([
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } }],
        },
      ]);
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const e = err as LlmError;
      expect(e.message).toContain("Provider 'gemini'");
      expect(e.message).toContain('url');
    }
  });
});
