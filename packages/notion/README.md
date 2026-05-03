# @diabolicallabs/notion

Notion REST API helpers — database page creation, property serialisation, conflict retry, and rate-limit backoff. © Diabolical Labs

## Status

**Scaffolded.** Types and public API surface are defined. Full implementation ships Week 5.

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

// Query a database
const pages = await notion.queryDatabase('your-database-id', {
  filter: { property: 'Status', select: { equals: 'Active' } },
  sorts: [{ property: 'Name', direction: 'ascending' }],
});

// Update a page
await notion.updatePage(page.id, {
  Status: { type: 'select', name: 'Archived' },
});
```

## API

### `createNotionClient(config): NotionClient`

Creates a NotionClient with explicit config.

### `createNotionClientFromEnv(overrides?): NotionClient`

Reads `NOTION_API_KEY` from the environment.

### `NotionClient` interface

| Method | Description |
|---|---|
| `createDatabasePage(databaseId, properties)` | Create a page in a Notion database. |
| `queryDatabase(databaseId, options?)` | Query a database with optional filter and sorts. |
| `getPage(pageId)` | Retrieve a single page by ID. |
| `updatePage(pageId, properties)` | Update page properties. |

### Property types

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
  | { type: 'relation'; pageIds: string[] };
```

## Retry behaviour

- `conflict_error` from Notion (concurrent writes): retried automatically with exponential backoff
- HTTP 429 (rate limited): retried after delay
- HTTP 401 (invalid API key): throws immediately, no retry

## Notes

Wraps the Notion REST API directly at version `2022-06-28` — not the official `@notionhq/client` SDK — for precise control over version pinning and retry logic.
