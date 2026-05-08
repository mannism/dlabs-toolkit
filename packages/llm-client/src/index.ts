/**
 * @diabolicallabs/llm-client
 *
 * Unified LLM API across Anthropic, OpenAI, Gemini, DeepSeek, and Perplexity.
 * Provides a single LlmClient interface with streaming, structured output,
 * exponential-backoff retry, and normalized token usage across all providers.
 *
 * Week 2: Anthropic + OpenAI fully implemented.
 * Week 3: Gemini + DeepSeek.
 * Week 5: Perplexity — search-grounded, citations, providerOptions escape hatch.
 */

// Factory functions — all five providers fully implemented
export { createClient, createClientFromEnv } from './client.js';
// Core message format shared across all providers
// Client config, usage, response, streaming, error types
export type {
  LlmCallOptions,
  LlmClient,
  LlmClientConfig,
  LlmMessage,
  LlmResponse,
  LlmStreamChunk,
  LlmStructuredResponse,
  LlmUsage,
} from './types.js';
// Error class — exported as value, not just type
export { LlmError } from './types.js';
