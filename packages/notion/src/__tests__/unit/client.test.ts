/**
 * Unit tests for NotionClient factory functions using MSW v2 for HTTP mocking.
 *
 * Tests:
 *   - createNotionClientFromEnv throws NotionValidationError when NOTION_API_KEY absent
 *   - createNotionClient returns a working client
 *   - All four methods produce correct NotionPage shapes
 *   - Error mapping on API failures
 *   - Logger is called for conflict retries
 */

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNotionClient, createNotionClientFromEnv } from '../../client.js';
import {
  NotionAuthError,
  NotionNotFoundError,
  NotionRateLimitError,
  NotionUnavailableError,
  NotionValidationError,
} from '../../types.js';

// ─── MSW server ──────────────────────────────────────────────────────────────

const BASE = 'https://api.notion.com/v1';

// Minimal page response shape matching PageObjectResponse
function makePage(id = 'test-page-id'): Record<string, unknown> {
  return {
    object: 'page',
    id,
    url: `https://notion.so/${id}`,
    created_time: '2026-01-01T00:00:00.000Z',
    last_edited_time: '2026-01-01T00:00:00.000Z',
    created_by: { object: 'user', id: 'user-id' },
    last_edited_by: { object: 'user', id: 'user-id' },
    cover: null,
    icon: null,
    parent: { type: 'database_id', database_id: 'db-id' },
    archived: false,
    in_trash: false,
    properties: {
      Name: { id: 'title', type: 'title', title: [{ text: { content: 'Test' } }] },
    },
    public_url: null,
  };
}

// MSW handlers
const handlers = [
  // POST /v1/pages (createDatabasePage, includes data_source_id parent too)
  http.post(`${BASE}/pages`, () => HttpResponse.json(makePage('created-page-id'))),

  // GET /v1/pages/:id
  http.get(`${BASE}/pages/:pageId`, ({ params }) => {
    const id = String(params['pageId']);
    if (id === 'not-found') {
      return HttpResponse.json(
        { object: 'error', code: 'object_not_found', message: 'Could not find page' },
        { status: 404 }
      );
    }
    return HttpResponse.json(makePage(id));
  }),

  // PATCH /v1/pages/:id
  http.patch(`${BASE}/pages/:pageId`, ({ params }) =>
    HttpResponse.json(makePage(String(params['pageId'])))
  ),

  // POST /v1/data_sources/:id/query (dataSources.query via SDK)
  http.post(`${BASE}/data_sources/:dbId/query`, () =>
    HttpResponse.json({
      object: 'list',
      results: [makePage('page-1'), makePage('page-2')],
      next_cursor: null,
      has_more: false,
      type: 'page_or_data_source',
      page_or_data_source: {},
    })
  ),
];

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('createNotionClientFromEnv', () => {
  it('throws NotionValidationError when NOTION_API_KEY is absent', () => {
    const saved = process.env['NOTION_API_KEY'];
    const savedToken = process.env['NOTION_TOKEN'];
    delete process.env['NOTION_API_KEY'];
    delete process.env['NOTION_TOKEN'];

    expect(() => createNotionClientFromEnv()).toThrow(NotionValidationError);
    expect(() => createNotionClientFromEnv()).toThrow(/NOTION_API_KEY/);

    if (saved !== undefined) process.env['NOTION_API_KEY'] = saved;
    if (savedToken !== undefined) process.env['NOTION_TOKEN'] = savedToken;
  });

  it('throws NotionValidationError when NOTION_API_KEY is empty string', () => {
    const saved = process.env['NOTION_API_KEY'];
    const savedToken = process.env['NOTION_TOKEN'];
    process.env['NOTION_API_KEY'] = '';
    delete process.env['NOTION_TOKEN'];

    expect(() => createNotionClientFromEnv()).toThrow(NotionValidationError);

    if (saved !== undefined) {
      process.env['NOTION_API_KEY'] = saved;
    } else {
      delete process.env['NOTION_API_KEY'];
    }
    if (savedToken !== undefined) process.env['NOTION_TOKEN'] = savedToken;
  });

  it('accepts NOTION_TOKEN as fallback', () => {
    const saved = process.env['NOTION_API_KEY'];
    const savedToken = process.env['NOTION_TOKEN'];
    delete process.env['NOTION_API_KEY'];
    process.env['NOTION_TOKEN'] = 'test-token';

    // Should NOT throw — creates client with NOTION_TOKEN
    expect(() => createNotionClientFromEnv()).not.toThrow();

    if (saved !== undefined) {
      process.env['NOTION_API_KEY'] = saved;
    } else {
      delete process.env['NOTION_API_KEY'];
    }
    if (savedToken !== undefined) {
      process.env['NOTION_TOKEN'] = savedToken;
    } else {
      delete process.env['NOTION_TOKEN'];
    }
  });
});

