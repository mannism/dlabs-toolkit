/**
 * Core type definitions for @diabolicallabs/notion.
 * Matches the spec in briefs/brief-platform.md §4.3.
 */

// Config passed to createNotionClient
export interface NotionClientConfig {
  apiKey: string; // Notion integration token — never log this
  notionVersion?: string; // default: '2022-06-28' (stable v1 API, pinned)
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 500
  timeoutMs?: number; // default: 10000
}

// Property value types — mirrors Notion's property object shapes.
// Covers the subset used across the fleet today (v0 scope).
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

// Properties map — keys are Notion property names
export type NotionProperties = Record<string, NotionPropertyValue>;

// Page creation / retrieval result
export interface NotionPage {
  id: string;
  url: string;
  createdTime: string;
  properties: Record<string, unknown>; // raw Notion API shape — typed queries out of scope for v0
}

// Notion client interface — what consumers program against
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
