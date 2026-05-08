/**
 * Core type definitions for @diabolicallabs/llm-client.
 * These are the stable public API surface — implementation is in Week 2.
 * Types here match the spec in briefs/brief-platform.md §4.1 exactly.
 *
 * Week 5 additions:
 *   LlmResponse.citations — populated by the Perplexity provider; undefined for all others.
 *   LlmCallOptions — per-call options type extracted for reuse; adds providerOptions escape hatch.
 */

// The canonical message format shared across all providers
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Config passed to createClient
export interface LlmClientConfig {
  // Full 5-provider union — gemini, deepseek, perplexity are type-only stubs in Week 2
  provider: 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'perplexity';
  model: string; // e.g. 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-flash'
  apiKey: string;
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 1000 — exponential backoff base
  maxTokens?: number; // provider default if omitted
  temperature?: number; // provider default if omitted
  timeoutMs?: number; // default: 30000
}

// Normalized token usage — same shape regardless of provider
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationTokens?: number; // Anthropic prompt cache write tokens
  cacheReadTokens?: number; // Anthropic prompt cache read tokens
}

// Non-streaming response
export interface LlmResponse {
  content: string;
  model: string; // model ID actually used (may differ from requested)
  usage: LlmUsage;
  latencyMs: number;
  /**
   * Web citations returned by the Perplexity provider.
   * Populated only when the Perplexity API returns source references.
   * Always undefined for Anthropic, OpenAI, Gemini, and DeepSeek.
   * Deduplicated by URL within a single response.
   */
  citations?: Array<{
    url: string;
    title?: string;
  }>;
}

/**
 * Per-call options shared across complete(), stream(), and structured().
 * Extends the standard model/maxTokens/temperature overrides with:
 *   providerOptions — generic escape hatch for provider-specific parameters.
 *                     The Perplexity provider reads search_domain_filter and
 *                     search_recency_filter from this field; other providers ignore it.
 *                     Unknown fields are passed through unchanged.
 */
export interface LlmCallOptions
  extends Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>> {
  providerOptions?: Record<string, unknown>;
}

// Streaming chunk
export interface LlmStreamChunk {
  token: string;
  usage?: LlmUsage; // present only on the final chunk
}

// Normalized error — wraps provider-specific errors
export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly provider: string;
  readonly statusCode: number | undefined;
  readonly retryable: boolean;
  // `cause` is declared on Error in lib.es2022.error.d.ts as `cause?: unknown`
  // We override it here to make it always present (not optional) after construction.
  override readonly cause: unknown;

  constructor(opts: {
    message: string;
    provider: string;
    statusCode?: number;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.provider = opts.provider;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable;
    this.cause = opts.cause;
  }
}

// Structured output — Zod schema inference
export type LlmStructuredResponse<T> = {
  data: T;
  usage: LlmUsage;
  latencyMs: number;
};

// The LlmClient interface — what consumers program against
export interface LlmClient {
  readonly config: Readonly<LlmClientConfig>;

  // Non-streaming completion
  complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse>;

  // Streaming completion — async generator of chunks
  stream(messages: LlmMessage[], options?: LlmCallOptions): AsyncGenerator<LlmStreamChunk>;

  // Structured output — parses and validates the response against a Zod schema
  // Forces JSON mode on providers that support it; falls back to parse-and-validate
  structured<T>(
    messages: LlmMessage[],
    // Using a narrower interface than the full ZodType to avoid a hard zod dependency at types level
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>>;
}
