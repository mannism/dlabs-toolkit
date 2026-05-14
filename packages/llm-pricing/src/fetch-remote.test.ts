/**
 * Tests for fetchRemoteTable() — the opt-in remote pricing source.
 *
 * Uses vi.stubGlobal('fetch', ...) to mock the native fetch API.
 * No network calls in tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPricingCache, fetchRemoteTable } from './fetch-remote.js';
import { DEFAULT_PRICING_TABLE } from './table.js';
import type { PricingTable } from './types.js';

// ─── Test fixture ─────────────────────────────────────────────────────────────

/** Minimal valid PricingTable for test use. */
const MOCK_TABLE: PricingTable = {
  versionedAt: '2026-05-14',
  anthropic: {
    'claude-sonnet-4-6': {
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      verifiedAt: '2026-05-14',
      sourceUrl: 'https://platform.claude.com/docs/en/docs/about-claude/pricing',
    },
  },
  openai: {
    'gpt-5.4': {
      inputPer1M: 2.5,
      outputPer1M: 15.0,
      verifiedAt: '2026-05-14',
      sourceUrl: 'https://openai.com/pricing',
    },
  },
  gemini: {
    'gemini-2.5-flash': {
      inputPer1M: 0.3,
      outputPer1M: 2.5,
      verifiedAt: '2026-05-14',
      sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    },
  },
  deepseek: {
    'deepseek-v4-flash': {
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      verifiedAt: '2026-05-14',
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    },
  },
  perplexity: {
    sonar: {
      inputPer1M: 1.0,
      outputPer1M: 1.0,
      verifiedAt: '2026-05-14',
      sourceUrl: 'https://docs.perplexity.ai/guides/pricing',
    },
  },
};

const TEST_URL = 'https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/table.json';

