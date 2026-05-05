/**
 * @diabolicallabs/llm-client
 *
 * Unified LLM API across Anthropic, OpenAI, Gemini, DeepSeek, and Perplexity.
 * Provides a single LlmClient interface with streaming, structured output,
 * exponential-backoff retry, and normalised token usage across all providers.
 *
 * Week 2: Anthropic + OpenAI fully implemented.
 * Week 3: Gemini + DeepSeek.
 * Later: Perplexity.
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

// Factory functions — Anthropic + OpenAI implemented. Gemini/DeepSeek/Perplexity stubs.
export { createClient, createClientFromEnv } from './client.js';
