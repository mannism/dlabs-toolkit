/**
 * Unit tests for the Files API surface (v5.1.0).
 *
 * Tests the upload → waitForActive → use → delete lifecycle on the Gemini provider,
 * plus cross-provider rejection and content-block mapping guards.
 *
 * All tests stub the @google/genai SDK — no real API calls.
 *
 * Coverage:
 *   Gemini files.upload()       — happy path, state mapping (PROCESSING/ACTIVE/FAILED)
 *   Gemini files.refresh()      — state poll returns updated state
 *   Gemini files.waitForActive() — polls until active, throws on failed, throws on timeout
 *   Gemini files.delete()       — happy path, 404 swallow
 *   mapGeminiParts file block   — active ref emits fileData part, processing ref throws
 *   cross-provider ref          — bad_request on provider mismatch
 *   OpenAI/Anthropic/DeepSeek/Perplexity stubs — upload rejects bad_request
 *   assertBlocksSupported fileRef flag — missing flag throws bad_request
 */

import { ApiError, GoogleGenAI } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { createAnthropicProvider } from './providers/anthropic.js';
import { assertBlocksSupported, mapGeminiParts } from './providers/content-blocks.js';
import { createDeepSeekProvider } from './providers/deepseek.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createPerplexityProvider } from './providers/perplexity.js';
import type { LlmClientConfig, LlmFileRef } from './types.js';

// Mock @google/genai so tests never make real API calls
vi.mock('@google/genai');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const GEMINI_CONFIG: LlmClientConfig = {
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

const OPENAI_CONFIG: LlmClientConfig = {
  provider: 'openai',
  model: 'gpt-4.1',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

const ANTHROPIC_CONFIG: LlmClientConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

const DEEPSEEK_CONFIG: LlmClientConfig = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

const PERPLEXITY_CONFIG: LlmClientConfig = {
  provider: 'perplexity',
  model: 'sonar',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

/** Build a minimal Gemini file response (as returned by ai.files.upload / ai.files.get). */
function mockGeminiFile(overrides?: {
  name?: string;
  state?: string;
  mimeType?: string;
  sizeBytes?: number;
  expirationTime?: string;
}) {
  return {
    name: overrides?.name ?? 'files/abc123',
    state: overrides?.state ?? 'ACTIVE',
    mimeType: overrides?.mimeType ?? 'video/mp4',
    sizeBytes: overrides?.sizeBytes ?? 1024 * 1024 * 5, // 5 MB
    expirationTime: overrides?.expirationTime,
  };
}

/** Build a mock LlmFileRef for a Gemini active file. */
function geminiActiveRef(overrides?: Partial<LlmFileRef>): LlmFileRef {
  return {
    id: 'files/abc123',
    provider: 'gemini',
    mediaType: 'video/mp4',
    sizeBytes: 5 * 1024 * 1024,
    state: 'active',
    ...overrides,
  };
}

// ─── Gemini files.upload() ───────────────────────────────────────────────────

describe('Gemini files.upload()', () => {
  let mockFilesUpload: MockInstance;
  let mockGenerateContent: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFilesUpload = vi.fn().mockResolvedValue(mockGeminiFile());
    mockGenerateContent = vi.fn().mockResolvedValue({ text: '' });
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: mockGenerateContent },
        files: {
          upload: mockFilesUpload,
          get: vi.fn(),
          delete: vi.fn(),
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('upload returns an LlmFileRef with active state when Gemini returns ACTIVE', async () => {
    const client = createGeminiProvider(GEMINI_CONFIG);
    const data = Buffer.alloc(1024 * 1024 * 5); // 5 MB

    const ref = await client.files.upload({ data, mediaType: 'video/mp4' });

    expect(ref.id).toBe('files/abc123');
    expect(ref.provider).toBe('gemini');
    expect(ref.mediaType).toBe('video/mp4');
    expect(ref.state).toBe('active');
    expect(ref.sizeBytes).toBeGreaterThan(0);
  });

  it('upload returns state:processing when Gemini returns PROCESSING', async () => {
    mockFilesUpload.mockResolvedValueOnce(mockGeminiFile({ state: 'PROCESSING' }));
    const client = createGeminiProvider(GEMINI_CONFIG);
    const data = Buffer.alloc(1024);

    const ref = await client.files.upload({ data, mediaType: 'video/mp4' });

    expect(ref.state).toBe('processing');
  });

  it('upload returns state:failed when Gemini returns FAILED', async () => {
    mockFilesUpload.mockResolvedValueOnce(mockGeminiFile({ state: 'FAILED' }));
    const client = createGeminiProvider(GEMINI_CONFIG);
    const data = Buffer.alloc(1024);

    const ref = await client.files.upload({ data, mediaType: 'video/mp4' });

    expect(ref.state).toBe('failed');
  });

  it('upload passes displayName to SDK config', async () => {
    const client = createGeminiProvider(GEMINI_CONFIG);
    const data = Buffer.alloc(1024);

    await client.files.upload({ data, mediaType: 'image/jpeg', displayName: 'brand-asset.jpg' });

    expect(mockFilesUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ displayName: 'brand-asset.jpg' }),
      })
    );
  });

  it('upload sets expiresAt when provider returns expirationTime', async () => {
    const expiresAt = '2026-06-18T14:00:00.000Z';
    mockFilesUpload.mockResolvedValueOnce(mockGeminiFile({ expirationTime: expiresAt }));
    const client = createGeminiProvider(GEMINI_CONFIG);

    const ref = await client.files.upload({ data: Buffer.alloc(1024), mediaType: 'video/mp4' });

    expect(ref.expiresAt).toBe(expiresAt);
  });

  it('upload normalizes SDK error to LlmError kind:network on failure', async () => {
    mockFilesUpload.mockRejectedValueOnce(new Error('ECONNRESET'));
    const client = createGeminiProvider(GEMINI_CONFIG);

    await expect(
      client.files.upload({ data: Buffer.alloc(1024), mediaType: 'video/mp4' })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'network',
      retryable: true,
    });
  });
});

