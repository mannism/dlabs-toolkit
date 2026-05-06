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
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
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
