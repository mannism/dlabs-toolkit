/**
 * Smoke tests for @diabolicallabs/notion public exports.
 *
 * Verifies module-level export presence and factory behavior.
 * Full unit coverage is in src/__tests__/unit/.
 */

import { describe, expect, it } from 'vitest';
import {
  createNotionClient,
  createNotionClientFromEnv,
  NotionAuthError,
  NotionConflictError,
  NotionError,
  NotionNotFoundError,
  NotionRateLimitError,
  NotionUnavailableError,
  NotionValidationError,
} from './index.js';

describe('@diabolicallabs/notion', () => {
  it('exports createNotionClient as a function', () => {
    expect(typeof createNotionClient).toBe('function');
  });

  it('exports createNotionClientFromEnv as a function', () => {
    expect(typeof createNotionClientFromEnv).toBe('function');
  });

  it('createNotionClient returns a NotionClient object (not a stub)', () => {
    const client = createNotionClient({ apiKey: 'test-key' });
    expect(typeof client).toBe('object');
    expect(typeof client.createDatabasePage).toBe('function');
    expect(typeof client.queryDatabase).toBe('function');
    expect(typeof client.getPage).toBe('function');
    expect(typeof client.updatePage).toBe('function');
  });

  it('createNotionClientFromEnv throws NotionValidationError when key is absent', () => {
    const saved = process.env.NOTION_API_KEY;
    const savedToken = process.env.NOTION_TOKEN;
    delete process.env.NOTION_API_KEY;
    delete process.env.NOTION_TOKEN;

    expect(() => createNotionClientFromEnv()).toThrow(NotionValidationError);

    if (saved !== undefined) process.env.NOTION_API_KEY = saved;
    if (savedToken !== undefined) process.env.NOTION_TOKEN = savedToken;
  });

  // Error class exports
  it('exports all error classes', () => {
    expect(typeof NotionError).toBe('function');
    expect(typeof NotionAuthError).toBe('function');
    expect(typeof NotionNotFoundError).toBe('function');
    expect(typeof NotionValidationError).toBe('function');
    expect(typeof NotionRateLimitError).toBe('function');
    expect(typeof NotionConflictError).toBe('function');
    expect(typeof NotionUnavailableError).toBe('function');
  });

  it('error classes have correct inheritance', () => {
    const err = new NotionAuthError('test', 'unauthorized');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NotionError);
    expect(err).toBeInstanceOf(NotionAuthError);
  });
});