// ─── Gemini files.refresh() ──────────────────────────────────────────────────

describe('Gemini files.refresh()', () => {
  let mockFilesGet: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFilesGet = vi.fn().mockResolvedValue(mockGeminiFile({ state: 'ACTIVE' }));
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: vi.fn() },
        files: {
          upload: vi.fn(),
          get: mockFilesGet,
          delete: vi.fn(),
        },
      };
    });
  });

  it('refresh re-fetches file state and returns updated ref', async () => {
    mockFilesGet.mockResolvedValueOnce(mockGeminiFile({ state: 'ACTIVE' }));
    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef({ state: 'processing' });

    const updated = await client.files.refresh(ref);

    expect(updated.state).toBe('active');
    expect(mockFilesGet).toHaveBeenCalledWith({ name: 'files/abc123' });
  });

  it('refresh returns failed state when provider reports FAILED', async () => {
    mockFilesGet.mockResolvedValueOnce(mockGeminiFile({ state: 'FAILED' }));
    const client = createGeminiProvider(GEMINI_CONFIG);

    const updated = await client.files.refresh(geminiActiveRef());

    expect(updated.state).toBe('failed');
  });

  it('refresh throws bad_request on provider mismatch', async () => {
    const client = createGeminiProvider(GEMINI_CONFIG);
    const openaiRef: LlmFileRef = {
      id: 'file-openai-123',
      provider: 'openai',
      mediaType: 'application/pdf',
      sizeBytes: 1024,
      state: 'active',
    };

    await expect(client.files.refresh(openaiRef)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
    });
  });
});

// ─── Gemini files.waitForActive() ────────────────────────────────────────────

describe('Gemini files.waitForActive()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves immediately when ref is already active', async () => {
    const mockFilesGet = vi.fn();
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: vi.fn() },
        files: { upload: vi.fn(), get: mockFilesGet, delete: vi.fn() },
      };
    });

    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef({ state: 'active' });

    const result = await client.files.waitForActive(ref);

    expect(result.state).toBe('active');
    expect(mockFilesGet).not.toHaveBeenCalled();
  });

  it('polls until ACTIVE and returns updated ref', async () => {
    const mockFilesGet = vi
      .fn()
      // First poll: still processing
      .mockResolvedValueOnce(mockGeminiFile({ state: 'PROCESSING' }))
      // Second poll: active
      .mockResolvedValueOnce(mockGeminiFile({ state: 'ACTIVE' }));

    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: vi.fn() },
        files: { upload: vi.fn(), get: mockFilesGet, delete: vi.fn() },
      };
    });

    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef({ state: 'processing' });

    // Use a very short intervalMs so the test completes quickly without fake timers
    const result = await client.files.waitForActive(ref, { intervalMs: 1, timeoutMs: 5_000 });

    expect(result.state).toBe('active');
    expect(mockFilesGet).toHaveBeenCalledTimes(2);
  });

  it('throws bad_request when file transitions to FAILED', async () => {
    const mockFilesGet = vi.fn().mockResolvedValueOnce(mockGeminiFile({ state: 'FAILED' }));

    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: vi.fn() },
        files: { upload: vi.fn(), get: mockFilesGet, delete: vi.fn() },
      };
    });

    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef({ state: 'processing' });

    // Use a very short intervalMs so it fires quickly
    await expect(
      client.files.waitForActive(ref, { intervalMs: 1, timeoutMs: 5_000 })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
      message: expect.stringContaining('failed'),
    });
  });

  it('throws bad_request immediately when initial ref state is failed', async () => {
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: vi.fn() },
        files: { upload: vi.fn(), get: vi.fn(), delete: vi.fn() },
      };
    });

    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef({ state: 'failed' });

    await expect(client.files.waitForActive(ref)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
    });
  });

  it('throws timeout:retryable when deadline is exceeded', async () => {
    // refresh never returns active — always processing
    const mockFilesGet = vi.fn().mockResolvedValue(mockGeminiFile({ state: 'PROCESSING' }));

    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: vi.fn() },
        files: { upload: vi.fn(), get: mockFilesGet, delete: vi.fn() },
      };
    });

    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef({ state: 'processing' });

    // Very short timeout so the test completes quickly
    await expect(
      client.files.waitForActive(ref, { intervalMs: 1, timeoutMs: 5 })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'timeout',
      retryable: true,
      message: expect.stringContaining('5ms'),
    });
  });
});

