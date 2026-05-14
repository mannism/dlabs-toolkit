/**
 * fetchRemoteTable — opt-in remote pricing source for @diabolicallabs/llm-pricing.
 *
 * Fetches a PricingTable from a URL (typically the canonical
 * pricing/table.json in the dlabs-toolkit repo) with an in-memory
 * stale-while-revalidate cache. Never throws — on any failure it returns
 * the bundled DEFAULT_PRICING_TABLE (or a caller-supplied fallback).
 *
 * Design constraints:
 * - Pricing failures must never crash an LLM request. Degraded mode
 *   (bundled fallback) is always preferable to an exception.
 * - One in-memory cache entry per URL. Cache is process-scoped.
 * - 5-second connect timeout via AbortSignal.any() composition.
 *
 * Cache TTL default: 24 hours.
 * Rationale: GitHub raw fetches are cheap but bounded. 24h matches the
 * realistic provider-repricing cadence — faster wouldn't catch drift sooner
 * (providers change prices at most daily); slower starts to lag noticeably.
 */

import { DEFAULT_PRICING_TABLE } from './table.js';
import type { ModelPricing, PricingTable } from './types.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/** Options for fetchRemoteTable(). */
export interface FetchRemoteTableOptions {
  /**
   * Cache TTL in milliseconds. After expiry, the next call re-fetches.
   *
   * Default: 86_400_000 (24 hours).
   *
   * Rationale: GitHub raw fetches are cheap but bounded. 24h matches the
   * realistic provider-repricing cadence — faster wouldn't catch drift
   * sooner; slower starts to lag noticeably.
   */
  cacheTtlMs?: number;

  /**
   * Optional AbortSignal from the caller. Composed with the internal
   * 5-second connect timeout via AbortSignal.any().
   */
  signal?: AbortSignal;

  /**
   * Fallback table used when fetch or validation fails.
   * Defaults to DEFAULT_PRICING_TABLE if not provided.
   */
  fallback?: PricingTable;
}

/** Result returned by fetchRemoteTable(). Never throws. */
export interface FetchRemoteTableResult {
  /** The resolved pricing table (remote, cached, or fallback). */
  table: PricingTable;

  /** Where the table came from. */
  source: 'remote' | 'cache' | 'fallback';

  /**
   * ISO 8601 timestamp when the table was fetched from the remote.
   * Present only when source is 'remote'.
   */
  fetchedAt?: string;

  /**
   * Human-readable error description when source is 'fallback'.
   * Never exposed in user-facing surfaces — for structured logging only.
   */
  error?: string;
}

// ─── Internal cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  table: PricingTable;
  fetchedAt: string;
  expiresAt: number;
}

/** Process-scoped in-memory cache keyed by URL. */
const cache = new Map<string, CacheEntry>();

// ─── Validation ───────────────────────────────────────────────────────────────

const REQUIRED_PROVIDERS: ReadonlyArray<keyof Omit<PricingTable, 'versionedAt'>> = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'perplexity',
];

/**
 * Minimal structural validation for a parsed PricingTable.
 *
 * Validates:
 * - top-level shape: versionedAt (string) + all five provider keys (objects)
 * - each model entry has inputPer1M (number) + outputPer1M (number)
 *   + verifiedAt (string) + sourceUrl (string) — the four required fields
 *   from the JSON Schema
 *
 * Does not validate optional fields — they default gracefully in computeCost().
 * Returns null if valid; returns an error string if invalid.
 */
