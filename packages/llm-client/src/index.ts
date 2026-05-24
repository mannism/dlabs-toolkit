/**
 * @diabolicallabs/llm-client
 *
 * Unified LLM API across 5 providers — Anthropic, OpenAI (Responses API),
 * Gemini (@google/genai v2.x), DeepSeek, and Perplexity. Provides a single
 * LlmClient interface with five call types:
 *   - complete()         — single-shot completion
 *   - stream()           — token streaming
 *   - structured()       — Zod-validated structured output (strict mode)
 *   - withTools()        — native tool calling
 *   - streamStructured() — token streaming + Zod-validated output
 *
 * Features (all 5 providers):
 *   - 14-kind LlmErrorKind taxonomy with .kind discriminator
 *   - Configurable retry (exponential backoff + jitter, respect Retry-After)
 *   - Provider failover via fallbackOn kinds
 *   - Per-call timeoutMs, AbortSignal, stream stall detection
 *   - Native Zod 4 strict structured outputs
 *   - Pre-call (beforeCall) and post-call (afterCall) hooks; usage populated
 *     for all 5 call types including streaming
 *   - providerOptions escape hatch for provider-specific call knobs
 *   - Web-grounded citations (Perplexity)
 *   - Response IDs (id + idSource)
 *   - Optional per-response cost via @diabolicallabs/llm-pricing
 *   - Remote pricing table via pricing.remoteUrl (stale-while-revalidate, never-throws)
 *   - Opt-in Anthropic prompt cache via providerOptions.promptCache: 'ephemeral'
 *   - Pool/semaphore for concurrency + per-provider rate limits
 *     (import from '@diabolicallabs/llm-client/pool')
 *   - getModelCapabilities() capability matrix
 *   - linkedAbortController fan-out (root signal + per-call timeouts)
 *   - Pluggable logger (setLlmClientLogger)
 */

// Linked AbortController helper — fan-out with shared root signal + per-call timeouts (v1.4.0+)
export type { LinkedAbortControllerOptions, LinkedAbortHandle } from './abort.js';
export { linkedAbortController } from './abort.js';
// Provider capability matrix — getModelCapabilities(provider, model) → ModelCapabilities | null (v1.4.0+)
export type { LlmProvider, ModelCapabilities } from './capabilities.js';
export { CAPABILITIES_VERSIONED_AT, getModelCapabilities } from './capabilities.js';
// Factory functions — all five providers fully implemented
export { createClient, createClientFromEnv } from './client.js';
// Pluggable logger — route diagnostic events through your application logger (v4.1.0+)
export type { LlmClientLogger } from './logger.js';
export { setLlmClientLogger } from './logger.js';
// HTTP status classifier — useful for consumers building custom error handlers
export { classifyHttpStatus } from './retry.js';
// Core message format shared across all providers
// Client config, usage, response, streaming, error types
// Error kind type — consumers use this to branch without parsing message strings
// RetryConfig / RetryStrategy — configurable retry (v1.2.0+)
export type {
  LlmAfterCallContext,
  LlmBeforeCallResult,
  LlmCallContext,
  LlmCallOptions,
  LlmCallType,
  LlmCallWithToolsOptions,
  LlmClient,
  LlmClientConfig,
  LlmErrorKind,
  LlmHooks,
  LlmMessage,
  LlmResponse,
  LlmSkipResult,
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