/** Create a minimal fetch mock that returns the given body/status. */
function mockFetch(options: {
  ok: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  rejectWith?: Error;
}) {
  const fetchMock = options.rejectWith
    ? vi.fn().mockRejectedValue(options.rejectWith)
    : vi.fn().mockResolvedValue({
        ok: options.ok,
        status: options.status ?? (options.ok ? 200 : 500),
        statusText: options.statusText ?? (options.ok ? 'OK' : 'Internal Server Error'),
        json: vi.fn().mockResolvedValue(options.body),
      });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  // Clear the in-memory cache before each test so tests are independent
  clearPricingCache();
  // Silence console.warn output from fetch failures in test output
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('fetchRemoteTable', () => {
  describe('success path', () => {
    it('returns source: remote and the parsed table on HTTP 200', async () => {
      mockFetch({ ok: true, body: MOCK_TABLE });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('remote');
      expect(result.table).toEqual(MOCK_TABLE);
      expect(result.fetchedAt).toBeDefined();
      expect(result.error).toBeUndefined();
    });

    it('fetchedAt is a valid ISO 8601 timestamp', async () => {
      mockFetch({ ok: true, body: MOCK_TABLE });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('does not throw on success', async () => {
      mockFetch({ ok: true, body: MOCK_TABLE });

      await expect(fetchRemoteTable(TEST_URL)).resolves.toBeDefined();
    });
  });

  describe('cache hit', () => {
    it('returns source: cache on second call within TTL', async () => {
      mockFetch({ ok: true, body: MOCK_TABLE });

      // First call — populates cache
      const first = await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });
      expect(first.source).toBe('remote');

      // Second call — should hit cache (fetch called only once)
      const second = await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });
      expect(second.source).toBe('cache');
      expect(second.table).toEqual(MOCK_TABLE);

      // fetch was only invoked once across both calls
      const fetchMock = vi.mocked(global.fetch);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after TTL expires', async () => {
      mockFetch({ ok: true, body: MOCK_TABLE });

      // Populate cache with TTL of 0 (already expired by next tick)
      await fetchRemoteTable(TEST_URL, { cacheTtlMs: 0 });

      // Second call should re-fetch
      const result = await fetchRemoteTable(TEST_URL, { cacheTtlMs: 0 });
      expect(result.source).toBe('remote');

      const fetchMock = vi.mocked(global.fetch);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('preserves fetchedAt timestamp across cache hits', async () => {
      mockFetch({ ok: true, body: MOCK_TABLE });

      const first = await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });
      const second = await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });

      expect(second.fetchedAt).toBe(first.fetchedAt);
    });
  });

  describe('network error → fallback', () => {
    it('returns source: fallback on network rejection', async () => {
      mockFetch({ ok: false, rejectWith: new Error('ECONNREFUSED') });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('fallback');
      expect(result.table).toBe(DEFAULT_PRICING_TABLE);
      expect(result.error).toContain('ECONNREFUSED');
    });

    it('uses custom fallback when provided', async () => {
      mockFetch({ ok: false, rejectWith: new Error('timeout') });

      const customFallback = { ...DEFAULT_PRICING_TABLE, versionedAt: 'custom' };
      const result = await fetchRemoteTable(TEST_URL, { fallback: customFallback });

      expect(result.source).toBe('fallback');
      expect(result.table).toBe(customFallback);
    });

    it('does not throw on network error', async () => {
      mockFetch({ ok: false, rejectWith: new Error('Network failure') });

      await expect(fetchRemoteTable(TEST_URL)).resolves.toMatchObject({
        source: 'fallback',
      });
    });

    it('emits a structured console.warn on network failure', async () => {
      mockFetch({ ok: false, rejectWith: new Error('ENOTFOUND') });

      await fetchRemoteTable(TEST_URL);

      expect(console.warn).toHaveBeenCalledOnce();
      const [warnArg] = vi.mocked(console.warn).mock.calls[0];
      const parsed = JSON.parse(warnArg as string);
      expect(parsed.event).toBe('llm_pricing_fetch_failed');
      expect(parsed.url).toBe(TEST_URL);
      expect(parsed.fallback).toBe('DEFAULT_PRICING_TABLE');
    });
  });

  describe('HTTP non-2xx → fallback', () => {
    it('returns source: fallback on HTTP 404', async () => {
      mockFetch({ ok: false, status: 404, statusText: 'Not Found' });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('fallback');
      expect(result.error).toContain('404');
    });

    it('returns source: fallback on HTTP 500', async () => {
      mockFetch({ ok: false, status: 500, statusText: 'Internal Server Error' });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('fallback');
      expect(result.error).toContain('500');
    });

    it('does not throw on HTTP error', async () => {
      mockFetch({ ok: false, status: 429, statusText: 'Too Many Requests' });

      await expect(fetchRemoteTable(TEST_URL)).resolves.toMatchObject({
        source: 'fallback',
      });
    });
  });

  describe('schema validation error → fallback', () => {
    it('returns source: fallback when response is missing versionedAt', async () => {
      const invalid = { ...MOCK_TABLE, versionedAt: undefined };
      mockFetch({ ok: true, body: invalid });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('fallback');
      expect(result.error).toContain('versionedAt');
    });

    it('returns source: fallback when a provider key is missing', async () => {
      const { perplexity: _omitted, ...invalid } = MOCK_TABLE;
      mockFetch({ ok: true, body: invalid });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('fallback');
      expect(result.error).toContain('perplexity');
    });

    it('returns source: fallback when a model entry is missing inputPer1M', async () => {
      const invalid: unknown = {
        ...MOCK_TABLE,
        anthropic: {
          'claude-sonnet-4-6': {
            // inputPer1M intentionally omitted
            outputPer1M: 15.0,
            verifiedAt: '2026-05-14',
            sourceUrl: 'https://example.com',
          },
        },
      };
      mockFetch({ ok: true, body: invalid });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('fallback');
      expect(result.error).toContain('inputPer1M');
    });

    it('returns source: fallback when response is not an object', async () => {
      mockFetch({ ok: true, body: 'not-an-object' });

      const result = await fetchRemoteTable(TEST_URL);

      expect(result.source).toBe('fallback');
      expect(result.error).toContain('not an object');
    });

    it('does not throw on schema validation failure', async () => {
      mockFetch({ ok: true, body: null });

      await expect(fetchRemoteTable(TEST_URL)).resolves.toMatchObject({
        source: 'fallback',
      });
    });
  });

  describe('AbortSignal honored', () => {
    it('returns source: fallback when caller aborts before fetch resolves', async () => {
      // Simulate fetch rejection due to abort
      const abortError = new DOMException('The user aborted a request.', 'AbortError');
      mockFetch({ ok: false, rejectWith: abortError });

      const controller = new AbortController();
      controller.abort();

      const result = await fetchRemoteTable(TEST_URL, { signal: controller.signal });

      expect(result.source).toBe('fallback');
      expect(result.error).toBeDefined();
    });

    it('does not throw when AbortSignal fires', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');
      mockFetch({ ok: false, rejectWith: abortError });

      const controller = new AbortController();
      controller.abort();

      await expect(
        fetchRemoteTable(TEST_URL, { signal: controller.signal })
      ).resolves.toMatchObject({
        source: 'fallback',
      });
    });
  });
});

describe('clearPricingCache', () => {
  it('clears a specific URL from cache', async () => {
    mockFetch({ ok: true, body: MOCK_TABLE });

    await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });
    clearPricingCache(TEST_URL);

    // After clearing, next call should re-fetch
    await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clears all URLs from cache', async () => {
    mockFetch({ ok: true, body: MOCK_TABLE });

    const url2 = 'https://example.com/pricing.json';
    await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });
    await fetchRemoteTable(url2, { cacheTtlMs: 60_000 });

    clearPricingCache();

    await fetchRemoteTable(TEST_URL, { cacheTtlMs: 60_000 });
    await fetchRemoteTable(url2, { cacheTtlMs: 60_000 });

    // All 4 calls should hit fetch (2 initial + 2 after clear)
    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
