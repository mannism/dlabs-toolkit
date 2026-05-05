/**
 * Core type definitions for @diabolicallabs/llm-client.
 * These are the stable public API surface — implementation is in Week 2.
 * Types here match the spec in briefs/brief-platform.md §4.1 exactly.
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

// Normalised token usage — same shape regardless of provider
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
}

// Streaming chunk
export interface LlmStreamChunk {
  token: string;
  usage?: LlmUsage; // present only on the final chunk
}

// Normalised error — wraps provider-specific errors
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
  complete(
    messages: LlmMessage[],
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): Promise<LlmResponse>;

  // Streaming completion — async generator of chunks
  stream(
    messages: LlmMessage[],
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): AsyncGenerator<LlmStreamChunk>;

  // Structured output — parses and validates the response against a Zod schema
  // Forces JSON mode on providers that support it; falls back to parse-and-validate
  structured<T>(
    messages: LlmMessage[],
    // Using a narrower interface than the full ZodType to avoid a hard zod dependency at types level
    schema: { parse: (data: unknown) => T },
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): Promise<LlmStructuredResponse<T>>;
}