describe('createDatabasePage', () => {
  it('returns a NotionPage with correct shape', async () => {
    const client = createNotionClient({ apiKey: 'test-key' });
    const page = await client.createDatabasePage('db-id', {
      Name: { type: 'title', content: 'Test Page' },
    });
    expect(page.id).toBe('created-page-id');
    expect(page.url).toContain('notion.so');
    expect(page.createdTime).toBe('2026-01-01T00:00:00.000Z');
    expect(typeof page.properties).toBe('object');
  });

  it('maps 401 to NotionAuthError', async () => {
    server.use(
      http.post(`${BASE}/pages`, () =>
        HttpResponse.json(
          { object: 'error', code: 'unauthorized', message: 'Unauthorized' },
          { status: 401 }
        )
      )
    );
    const client = createNotionClient({ apiKey: 'bad-key' });
    await expect(client.createDatabasePage('db-id', {})).rejects.toBeInstanceOf(NotionAuthError);
  });

  it('maps 429 to NotionRateLimitError (after SDK retries)', async () => {
    server.use(
      http.post(`${BASE}/pages`, () =>
        HttpResponse.json(
          { object: 'error', code: 'rate_limited', message: 'Rate limited' },
          { status: 429, headers: { 'Retry-After': '0' } }
        )
      )
    );
    const client = createNotionClient({ apiKey: 'test-key', maxRetries: 0 }); // disable retries for speed
    await expect(client.createDatabasePage('db-id', {})).rejects.toBeInstanceOf(
      NotionRateLimitError
    );
  });

  it('maps 5xx to NotionUnavailableError', async () => {
    server.use(
      http.post(`${BASE}/pages`, () =>
        HttpResponse.json(
          { object: 'error', code: 'internal_server_error', message: 'Server error' },
          { status: 500 }
        )
      )
    );
    const client = createNotionClient({ apiKey: 'test-key', maxRetries: 0 });
    await expect(client.createDatabasePage('db-id', {})).rejects.toBeInstanceOf(
      NotionUnavailableError
    );
  });

  it('calls logger.warn on conflict retry', async () => {
    let callCount = 0;
    server.use(
      http.post(`${BASE}/pages`, () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json(
            { object: 'error', code: 'conflict_error', message: 'Conflict' },
            { status: 409 }
          );
        }
        return HttpResponse.json(makePage('retry-page-id'));
      })
    );

    const warnSpy = vi.fn();
    const client = createNotionClient({
      apiKey: 'test-key',
      logger: { warn: warnSpy },
    });
    const page = await client.createDatabasePage('db-id', {});
    expect(page.id).toBe('retry-page-id');
    expect(warnSpy).toHaveBeenCalledWith(
      'NOTION_CONFLICT_RETRY',
      expect.objectContaining({ attempt: 0 })
    );
  });
});

describe('queryDatabase', () => {
  it('returns an array of NotionPages', async () => {
    const client = createNotionClient({ apiKey: 'test-key' });
    const pages = await client.queryDatabase('db-id');
    expect(Array.isArray(pages)).toBe(true);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.id).toBe('page-1');
    expect(pages[1]?.id).toBe('page-2');
  });

  it('passes filter and sorts to the query', async () => {
    let capturedBody: unknown;
    server.use(
      http.post(`${BASE}/data_sources/:dbId/query`, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({
          object: 'list',
          results: [],
          next_cursor: null,
          has_more: false,
          type: 'page_or_data_source',
          page_or_data_source: {},
        });
      })
    );
    const client = createNotionClient({ apiKey: 'test-key' });
    await client.queryDatabase('db-id', {
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ property: 'Name', direction: 'ascending' }],
    });
    expect(capturedBody).toMatchObject({
      filter: { property: 'Status', status: { equals: 'Done' } },
      sorts: [{ property: 'Name', direction: 'ascending' }],
    });
  });
});

describe('getPage', () => {
  it('returns a NotionPage for a valid page ID', async () => {
    const client = createNotionClient({ apiKey: 'test-key' });
    const page = await client.getPage('test-page-123');
    expect(page.id).toBe('test-page-123');
  });

  it('maps 404 to NotionNotFoundError', async () => {
    const client = createNotionClient({ apiKey: 'test-key' });
    await expect(client.getPage('not-found')).rejects.toBeInstanceOf(NotionNotFoundError);
  });
});

describe('updatePage', () => {
  it('returns updated NotionPage', async () => {
    const client = createNotionClient({ apiKey: 'test-key' });
    const page = await client.updatePage('test-page-id', {
      Status: { type: 'status', name: 'Complete' },
    });
    expect(page.id).toBe('test-page-id');
  });
});

describe('NotionClient shape', () => {
  it('createNotionClient returns an object with all four methods', () => {
    const client = createNotionClient({ apiKey: 'test-key' });
    expect(typeof client.createDatabasePage).toBe('function');
    expect(typeof client.queryDatabase).toBe('function');
    expect(typeof client.getPage).toBe('function');
    expect(typeof client.updatePage).toBe('function');
  });
});