function validatePricingTable(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) {
    return 'root is not an object';
  }

  const record = data as Record<string, unknown>;

  // Use index access (bracket notation) — noPropertyAccessFromIndexSignature
  // is enabled in tsconfig.base.json, so dot notation on Record<string,unknown>
  // is rejected by TS even though Biome's useLiteralKeys prefers it.
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature
  const versionedAt = record['versionedAt'];
  if (typeof versionedAt !== 'string') {
    return 'missing or invalid versionedAt (expected string)';
  }

  for (const provider of REQUIRED_PROVIDERS) {
    const providerData = record[provider];
    if (typeof providerData !== 'object' || providerData === null) {
      return `missing or invalid provider "${provider}" (expected object)`;
    }

    const models = providerData as Record<string, unknown>;
    for (const [modelId, modelData] of Object.entries(models)) {
      if (typeof modelData !== 'object' || modelData === null) {
        return `provider "${provider}" model "${modelId}" is not an object`;
      }

      const m = modelData as Partial<ModelPricing>;

      if (typeof m.inputPer1M !== 'number') {
        return `provider "${provider}" model "${modelId}" missing inputPer1M`;
      }
      if (typeof m.outputPer1M !== 'number') {
        return `provider "${provider}" model "${modelId}" missing outputPer1M`;
      }
      if (typeof m.verifiedAt !== 'string') {
        return `provider "${provider}" model "${modelId}" missing verifiedAt`;
      }
      if (typeof m.sourceUrl !== 'string') {
        return `provider "${provider}" model "${modelId}" missing sourceUrl`;
      }
    }
  }

  return null; // valid
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a PricingTable from a remote URL with stale-while-revalidate caching.
 *
 * @param url - Remote URL returning a JSON PricingTable (typically the
 *   canonical `pricing/table.json` in the dlabs-toolkit repo).
 *
 * @param options - Optional cache TTL, caller AbortSignal, and fallback table.
 *
 * @returns A FetchRemoteTableResult — never throws. On any failure, source
 *   is 'fallback' and table is the bundled DEFAULT_PRICING_TABLE (or
 *   options.fallback if provided).
 *
 * @example
 * ```ts
 * const result = await fetchRemoteTable(
 *   'https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/table.json'
 * );
 * if (result.source === 'fallback') {
 *   console.warn('[llm-pricing] remote fetch failed, using bundled table:', result.error);
 * }
 * const cost = computeCost({ usage, provider: 'anthropic', model, pricingTable: result.table });
 * ```
 */
export async function fetchRemoteTable(
  url: string,
  options?: FetchRemoteTableOptions
): Promise<FetchRemoteTableResult> {
  const ttlMs = options?.cacheTtlMs ?? 24 * 60 * 60 * 1000; // 24h default
  const fallback = options?.fallback ?? DEFAULT_PRICING_TABLE;

  // ── 1. Cache hit check ────────────────────────────────────────────────────

  const cached = cache.get(url);
  if (cached !== undefined && Date.now() < cached.expiresAt) {
    return {
      table: cached.table,
      source: 'cache',
      fetchedAt: cached.fetchedAt,
    };
  }

  // ── 2. Fetch with 5s connect timeout ────────────────────────────────────

  // Compose caller signal with internal 5-second timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort(new Error('fetchRemoteTable: 5s connect timeout'));
  }, 5_000);

  const signals: AbortSignal[] = [timeoutController.signal];
  if (options?.signal) {
    signals.push(options.signal);
  }

  // AbortSignal.any() is Node 20+ / all modern browsers
  const combinedSignal = AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetch(url, { signal: combinedSignal });
  } catch (err) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: 'llm_pricing_fetch_failed',
        url,
        error: message,
        fallback: 'DEFAULT_PRICING_TABLE',
      })
    );
    return { table: fallback, source: 'fallback', error: message };
  } finally {
    clearTimeout(timeoutId);
  }

  // ── 3. HTTP status check ──────────────────────────────────────────────────

  if (!response.ok) {
    const message = `HTTP ${response.status} ${response.statusText}`;
    console.warn(
      JSON.stringify({
        event: 'llm_pricing_fetch_failed',
        url,
        error: message,
        fallback: 'DEFAULT_PRICING_TABLE',
      })
    );
    return { table: fallback, source: 'fallback', error: message };
  }

  // ── 4. Parse JSON ─────────────────────────────────────────────────────────

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wrappedMessage = `JSON parse error: ${message}`;
    console.warn(
      JSON.stringify({
        event: 'llm_pricing_fetch_failed',
        url,
        error: wrappedMessage,
        fallback: 'DEFAULT_PRICING_TABLE',
      })
    );
    return { table: fallback, source: 'fallback', error: wrappedMessage };
  }

  // ── 5. Schema validation ──────────────────────────────────────────────────

  const validationError = validatePricingTable(parsed);
  if (validationError !== null) {
    const message = `schema validation failed: ${validationError}`;
    console.warn(
      JSON.stringify({
        event: 'llm_pricing_fetch_failed',
        url,
        error: message,
        fallback: 'DEFAULT_PRICING_TABLE',
      })
    );
    return { table: fallback, source: 'fallback', error: message };
  }

  // ── 6. Cache and return ───────────────────────────────────────────────────

  const table = parsed as PricingTable;
  const fetchedAt = new Date().toISOString();

  cache.set(url, {
    table,
    fetchedAt,
    expiresAt: Date.now() + ttlMs,
  });

  return { table, source: 'remote', fetchedAt };
}

/**
 * Clear the in-memory pricing cache for a specific URL or all URLs.
 * Primarily for testing — production code should let the cache expire naturally.
 *
 * @param url - If provided, clears only the entry for that URL. If omitted, clears all entries.
 */
export function clearPricingCache(url?: string): void {
  if (url !== undefined) {
    cache.delete(url);
  } else {
    cache.clear();
  }
}
