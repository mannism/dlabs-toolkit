/**
 * @diabolicallabs/notion
 *
 * Notion API client. Wraps @notionhq/client (SDK v5+). Handles:
 *   - Authentication headers
 *   - Notion-Version header (default: 2025-09-03)
 *   - Property serialization for all common writable property types
 *   - conflict_error retry with full-jitter exponential backoff
 *   - 429 rate-limit backoff (delegated to SDK)
 *   - 5xx retry for idempotent requests (delegated to SDK)
 *   - Auto-pagination via collectPaginatedAPI
 *   - Named error taxonomy (NotionAuthError, NotionNotFoundError, etc.)
 *   - Pluggable logger
 *
 * @example
 * import { createNotionClientFromEnv } from '@diabolicallabs/notion';
 * const notion = createNotionClientFromEnv();
 * const pages = await notion.queryDatabase('my-database-id');
 */

// Factory functions
export { createNotionClient, createNotionClientFromEnv } from './client.js';

// Logger
export { setNotionLogger } from './logger.js';

// Types
export type {
  Logger,
  NotionClient,
  NotionClientConfig,
  NotionPage,
  NotionProperties,
  NotionPropertyValue,
} from './types.js';

// Error classes — exported as values (not just types) for instanceof checks
export {
  NotionAuthError,
  NotionConflictError,
  NotionError,
  NotionNotFoundError,
  NotionRateLimitError,
  NotionUnavailableError,
  NotionValidationError,
} from './types.js';
