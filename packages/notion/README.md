# @diabolicallabs/notion

Notion database client — page creation, querying, updates, property serialization, conflict retry, and a named error taxonomy. © Diabolical Labs

## Install

```bash
pnpm add @diabolicallabs/notion
```

## Usage

```typescript
import { createNotionClientFromEnv } from '@diabolicallabs/notion';

// Reads NOTION_API_KEY from environment
const notion = createNotionClientFromEnv();

// Create a database page
const page = await notion.createDatabasePage('your-database-id', {
  Name: { type: 'title', content: 'My Page' },
  Status: { type: 'select', name: 'Active' },
  Score: { type: 'number', value: 42 },
  Published: { type: 'date', start: '2026-05-03' },
});

// Query a database (auto-paginated)
const pages = await notion.queryDatabase('your-database-id', {
  filter: { property: 'Status', select: { equals: 'Active' } },
  sorts: [{ property: 'Name', direction: 'ascending' }],
});

// Get a single page
const retrieved = await notion.getPage(page.id);

// Update properties
await notion.updatePage(page.id, {
  Status: { type: 'select', name: 'Archived' },
});
```

## API

### `createNotionClient(config): NotionClient`

Creates a client with explicit config.

```typescript
interface NotionClientConfig {
  apiKey: string;
  notionVersion?: string;    // default: '2025-09-03'
  timeoutMs?: number;        // default: 30_000
  maxRetries?: number;       // default: 3
  retryDelayMs?: number;     // base delay for conflict retry; default: 500
  logger?: Logger;
}
```

### `createNotionClientFromEnv(overrides?): NotionClient`

Reads `NOTION_API_KEY` (or `NOTION_TOKEN` as a legacy alias) from the environment. Throws `NotionValidationError` synchronously if absent.

### `setNotionLogger(logger: Logger): void`

Override the module-level logger. Default: structured JSON to stdout.

### `NotionClient` interface

| Method | Description |
|---|---|
| `createDatabasePage(databaseId, properties)` | Create a page in a Notion database |
| `queryDatabase(databaseId, options?)` | Query a database — auto-paginated |
| `getPage(pageId)` | Retrieve a single page by ID |
| `updatePage(pageId, properties)` | Update page properties |

### Property types

Supported `NotionPropertyValue` variants:

```typescript
type NotionPropertyValue =
  | { type: 'title'; content: string }
  | { type: 'rich_text'; content: string }
  | { type: 'number'; value: number }
  | { type: 'select'; name: string }
  | { type: 'multi_select'; names: string[] }
  | { type: 'date'; start: string; end?: string }
  | { type: 'checkbox'; checked: boolean }
  | { type: 'url'; url: string }
  | { type: 'email'; email: string }
  | { type: 'phone_number'; phone_number: string }
  | { type: 'relation'; pageIds: string[] }
  | { type: 'status'; name: string };
```

### Error taxonomy

All errors extend `NotionError`. Import by name for `instanceof` checks.

```typescript
import {
  NotionError,
  NotionAuthError,       // 401, 403
  NotionNotFoundError,   // 404
  NotionValidationError, // 400, missing env var
  NotionRateLimitError,  // 429
  NotionConflictError,   // 409 conflict_error
  NotionUnavailableError // 500, 503, timeout, network
} from '@diabolicallabs/notion';
```

## Retry behavior

- `conflict_error` (concurrent writes): retried with full-jitter exponential backoff. Transparent to caller.
- HTTP 429 (rate limited): retried after backoff. Transparent to caller.
- HTTP 401 (invalid API key): throws `NotionAuthError` immediately.
- Authorization header is stripped from all error logs — the API key is never logged.

## Implementation notes

Wraps `@notionhq/client` v5 with Notion-Version `2025-09-03`. Uses `dataSources.query` (v5 API). Auto-pagination via `collectPaginatedAPI`.