// ─── Gemini files.delete() ───────────────────────────────────────────────────

describe('Gemini files.delete()', () => {
  let mockFilesDelete: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFilesDelete = vi.fn().mockResolvedValue(undefined);
    vi.mocked(GoogleGenAI).mockImplementation(function () {
      return {
        models: { generateContent: vi.fn() },
        files: { upload: vi.fn(), get: vi.fn(), delete: mockFilesDelete },
      };
    });
  });

  it('deletes the file by ref.id', async () => {
    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef();

    await client.files.delete(ref);

    expect(mockFilesDelete).toHaveBeenCalledWith({ name: 'files/abc123' });
  });

  it('swallows 404 ApiError gracefully', async () => {
    // ApiError is auto-mocked by vi.mock('@google/genai') — constructor body doesn't run.
    // Manually assign status so the instanceof + status === 404 check works correctly.
    const err404 = new ApiError({ message: 'File not found', status: 404 });
    // biome-ignore lint/suspicious/noExplicitAny: manually setting status on mocked ApiError instance
    (err404 as unknown as Record<string, unknown>)['status'] = 404;
    mockFilesDelete.mockRejectedValueOnce(err404);

    const client = createGeminiProvider(GEMINI_CONFIG);
    const ref = geminiActiveRef();

    // Should not throw
    await expect(client.files.delete(ref)).resolves.toBeUndefined();
  });

  it('throws bad_request on provider mismatch', async () => {
    const client = createGeminiProvider(GEMINI_CONFIG);
    const openaiRef: LlmFileRef = {
      id: 'file-openai-123',
      provider: 'openai',
      mediaType: 'application/pdf',
      sizeBytes: 1024,
      state: 'active',
    };

    await expect(client.files.delete(openaiRef)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
    });
  });
});

// ─── mapGeminiParts — file block ─────────────────────────────────────────────

describe('mapGeminiParts — file block', () => {
  it('emits fileData part for an active Gemini file ref', () => {
    const ref = geminiActiveRef({ state: 'active', mediaType: 'video/mp4' });
    const blocks = [{ type: 'file' as const, ref }];

    const parts = mapGeminiParts(blocks);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      fileData: { fileUri: 'files/abc123', mimeType: 'video/mp4' },
    });
  });

  it('throws bad_request when file ref is in processing state', () => {
    const ref = geminiActiveRef({ state: 'processing' });
    const blocks = [{ type: 'file' as const, ref }];

    expect(() => mapGeminiParts(blocks)).toThrow(
      expect.objectContaining({
        name: 'LlmError',
        kind: 'bad_request',
        retryable: false,
        message: expect.stringContaining('waitForActive'),
      })
    );
  });

  it('mixes text and file parts correctly', () => {
    const ref = geminiActiveRef();
    const blocks = [
      { type: 'text' as const, text: 'Describe this video.' },
      { type: 'file' as const, ref },
    ];

    const parts = mapGeminiParts(blocks);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: 'Describe this video.' });
    expect(parts[1]).toHaveProperty('fileData');
  });
});

// ─── assertBlocksSupported — cross-provider file ref ─────────────────────────

