/**
 * Factory functions for NotionClient.
 *
 * createNotionClient(config) — builds a NotionClient from explicit config.
 * createNotionClientFromEnv(overrides?) — reads NOTION_API_KEY from env;
 *   throws NotionValidationError synchronously if the key is absent.
 *
 * Implementation wraps @notionhq/client v5+ (default Notion-Version: 2025-09-03).
 * The SDK handles:
 *   - Authorization headers (Bearer token)
 *   - Notion-Version header (configurable — default: 2025-09-03)
 *   - 429 retry with Retry-After respect (SDK default: 2 retries)
 *   - 5xx retry for idempotent requests
 *
 * This wrapper adds:
 *   - Bespoke 409 conflict_error retry (3 tries, full-jitter exponential, 250ms base, 2s cap)
 *   - Named error taxonomy (NotionAuthError, NotionNotFoundError, etc.)
 *   - Auto-pagination via collectPaginatedAPI (dataSources.query)
 *   - Pluggable logger
 *   - Secrets safety: api key never logged
 *
 * SDK v5 API note (2025-09-03 version):
 *   Database queries use dataSources.query (data_source_id) — databases.query is removed.
 *   Page creation still accepts database_id in the parent parameter.
 */

import { Client, collectPaginatedAPI, isFullPage } from '@notionhq/client';
import { isConflictCode, mapSdkError } from './error-map.js';
import { getLogger } from './logger.js';
import { serializeProperties } from './serializer.js';
import type {
  Logger,
  NotionClient,
  NotionClientConfig,
  NotionPage,
  NotionProperties,
} from './types.js';
import { NotionValidationError } from './types.js';

// Default Notion API version — matches @notionhq/client v5+ SDK default.
// 2022-06-28 is dropped by SDK v5; callers can override via notionVersion config.
const DEFAULT_NOTION_VERSION = '2025-09-03';

// Default retry config for conflict (409) errors — bespoke, not delegated to SDK
const CONFLICT_MAX_RETRIES = 3;
const CONFLICT_BASE_DELAY_MS = 250;
const CONFLICT_MAX_DELAY_MS = 2_000;

/**
 * Full-jitter exponential backoff delay for conflict retries.
 * Formula: delay = min(cap, base * 2^attempt) * random(0,1)
 * (AWS Jitter recommendation — prevents thundering herd on concurrent writes)
 */
function conflictRetryDelay(attempt: number): number {
  const ceiling = Math.min(CONFLICT_MAX_DELAY_MS, CONFLICT_BASE_DELAY_MS * 2 ** attempt);
  return Math.random() * ceiling;
}

/** Promisified sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize a Notion SDK full page response to our NotionPage shape.
 * Only called on values confirmed as full pages by isFullPage().
 */
function normalizeFullPage(page: {
  id: string;
  url: string;
  created_time: string;
  properties: Record<string, unknown>;
}): NotionPage {
  return {
    id: page.id,
    url: page.url,
    createdTime: page.created_time,
    properties: page.properties,
  };
}

/**
 * Execute an SDK call with bespoke conflict (409) retry.
 * For non-409 errors, mapSdkError is applied and thrown immediately.
 * For 409, retries up to CONFLICT_MAX_RETRIES times with full-jitter backoff.
 */
async function withConflictRetry<T>(fn: () => Promise<T>, log: Logger): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < CONFLICT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isConflict =
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        isConflictCode(String((err as { code: unknown }).code));

      if (!isConflict || attempt === CONFLICT_MAX_RETRIES - 1) {
        const mapped = mapSdkError(err);
        if (isConflict) {
          log.warn('NOTION_CONFLICT_RETRY', {
            attempt,
            status: 'exhausted',
            maxRetries: CONFLICT_MAX_RETRIES,
          });
        }
        throw mapped;
      }

      lastErr = err;
      const delayMs = conflictRetryDelay(attempt);
      log.warn('NOTION_CONFLICT_RETRY', { attempt, delayMs: Math.round(delayMs) });
      await sleep(delayMs);
    }
  }

  throw mapSdkError(lastErr);
}

/**
 * Create a NotionClient with explicit config.
 *
 * @param config - NotionClientConfig; apiKey is required and never logged.
 */
