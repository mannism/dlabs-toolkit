/**
 * @diabolicallabs/llm-client
 *
 * Unified LLM API across Anthropic, OpenAI, Google, and DeepSeek.
 * Provides a single LlmClient interface with streaming, structured output,
 * exponential-backoff retry, and normalised token usage across all providers.
 *
 * Implementation begins Week 2. This file exports the public type surface only.
 */

// Core message format shared across all providers
export type { LlmMessage } from './types.js';

// Client config, usage, response, streaming, error types
export type { LlmClientConfig } from './types.js';
export type { LlmUsage } from './types.js';
export type { LlmResponse } from './types.js';
export type { LlmStreamChunk } from './types.js';
export type { LlmStructuredResponse } from './types.js';
export type { LlmClient } from './types.js';

// Error class — exported as value, not just type
export { LlmError } from './types.js';

// Factory functions — implementation stubs until Week 2
export { createClient, createClientFromEnv } from './client.js';
