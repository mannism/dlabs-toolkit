/**
 * @diabolicallabs/notion
 *
 * Notion REST API helpers. Handles authentication headers, Notion-Version
 * header, property serialization, conflict_error retry, and the 3-req/s
 * rate limit Notion enforces on API keys.
 *
 * Wraps the Notion REST API directly (not the official SDK) for precise
 * control over the Notion-Version header and retry behavior.
 *
 * Implementation begins Week 5. This file exports the public type surface only.
 */

// Factory functions
export { createNotionClient, createNotionClientFromEnv } from './client.js';

// Types
export type { NotionClientConfig } from './types.js';
export type { NotionPropertyValue } from './types.js';
export type { NotionProperties } from './types.js';
export type { NotionPage } from './types.js';
export type { NotionClient } from './types.js';
