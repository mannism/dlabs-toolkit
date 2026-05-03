/**
 * Factory functions for NotionClient.
 * Week 1 scaffold: stubs only. Full implementation ships Week 5.
 */

import type { NotionClient, NotionClientConfig } from './types.js';

/**
 * Create a NotionClient with explicit config.
 */
export function createNotionClient(_config: NotionClientConfig): NotionClient {
  throw new Error(
    '[dlabs-toolkit] createNotionClient is not yet implemented. Implementation ships Week 5.'
  );
}

/**
 * Create a NotionClient from environment variables.
 * Reads NOTION_API_KEY from the environment.
 */
export function createNotionClientFromEnv(
  _overrides?: Partial<Omit<NotionClientConfig, 'apiKey'>>
): NotionClient {
  throw new Error(
    '[dlabs-toolkit] createNotionClientFromEnv is not yet implemented. Implementation ships Week 5.'
  );
}
