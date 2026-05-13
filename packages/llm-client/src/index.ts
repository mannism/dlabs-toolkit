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

// Linked AbortController helper — fan-out with shared root signal + per-call timeouts (v1.4.0+)
export type { LinkedAbortControllerOptions, LinkedAbortHandle } from './abort.js';
export { linkedAbortController } from './abort.js';
// Factory functions — all five providers fully implemented
export { createClient, createClientFromEnv } from './client.js';
// HTTP status classifier — useful for consumers building custom error handlers
export { classifyHttpStatus } from './retry.js';
// Core message format shared across all providers
// Client config, usage, response, streaming, error types
// Error kind type — consumers use this to branch without parsing message strings
// RetryConfig / RetryStrategy — configurable retry (v1.2.0+)
export type {
  LlmCallOptions,
  LlmCallWithToolsOptions,
  LlmClient,
  LlmClientConfig,
  LlmErrorKind,
  LlmMessage,
  LlmResponse,
  LlmStreamChunk,
  LlmStreamStructuredEvent,
  LlmStructuredResponse,
  LlmTool,
  LlmToolCall,
  LlmToolResponse,
  LlmUsage,
  RetryConfig,
  RetryStrategy,
} from './types.js';
// Error class and kind discriminator — exported as value, not just type
export { LlmError } from './types.js';
