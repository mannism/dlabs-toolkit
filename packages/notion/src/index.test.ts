/**
 * Placeholder test for @diabolicallabs/notion.
 *
 * Full unit test coverage ships in Week 5 alongside the NotionClient
 * implementation. This file exists to:
 *  1. Satisfy passWithNoTests: false in vitest config
 *  2. Verify the package's public exports are present at the module level
 */

import { describe, expect, it } from 'vitest';
import { createNotionClient, createNotionClientFromEnv } from './index.js';

describe('@diabolicallabs/notion', () => {
  it('exports createNotionClient as a function', () => {
    expect(typeof createNotionClient).toBe('function');
  });

  it('exports createNotionClientFromEnv as a function', () => {
    expect(typeof createNotionClientFromEnv).toBe('function');
  });

  it('createNotionClient throws not-implemented before Week 5', () => {
    expect(() => {
      createNotionClient({ apiKey: 'test' });
    }).toThrow('not yet implemented');
  });

  it('createNotionClientFromEnv throws not-implemented before Week 5', () => {
    expect(() => {
      createNotionClientFromEnv();
    }).toThrow('not yet implemented');
  });
});