export function createNotionClient(config: NotionClientConfig): NotionClient {
  const {
    apiKey,
    notionVersion = DEFAULT_NOTION_VERSION,
    maxRetries = 3,
    timeoutMs = 10_000,
    logger: configLogger,
  } = config;

  const log = configLogger ?? getLogger();

  // SDK v5 ClientOptions shape: retry is a sub-object, not a top-level field.
  const sdk = new Client({
    auth: apiKey,
    notionVersion,
    timeoutMs,
    retry: {
      maxRetries,
    },
  });

  return {
    async createDatabasePage(databaseId, properties: NotionProperties): Promise<NotionPage> {
      return withConflictRetry(async () => {
        // The SDK's CreatePageBodyParameters.properties is typed `Record<...> | undefined`
        // under exactOptionalPropertyTypes. Our serializer always returns a non-undefined
        // Record, so this cast is safe — we're narrowing, not widening.
        type CreateArgs = Parameters<typeof sdk.pages.create>[0];
        const args = {
          parent: { database_id: databaseId },
          properties: serializeProperties(properties),
        } as CreateArgs;
        const page = await sdk.pages.create(args);
        // The SDK returns PageObjectResponse | PartialPageObjectResponse.
        // We need a full page for id, url, created_time, properties.
        if (!isFullPage(page)) {
          throw new Error('[dlabs-toolkit] Notion pages.create returned a partial page response');
        }
        return normalizeFullPage(page);
      }, log);
    },

    async queryDatabase(databaseId, options): Promise<NotionPage[]> {
      const { filter, sorts, pageSize, startCursor } = options ?? {};

      // SDK v5 (2025-09-03): databases.query is removed; use dataSources.query.
      // The `data_source_id` is the database's ID — same UUID, different parameter name.
      // Cast is required: exactOptionalPropertyTypes prevents spreading optional fields directly.
      type QueryArgs = Parameters<typeof sdk.dataSources.query>[0];
      const queryArgs = {
        data_source_id: databaseId,
        ...(filter !== undefined && { filter }),
        ...(sorts !== undefined && { sorts }),
        ...(pageSize !== undefined && { page_size: pageSize }),
        ...(startCursor !== undefined && { start_cursor: startCursor }),
      } as QueryArgs;

      try {
        // collectPaginatedAPI auto-paginates through all result pages.
        const results = await collectPaginatedAPI(
          sdk.dataSources.query.bind(sdk.dataSources),
          queryArgs
        );
        // Filter to full pages only — drop partial responses and nested data sources.
        // collectPaginatedAPI returns unknown[] but we know items are ObjectResponse.
        // Cast is safe: dataSources.query results are PageObjectResponse | PartialPage* | DataSource*.
        return (results as Parameters<typeof isFullPage>[0][])
          .filter(isFullPage)
          .map(normalizeFullPage);
      } catch (err) {
        throw mapSdkError(err);
      }
    },

    async getPage(pageId): Promise<NotionPage> {
      try {
        const page = await sdk.pages.retrieve({ page_id: pageId });
        if (!isFullPage(page)) {
          throw new Error('[dlabs-toolkit] Notion pages.retrieve returned a partial page response');
        }
        return normalizeFullPage(page);
      } catch (err) {
        // Don't double-wrap NotionError subclasses from isFullPage check
        if (err instanceof Error && err.message.startsWith('[dlabs-toolkit]')) {
          throw err;
        }
        throw mapSdkError(err);
      }
    },

    async updatePage(pageId, properties: NotionProperties): Promise<NotionPage> {
      return withConflictRetry(async () => {
        type UpdateArgs = Parameters<typeof sdk.pages.update>[0];
        const args = {
          page_id: pageId,
          properties: serializeProperties(properties),
        } as UpdateArgs;
        const page = await sdk.pages.update(args);
        if (!isFullPage(page)) {
          throw new Error('[dlabs-toolkit] Notion pages.update returned a partial page response');
        }
        return normalizeFullPage(page);
      }, log);
    },
  };
}

/**
 * Create a NotionClient from environment variables.
 *
 * Reads NOTION_API_KEY from process.env (falls back to NOTION_TOKEN for compatibility).
 * Throws NotionValidationError synchronously if neither env var is present.
 *
 * @param overrides - Optional config overrides (everything except apiKey).
 */
export function createNotionClientFromEnv(
  overrides?: Partial<Omit<NotionClientConfig, 'apiKey'>>
): NotionClient {
  // NOTION_API_KEY is canonical; NOTION_TOKEN accepted as compatibility alias
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature in TS strict requires bracket notation
  const apiKey = process.env['NOTION_API_KEY'] ?? process.env['NOTION_TOKEN'];

  if (apiKey === undefined || apiKey === '') {
    throw new NotionValidationError(
      'NOTION_API_KEY environment variable is not set. ' +
        'Set NOTION_API_KEY (or NOTION_TOKEN for legacy compatibility) ' +
        'to your Notion integration token.',
      'missing_api_key'
    );
  }

  return createNotionClient({ apiKey, ...overrides });
}