describe('assertBlocksSupported — file blocks', () => {
  it('throws bad_request when provider does not support fileRef', () => {
    const ref = geminiActiveRef();
    const messages = [{ role: 'user' as const, content: [{ type: 'file' as const, ref }] }];

    expect(() =>
      assertBlocksSupported(messages, 'deepseek', {
        textBlock: true,
        imageBase64: true,
        imageUrl: false,
        documentBase64: false,
        fileRef: false,
      })
    ).toThrow(
      expect.objectContaining({
        name: 'LlmError',
        kind: 'bad_request',
        retryable: false,
        message: expect.stringContaining('Files API is not available'),
      })
    );
  });

  it('throws bad_request on cross-provider ref (openai ref sent to gemini)', () => {
    const openaiRef: LlmFileRef = {
      id: 'file-openai-xyz',
      provider: 'openai',
      mediaType: 'application/pdf',
      sizeBytes: 1024,
      state: 'active',
    };
    const messages = [
      { role: 'user' as const, content: [{ type: 'file' as const, ref: openaiRef }] },
    ];

    expect(() =>
      assertBlocksSupported(messages, 'gemini', {
        textBlock: true,
        imageBase64: true,
        imageUrl: false,
        documentBase64: true,
        fileRef: true,
      })
    ).toThrow(
      expect.objectContaining({
        name: 'LlmError',
        kind: 'bad_request',
        retryable: false,
        message: expect.stringContaining("ref is 'openai', client is 'gemini'"),
      })
    );
  });

  it('passes for matching provider ref', () => {
    const ref = geminiActiveRef();
    const messages = [{ role: 'user' as const, content: [{ type: 'file' as const, ref }] }];

    // Should not throw
    expect(() =>
      assertBlocksSupported(messages, 'gemini', {
        textBlock: true,
        imageBase64: true,
        imageUrl: false,
        documentBase64: true,
        fileRef: true,
      })
    ).not.toThrow();
  });
});

// ─── Non-Gemini provider stubs ────────────────────────────────────────────────

describe('OpenAI files.upload() — non-PDF rejects', () => {
  it('rejects video/mp4 with bad_request (pre-SDK guard — no API call made)', async () => {
    // The bad_request guard fires before any SDK call, so no mock needed.
    const client = createOpenAIProvider(OPENAI_CONFIG);

    await expect(
      client.files.upload({ data: Buffer.alloc(1024), mediaType: 'video/mp4' })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
      message: expect.stringContaining("'openai' does not support media type 'video/mp4'"),
    });
  });

  it('rejects image/jpeg with bad_request (pre-SDK guard)', async () => {
    const client = createOpenAIProvider(OPENAI_CONFIG);

    await expect(
      client.files.upload({ data: Buffer.alloc(1024), mediaType: 'image/jpeg' })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
    });
  });
});

describe('DeepSeek files — all methods throw bad_request', () => {
  it('upload throws bad_request', async () => {
    const client = createDeepSeekProvider(DEEPSEEK_CONFIG);

    await expect(
      client.files.upload({ data: Buffer.alloc(1024), mediaType: 'video/mp4' })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
    });
  });

  it('refresh throws bad_request', async () => {
    const client = createDeepSeekProvider(DEEPSEEK_CONFIG);
    const fakeRef = geminiActiveRef();

    await expect(client.files.refresh(fakeRef)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
    });
  });

  it('waitForActive throws bad_request', async () => {
    const client = createDeepSeekProvider(DEEPSEEK_CONFIG);
    const fakeRef = geminiActiveRef();

    await expect(client.files.waitForActive(fakeRef)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
    });
  });

  it('delete throws bad_request', async () => {
    const client = createDeepSeekProvider(DEEPSEEK_CONFIG);
    const fakeRef = geminiActiveRef();

    await expect(client.files.delete(fakeRef)).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
    });
  });
});

describe('Perplexity files — all methods throw bad_request', () => {
  it('upload throws bad_request', async () => {
    const client = createPerplexityProvider(PERPLEXITY_CONFIG);

    await expect(
      client.files.upload({ data: Buffer.alloc(1024), mediaType: 'application/pdf' })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
    });
  });
});

describe('Anthropic files.upload() — video/* rejects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects video/mp4 with bad_request', async () => {
    const client = createAnthropicProvider(ANTHROPIC_CONFIG);

    await expect(
      client.files.upload({ data: Buffer.alloc(1024), mediaType: 'video/mp4' })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
      retryable: false,
      message: expect.stringContaining("'anthropic' does not support media type 'video/mp4'"),
    });
  });

  it('rejects video/quicktime with bad_request', async () => {
    const client = createAnthropicProvider(ANTHROPIC_CONFIG);

    await expect(
      client.files.upload({ data: Buffer.alloc(1024), mediaType: 'video/quicktime' })
    ).rejects.toMatchObject({
      name: 'LlmError',
      kind: 'bad_request',
    });
  });
});
