/**
 * Core type definitions for @diabolicallabs/notion.
 * Wraps @notionhq/client — see §4 of brief-week5.md for rationale.
 */

/**
 * Pluggable logger interface — matches the toolkit-wide convention established
 * in @diabolicallabs/llm-pricing (PricingLogger) and @diabolicallabs/llm-client
 * (LlmClientLogger). Configure via setNotionLogger().
 *
 * Default behavior: structured JSON to stdout. Override to route through
 * your application logger (pino, winston, Datadog, OpenTelemetry, etc.).
 */
export interface Logger {
  warn: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Configuration for createNotionClient(). Supplies the integration token and
 * optional tuning for the pinned Notion API version, retry count, backoff base,
 * per-request timeout, and pluggable logger. The apiKey is a Notion internal
 * integration secret — never log it.
 */
export interface NotionClientConfig {
  apiKey: string; // Notion integration token — never log this
  notionVersion?: string; // default: '2025-09-03' (SDK v5+ default; 2022-06-28 is dropped by SDK v5)
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 500
  timeoutMs?: number; // default: 10000
  logger?: Logger; // pluggable logger — matches toolkit-wide convention
}

/**
 * Discriminated union of property value shapes supported for writing to Notion databases.
 * Covers the property types used across the fleet. Each variant maps to
 * Notion's REST API property object for that type — the client serializes these to the
 * wire format before calling the @notionhq/client SDK.
 *
 * v1.0.0 additions (per §4.4 brief-week5.md):
 *   - { type: 'status'; name: string } — post-2022 Notion property type, widely used, writable
 *   - { type: 'phone_number'; phone_number: string } — basic writable property
 *
 * Deferred to v1.1: files, people, verification (narrower use cases / extra dependencies).
 * Read-only types (formula, rollup, unique_id, created_time, last_edited_time) are intentionally
 * absent from the write union.
 */
export type NotionPropertyValue =
  | { type: 'title'; content: string }
  | { type: 'rich_text'; content: string }
  | { type: 'number'; value: number }
  | { type: 'select'; name: string }
  | { type: 'multi_select'; names: string[] }
  | { type: 'date'; start: string; end?: string } // ISO 8601
  | { type: 'checkbox'; checked: boolean }
  | { type: 'url'; url: string }
  | { type: 'email'; email: string }
  | { type: 'relation'; pageIds: string[] }
  | { type: 'status'; name: string } // post-2022 Notion property type — added v1.0.0
  | { type: 'phone_number'; phone_number: string }; // basic contact property — added v1.0.0

/**
 * A map from Notion property name to its typed value. Passed to createDatabasePage()
 * and updatePage() — keys must match the exact property names defined in the target
 * Notion database schema.
 */
export type NotionProperties = Record<string, NotionPropertyValue>;

/**
 * The result returned by createDatabasePage(), getPage(), and updatePage().
 * Carries the page ID, URL, creation timestamp, and the raw Notion API property
 * map. The properties field is intentionally untyped for v1 — strongly typed
 * property reads are out of scope.
 */
export interface NotionPage {
  id: string;
  url: string;
  createdTime: string;
  properties: Record<string, unknown>; // raw Notion API shape — typed queries out of scope for v1
}

/**
 * The Notion client interface — what consumers program against. Obtain an instance
 * via createNotionClient() or createNotionClientFromEnv(). Handles authentication
 * headers, Notion-Version pinning, conflict-error retry, and rate-limit backoff
 * transparently. Wraps @notionhq/client (SDK v5+).
 */
export interface NotionClient {
  // Create a page in a database
  createDatabasePage(databaseId: string, properties: NotionProperties): Promise<NotionPage>;

  // Query a database — returns all pages matching the filter.
  // Auto-paginates via collectPaginatedAPI when startCursor is omitted.
  // If startCursor is provided, collects all pages from that cursor forward.
  queryDatabase(
    databaseId: string,
    options?: {
      filter?: Record<string, unknown>; // Notion filter object, passed through directly
      sorts?: Array<{ property: string; direction: 'ascending' | 'descending' }>;
      pageSize?: number; // max per page; default 100 (Notion hard cap)
      startCursor?: string; // resume from cursor; if omitted, auto-paginate all
    }
  ): Promise<NotionPage[]>;

  // Retrieve a single page by ID
  getPage(pageId: string): Promise<NotionPage>;

  // Update page properties
  updatePage(pageId: string, properties: NotionProperties): Promise<NotionPage>;
}

/**
 * Error taxonomy for @diabolicallabs/notion. All errors extend NotionError,
 * carrying a machine-readable `.code` string. Pattern mirrors Stripe / OpenAI /
 * Anthropic SDK error hierarchies.
 *
 * - NotionAuthError       — 401/403 (unauthorized, restricted_resource, invalid_grant)
 * - NotionNotFoundError   — 404 (object_not_found)
 * - NotionValidationError — 400-family (validation_error, invalid_json, missing_version).
 *                           Non-retryable. Also thrown synchronously by createNotionClientFromEnv
 *                           when NOTION_API_KEY is absent.
 * - NotionRateLimitError  — 429 after SDK retries exhausted
 * - NotionConflictError   — 409 after bespoke retry exhausted
 * - NotionUnavailableError — 5xx after SDK retries exhausted
 */
export class NotionError extends Error {
  readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Authentication failure — integration token is invalid, revoked, or lacks access to the target resource (401/403). */
export class NotionAuthError extends NotionError {}

/** Resource not found — the page or database ID does not exist or has not been shared with the integration (404). */
export class NotionNotFoundError extends NotionError {}

/**
 * Covers 400-family errors (validation_error, invalid_json, missing_version).
 * Non-retryable. Also thrown synchronously by createNotionClientFromEnv()
 * when NOTION_API_KEY env var is absent.
 */
export class NotionValidationError extends NotionError {}

/** Rate limit exceeded — Notion returned HTTP 429. SDK retries are exhausted; back off before retrying the request. */
export class NotionRateLimitError extends NotionError {}

/** Write conflict — another update raced on the same page (409). Retry the read-modify-write cycle. */
export class NotionConflictError extends NotionError {}

/** Notion API unavailable — transient 5xx error after SDK retries are exhausted. */
export class NotionUnavailableError extends NotionError {}
