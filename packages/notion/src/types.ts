/**
 * Core type definitions for @diabolicallabs/notion.
 * Matches the spec in briefs/brief-platform.md §4.3.
 */

/**
 * Configuration for createNotionClient(). Supplies the integration token and
 * optional tuning for the pinned Notion API version, retry count, backoff base,
 * and per-request timeout. The apiKey is a Notion internal integration secret —
 * never log it.
 */
export interface NotionClientConfig {
  apiKey: string; // Notion integration token — never log this
  notionVersion?: string; // default: '2022-06-28' (stable v1 API, pinned)
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 500
  timeoutMs?: number; // default: 10000
}

/**
 * Discriminated union of property value shapes supported for writing to Notion databases.
 * Covers the property types used across the fleet (v0 scope). Each variant maps to
 * Notion's REST API property object for that type — the client serializes these to the
 * wire format before calling the Notion API.
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
  | { type: 'relation'; pageIds: string[] };

/**
 * A map from Notion property name to its typed value. Passed to createDatabasePage()
 * and updatePage() — keys must match the exact property names defined in the target
 * Notion database schema.
 */
export type NotionProperties = Record<string, NotionPropertyValue>;

/**
 * The result returned by createDatabasePage(), getPage(), and updatePage().
 * Carries the page ID, URL, creation timestamp, and the raw Notion API property
 * map. The properties field is intentionally untyped for v0 — strongly typed
 * property reads are out of scope.
 */
export interface NotionPage {
  id: string;
  url: string;
  createdTime: string;
  properties: Record<string, unknown>; // raw Notion API shape — typed queries out of scope for v0
}

/**
 * The Notion client interface — what consumers program against. Obtain an instance
 * via createNotionClient() or createNotionClientFromEnv(). Handles authentication
 * headers, Notion-Version pinning, conflict-error retry, and rate-limit backoff
 * transparently. Wraps the Notion REST API directly (not the @notionhq/client SDK).
 */
export interface NotionClient {
  // Create a page in a database
  createDatabasePage(databaseId: string, properties: NotionProperties): Promise<NotionPage>;

  // Query a database — returns all pages matching the filter
  queryDatabase(
    databaseId: string,
    options?: {
      filter?: Record<string, unknown>; // Notion filter object, passed through directly
      sorts?: Array<{ property: string; direction: 'ascending' | 'descending' }>;
      pageSize?: number; // default: 100; Notion max: 100
    }
  ): Promise<NotionPage[]>;

  // Retrieve a single page by ID
  getPage(pageId: string): Promise<NotionPage>;

  // Update page properties
  updatePage(pageId: string, properties: NotionProperties): Promise<NotionPage>;
}
