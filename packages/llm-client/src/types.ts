/**
 * Core type definitions for @diabolicallabs/llm-client.
 * These are the stable public API surface — implementation is in Week 2.
 * Types here match the spec in briefs/brief-platform.md §4.1 exactly.
 *
 * Week 5 additions:
 *   LlmResponse.citations — populated by the Perplexity provider; undefined for all others.
 *   LlmCallOptions — per-call options type extracted for reuse; adds providerOptions escape hatch.
 *
 * Week 6 additions (v0.3.0 — abort/timeout/stall):
 *   LlmCallOptions.timeoutMs      — per-call timeout override (ms); overrides config.timeoutMs.
 *   LlmCallOptions.signal         — caller-supplied AbortSignal; aborts in-flight call.
 *   LlmCallOptions.streamStallTimeoutMs — per-stream stall detection (ms); default 30000.
 *   LlmClientConfig.streamStallTimeoutMs — config-level stall default.
 *   LlmError.kind                 — discriminator for error classification.
 *
 * v0.4.0 additions (strict structured outputs):
 *   LlmStructuredResponse.model      — model ID actually used (always populated).
 *   LlmStructuredResponse.id         — provider request ID where available (debugging).
 *   LlmStructuredResponse.citations  — web citations from Perplexity structured responses.
 *   LlmClient.structured JSDoc       — Zod 4 trigger and structuredMode escape hatch.
 *
 * v1.0.0 additions (breaking):
 *   LlmErrorKind — expanded from 6 to 15 kinds. Paths that previously emitted kind:'http' for
 *   classified HTTP errors now emit the specific kind (rate_limit, server_error, auth, not_found,
 *   bad_request, content_filter, context_length). kind:'http' is preserved as a residual fallback
 *   only. Consumers checking err.kind === 'http' must migrate — see MIGRATION.md.
 *   LlmError.kind — type updated from LlmErrorKind|undefined to always LlmErrorKind (required).
 *
 * v0.4.3 additions (Anthropic prompt cache opt-in):
 *   LlmCallOptions.providerOptions.promptCache — Anthropic-only. Pass 'ephemeral' to inject
 *   cache_control: { type: 'ephemeral' } on the system message block. Anthropic caches the
 *   system prompt for 5 minutes; reads cost 0.10× and writes cost 1.25× normal input price.
 *   Ignored on all non-Anthropic providers.
 *
 * v1.3.0 additions (streamStructured — token-stream + final-validated):
 *   LlmStreamStructuredEvent — discriminated union of events emitted by streamStructured().
 *   LlmClient.streamStructured — async generator: tokens streamed, Zod-validated at end.
 *   Supported providers: OpenAI (Responses API), Anthropic, DeepSeek (JSON-mode accumulation).
 *   Unsupported: Gemini (throws bad_request), Perplexity (throws bad_request).
 *   No partial: true mode — deferred until a consumer explicitly needs it.
 *
 * v1.2.0 additions (configurable retry strategy):
 *   LlmClientConfig.retry — optional RetryConfig (maxAttempts, strategy, baseDelayMs, maxDelayMs,
 *                           respectRetryAfter, retryOn). Default behavior unchanged when omitted.
 *   LlmError.headers      — optional Record<string, string> carrying provider response headers.
 *                           Used by respectRetryAfter to read the 429 Retry-After header value.
 *   LlmClientConfig.model accepts string | string[] for provider failover (v1.2.0+).
 *   LlmClientConfig.fallbackOn — optional LlmErrorKind[] controlling when failover triggers.
 *   LlmResponse.requestedModel — the originally-requested primary model when failover occurred.
 *   LlmToolResponse.requestedModel — same.
 *   LlmStructuredResponse.requestedModel — same.
 *
 * v1.1.0 additions (cost computation):
 *   LlmClientConfig.pricing — optional pricing config. When set, each response carries cost?.
 *   LlmResponse.cost        — optional USD cost breakdown (LlmCost from @diabolicallabs/llm-pricing).
 *   LlmStructuredResponse.cost — same.
 *   LlmToolResponse.cost    — same.
 *   Requires @diabolicallabs/llm-pricing to be installed (optional peer dep).
 */

import type { LlmCost, PricingTable } from '@diabolicallabs/llm-pricing';

// ─── RetryConfig ─────────────────────────────────────────────────────────────

/**
 * Retry strategy selector.
 *
 * exponential  — full jitter: delay = random(0, base * 2^attempt). Default.
 * linear       — delay grows linearly: delay = base * (attempt + 1). No jitter.
 * fixed        — constant delay: delay = base. Ignores attempt number.
 * decorrelated — AWS decorrelated jitter: sleep = min(cap, random_between(base, prev * 3)).
 *                Breaks correlation between concurrent callers retrying after the same error.
 */
export type RetryStrategy = 'exponential' | 'linear' | 'fixed' | 'decorrelated';

/**
 * Full retry configuration. Accepted by LlmClientConfig.retry (v1.2.0+).
 * When omitted from LlmClientConfig, existing default behavior is preserved
 * (exponential + full jitter, 3 retries, 1000ms base, 30s cap).
 */
export interface RetryConfig {
  /**
   * Maximum number of attempts total (initial call + retries).
   * e.g. maxAttempts: 4 means 1 initial + 3 retries.
   * Minimum: 1 (no retries). Default: 4 (3 retries).
   */
  maxAttempts?: number;
  /** Retry backoff strategy. Default: 'exponential'. */
  strategy?: RetryStrategy;
  /** Base delay in ms. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Applied to all strategies. Default: 30000. */
  maxDelayMs?: number;
  /**
   * When true, a 429 response with a Retry-After header uses the header value
   * (parsed as integer seconds) as the sleep duration instead of the computed delay.
   * HTTP-date format is not currently parsed (TODO: add RFC 7231 date parsing if needed).
   * Default: false.
   */
  respectRetryAfter?: boolean;
  /**
   * Error kinds that trigger a retry. Errors with kinds not in this list are thrown
   * immediately regardless of the error's retryable flag.
   * Default: ['rate_limit', 'server_error', 'timeout', 'network'].
   */
  retryOn?: LlmErrorKind[];
}

// The canonical message format shared across all providers
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Config passed to createClient
export interface LlmClientConfig {
  // Full 5-provider union — gemini, deepseek, perplexity are type-only stubs in Week 2
  provider: 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'perplexity';
  /**
   * Model identifier. Accepts a string or an array of strings for provider failover (v1.2.0+).
   * When an array is passed, the first element is the primary model. On errors matching
   * fallbackOn, the retry layer falls through to the next model in the array.
   * Backwards-compatible: a single string is coerced to a one-element array internally.
   * e.g. ['gpt-5.5', 'gpt-4.1'] — attempts gpt-5.5 first, falls back to gpt-4.1 on not_found.
   */
  model: string | string[];
  apiKey: string;
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 1000 — exponential backoff base
  maxTokens?: number; // provider default if omitted
  temperature?: number; // provider default if omitted
  timeoutMs?: number; // default: 30000
  /**
   * Default stall timeout for stream() calls (ms). Fires when no chunk is received
   * for this duration. Independent of timeoutMs — tolerant of reasoning-model think-pauses.
   * Default: 30000.
   */
  streamStallTimeoutMs?: number;
  /**
   * Configurable retry strategy (v1.2.0+).
   * When omitted, defaults to exponential + full jitter, 3 retries, 1000ms base, 30s cap.
   * When set, overrides maxRetries, baseDelayMs, and retry behavior per the RetryConfig spec.
   *
   * @example
   * retry: {
   *   maxAttempts: 5,
   *   strategy: 'decorrelated',
   *   baseDelayMs: 500,
   *   maxDelayMs: 30_000,
   *   respectRetryAfter: true,
   *   retryOn: ['rate_limit', 'server_error', 'timeout', 'network'],
   * }
   */
  retry?: RetryConfig;
  /**
   * Error kinds that trigger provider failover to the next model in the model array (v1.2.0+).
   * Only meaningful when model is a string array. When retries on the primary model are
   * exhausted and the last error's kind is in this list, the call is retried from scratch
   * with the next model in the array.
   * Default: ['not_found']
   *
   * @example
   * fallbackOn: ['not_found', 'auth']
   */
  fallbackOn?: LlmErrorKind[];
  /**
   * Optional pricing configuration (v1.1.0+).
   * Requires @diabolicallabs/llm-pricing to be installed as an optional peer dependency.
   *
   * When set, every response from complete(), structured(), and withTools() will carry
   * a cost?: LlmCost field with the per-component USD cost breakdown.
   *
   * @example
   * const client = createClient({
   *   provider: 'anthropic',
   *   model: 'claude-sonnet-4-6',
   *   apiKey: process.env.ANTHROPIC_API_KEY!,
   *   pricing: { computeOnEveryCall: true },
   * });
   * const response = await client.complete(messages);
   * console.log(response.cost?.total); // e.g. 0.0045 (USD)
   */
  pricing?: {
    /** Custom pricing table. Merged over the default table at the provider level. */
    table?: PricingTable;
    /**
     * When true, cost is computed on every call and attached to the response.
     * Default: true when pricing config is present.
     */
    computeOnEveryCall?: boolean;
  };
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
  /**
   * The originally-requested primary model (v1.2.0+).
   * Populated only when provider failover occurred (model[] config with >1 element)
   * and the call was served by a fallback model. Undefined when no failover happened.
   */
  requestedModel?: string;
  usage: LlmUsage;
  latencyMs: number;
  /**
   * Response / request ID for tracing and correlation (v1.4.0+).
   *
   * Always present. Sources:
   *   - Anthropic: response.id (message ID).
   *   - OpenAI: rawResponse.id (Responses API response ID).
   *   - DeepSeek: rawResponse.id (Chat Completions response ID).
   *   - Perplexity: response.id (Chat Completions response ID).
   *   - Gemini: synthesized UUID v7-style (time-derived + random) — Gemini does not
   *     issue native response IDs on generateContent calls.
   *
   * Use idSource to distinguish provider-issued from toolkit-synthesized IDs.
   */
  id: string;
  /**
   * Indicates whether id was issued by the provider or synthesized by the toolkit (v1.4.0+).
   *
   * 'provider'    — the provider issued this id natively.
   * 'synthesized' — the toolkit generated a UUID v7-style id because the provider
   *                 does not issue native response IDs (currently: Gemini).
   *
   * Use this field when building trace correlation systems to distinguish durable
   * provider IDs from toolkit-generated correlation IDs.
   */
  idSource: 'provider' | 'synthesized';
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
  /**
   * USD cost breakdown for this call (v1.1.0+).
   * Populated when LlmClientConfig.pricing is set.
   * Requires @diabolicallabs/llm-pricing peer dep.
   * isPartial: true when billing components exist that cannot be computed from usage alone.
   */
  cost?: LlmCost;
}

/**
 * Per-call options shared across complete(), stream(), and structured().
 * Extends the standard model/maxTokens/temperature overrides with:
 *   timeoutMs           — per-call timeout override; overrides config.timeoutMs for this call only.
 *   signal              — caller-supplied AbortSignal; aborts the in-flight call immediately.
 *                         A pre-aborted signal throws without making an SDK call (no retry).
 *                         A mid-call abort throws kind:'cancelled', retryable:false (no retry).
 *   streamStallTimeoutMs — per-call stall detection for stream(); overrides config default.
 *   providerOptions     — generic escape hatch for provider-specific parameters.
 *                         The Perplexity provider reads search_domain_filter and
 *                         search_recency_filter from this field; other providers ignore it.
 *                         Unknown fields are passed through unchanged.
 */
export interface LlmCallOptions
  extends Partial<Pick<LlmClientConfig, 'maxTokens' | 'temperature' | 'timeoutMs'>> {
  /**
   * Per-call model override. Must be a single string (unlike LlmClientConfig.model which
   * accepts an array for failover). Overrides the config-level model for this call only.
   */
  model?: string;
  /** Caller-supplied AbortSignal. Cancels the in-flight call. Never retried. */
  signal?: AbortSignal;
  /**
   * Per-call stall timeout for stream() in ms. Overrides config.streamStallTimeoutMs.
   * Fires when no chunk arrives within this window. Default: config.streamStallTimeoutMs ?? 30000.
   */
  streamStallTimeoutMs?: number;
  /**
   * Provider-specific options escape hatch. Known fields:
   *
   * **Anthropic:**
   * - `promptCache?: 'ephemeral'` — inject `cache_control: { type: 'ephemeral' }` on the
   *   system message block (and tool definition in strict mode). Anthropic caches the block
   *   for 5 minutes. Minimum cacheable block: 1024 tokens (Sonnet/Opus), 2048 (Haiku).
   *   Below minimum, the API silently ignores the marker. Cost: 1.25× write surcharge,
   *   0.10× read discount. Break-even at ~3 cache reads within the TTL window. Ignored on
   *   all non-Anthropic providers. (v0.4.3+)
   * - `structuredMode?: 'prompt'` — force prompt-only path in structured() even when a
   *   Zod 4 schema is passed. (v0.4.0+)
   *
   * **Perplexity:**
   * - `search_recency_filter?: 'month' | 'week' | 'day' | 'hour'` — limit search results by age.
   * - `search_domain_filter?: string[]` — allowlist of domains to include in search.
   *   Unknown fields are forwarded unchanged.
   */
  providerOptions?: Record<string, unknown>;
}

// Streaming chunk
export interface LlmStreamChunk {
  token: string;
  usage?: LlmUsage; // present only on the final chunk
}

/**
 * Discriminator for LlmError — lets callers branch on error class without
 * parsing message strings.
 *
 * Retryable defaults (source of truth is LlmError.retryable — providers may override):
 *
 * | Kind                   | Default retryable | Notes                                              |
 * |------------------------|-------------------|----------------------------------------------------|
 * | rate_limit             | yes               | 429 from any provider                              |
 * | server_error           | yes               | 5xx from any provider                              |
 * | timeout                | yes               | Per-call timeoutMs exceeded / APIConnectionTimeout |
 * | stream_stall           | no                | Inter-chunk stall; partial output unsafe to retry  |
 * | network                | yes               | ECONNRESET, ENETUNREACH, DNS failures              |
 * | auth                   | no                | 401, 403                                           |
 * | not_found              | no                | 404 — typically wrong model name                   |
 * | bad_request            | no                | 400 — schema or payload error                      |
 * | content_filter         | no                | Provider refused on safety grounds                 |
 * | context_length         | no                | Input exceeded model context window                |
 * | tool_arguments_invalid | no                | Tool call arguments failed Zod parse               |
 * | structured_parse_failed| no                | structured() output failed Zod parse               |
 * | cancelled              | no                | AbortSignal fired (caller-initiated)               |
 * | http                   | no                | Residual fallback for unclassified HTTP errors     |
 * | unknown                | yes               | Catch-all; should be empty for instrumented paths  |
 */
export type LlmErrorKind =
  | 'rate_limit'
  | 'server_error'
  | 'timeout'
  | 'stream_stall'
  | 'network'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'content_filter'
  | 'context_length'
  | 'tool_arguments_invalid'
  | 'structured_parse_failed'
  | 'cancelled'
  | 'http'
  | 'unknown';

// Normalized error — wraps provider-specific errors
export class LlmError extends Error {
  override readonly name = 'LlmError';
  readonly provider: string;
  readonly statusCode: number | undefined;
  readonly retryable: boolean;
  /**
   * Error kind discriminator — always present as of v1.0.0.
   * Use this to drive retry logic and error handling without parsing message strings.
   * See the LlmErrorKind table above for the full taxonomy and default retryability.
   */
  readonly kind: LlmErrorKind;
  /**
   * Response headers from the provider, when available (v1.2.0+).
   * Used by respectRetryAfter to read the Retry-After header value on 429 responses.
   * Undefined when the error did not originate from an HTTP response.
   */
  readonly headers: Record<string, string> | undefined;
  // `cause` is declared on Error in lib.es2022.error.d.ts as `cause?: unknown`
  // We override it here to make it always present (not optional) after construction.
  override readonly cause: unknown;

  constructor(opts: {
    message: string;
    provider: string;
    statusCode?: number;
    retryable: boolean;
    /** Default: 'unknown'. All provider normalizers must supply an explicit kind. */
    kind?: LlmErrorKind;
    /** Response headers — used for Retry-After parsing on rate_limit errors. */
    headers?: Record<string, string>;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.provider = opts.provider;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable;
    this.kind = opts.kind ?? 'unknown';
    this.headers = opts.headers;
    this.cause = opts.cause;
  }
}

/**
 * Structured output response.
 *
 * v0.4.0 — additive fields:
 *   model      — model ID reported by the provider (always present).
 *   id         — provider request / message ID for tracing and debugging.
 *                Populated by OpenAI (response.id) and Anthropic (response.id).
 *                Undefined for Gemini, DeepSeek, and Perplexity.
 *   citations  — web citations propagated from Perplexity structured calls.
 *                Undefined for all other providers.
 *
 * v1.4.0 — id is now always present (no longer optional).
 *   idSource   — 'provider' | 'synthesized'. Indicates whether id was issued by the
 *                provider (Anthropic, OpenAI, DeepSeek, Perplexity) or synthesized by
 *                the toolkit (Gemini — UUID v7-style, time-derived + random).
 */
export type LlmStructuredResponse<T> = {
  data: T;
  model: string;
  /**
   * Response / request ID for tracing and correlation (v1.4.0+).
   * Always present. See LlmResponse.id for full source documentation.
   */
  id: string;
  /**
   * Indicates whether id was issued by the provider or synthesized by the toolkit (v1.4.0+).
   * See LlmResponse.idSource for full documentation.
   */
  idSource: 'provider' | 'synthesized';
  usage: LlmUsage;
  latencyMs: number;
  citations?: Array<{ url: string; title?: string }>;
  /**
   * USD cost breakdown for this call (v1.1.0+).
   * Populated when LlmClientConfig.pricing is set.
   */
  cost?: LlmCost;
  /**
   * The originally-requested primary model (v1.2.0+).
   * Populated only when provider failover occurred — i.e. the configured model array
   * had its primary rejected and a fallback was used. When present, model holds the
   * actually-serving fallback model and requestedModel holds the primary.
   * Undefined when no failover happened or when model is a single string.
   */
  requestedModel?: string;
};

/**
 * Tool declaration — passed to withTools() to describe a callable function.
 *
 * inputSchema is a Zod-compatible schema (must have a `parse` function).
 * The toolkit calls inputSchema.parse(arguments) on the model's returned arguments
 * before putting them in LlmToolCall.arguments. If parse throws, the toolkit
 * throws LlmError with kind:'tool_arguments_invalid'.
 */
export interface LlmTool {
  name: string;
  description: string;
  /** Zod-compatible schema. Same narrow interface as structured()'s schema param. */
  inputSchema: { parse(d: unknown): unknown };
}

/**
 * A single tool call returned by the model.
 *
 * id: provider-issued call ID where available; UUID v7 synthesized for Gemini
 *   (which does not issue call IDs natively).
 * toolName: the function name the model chose to call.
 * arguments: parsed against the tool's inputSchema before return.
 * rawArguments: the pre-parse string for debugging.
 */
export interface LlmToolCall {
  id: string;
  toolName: string;
  arguments: unknown;
  rawArguments: string;
}

/**
 * Response from withTools().
 *
 * content: any text the model returned alongside tool calls (often empty when tool_use fires).
 * toolCalls: array of parsed tool invocations. Empty if the model declined to call tools.
 * stopReason: normalized stop reason across all providers.
 *   'tool_use'       — model called one or more tools.
 *   'end_turn'       — model finished without calling tools.
 *   'max_tokens'     — output was cut by token limit.
 *   'stop_sequence'  — custom stop sequence hit.
 *   'content_filter' — safety refusal (also covers Gemini SAFETY finish reason).
 *   'pause_turn'     — Anthropic-specific: extended thinking pause.
 *   'refusal'        — Anthropic-specific: model refusal without content_filter.
 */
export interface LlmToolResponse {
  content: string;
  toolCalls: LlmToolCall[];
  model: string;
  /**
   * The originally-requested primary model (v1.2.0+).
   * Populated only when provider failover occurred and the call was served by a fallback.
   * Undefined when no failover happened.
   */
  requestedModel?: string;
  usage: LlmUsage;
  latencyMs: number;
  /**
   * Response / request ID for tracing and correlation (v1.4.0+).
   * Always present. See LlmResponse.id for full source documentation.
   */
  id: string;
  /**
   * Indicates whether id was issued by the provider or synthesized by the toolkit (v1.4.0+).
   * See LlmResponse.idSource for full documentation.
   */
  idSource: 'provider' | 'synthesized';
  stopReason:
    | 'tool_use'
    | 'end_turn'
    | 'max_tokens'
    | 'stop_sequence'
    | 'content_filter'
    | 'pause_turn'
    | 'refusal';
  /**
   * USD cost breakdown for this call (v1.1.0+).
   * Populated when LlmClientConfig.pricing is set.
   */
  cost?: LlmCost;
}

/**
 * Options for withTools() — extends LlmCallOptions with tool-calling knobs.
 *
 * toolChoice: how the model should choose tools.
 *   'auto'         — model decides (default).
 *   'any'          — model must call at least one tool (Anthropic-specific; maps to 'required' on OpenAI).
 *   'none'         — model must not call any tool.
 *   { name: X }   — model must call the named tool.
 *
 * parallelToolCalls: whether the model may call multiple tools in a single turn.
 *   true  — parallel calls allowed (default).
 *   false — force sequential (one tool call per turn).
 *   Provider mapping:
 *     OpenAI Responses API: parallel_tool_calls (direct flag, default true).
 *     Anthropic: disable_parallel_tool_use: true on tool_choice (inverse semantics).
 *     Gemini: ignored — no equivalent flag.
 *     DeepSeek: parallel_tool_calls on Chat Completions.
 */
export interface LlmCallWithToolsOptions extends LlmCallOptions {
  toolChoice?: 'auto' | 'any' | 'none' | { name: string };
  parallelToolCalls?: boolean;
}

/**
 * Discriminated union of events emitted by streamStructured() (v1.3.0+).
 *
 * token — an incremental text token from the model (same as stream() chunks).
 *          Useful for showing typing progress in UIs before the final object is ready.
 * done  — emitted exactly once, at the end. Carries the Zod-validated data and
 *          accumulated usage for the full call. Never emitted if an error is thrown.
 *
 * Error path: if JSON.parse() or schema.parse() fails on the accumulated text, an
 * LlmError with kind:'structured_parse_failed' is thrown (no 'done' event emitted).
 *
 * No 'partial' event: partial Zod validation is deferred to a future wave.
 */
export type LlmStreamStructuredEvent<T> =
  | { type: 'token'; token: string }
  | { type: 'done'; data: T; usage: LlmUsage };

// The LlmClient interface — what consumers program against
export interface LlmClient {
  readonly config: Readonly<LlmClientConfig>;

  // Non-streaming completion
  complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse>;

  // Streaming completion — async generator of chunks
  stream(messages: LlmMessage[], options?: LlmCallOptions): AsyncGenerator<LlmStreamChunk>;

  /**
   * Structured output — parses and validates the response against a schema.
   *
   * **Strict native mode (v0.4.0+):**
   * Pass a Zod 4 schema to automatically opt into the provider's strictest native
   * structured-output path:
   *   - OpenAI: `text.format: { type: 'json_schema', strict: true }` (Responses API)
   *   - Anthropic: forced tool-use with `tool_choice: { type: 'tool', name: 'extract' }`
   *   - Gemini: `responseSchema` populated in GenerateContentConfig
   *
   * **Prompt-only fallback:**
   * If the schema is not a Zod 4 instance, or if
   * `options.providerOptions.structuredMode === 'prompt'` is set, the v0.3.0
   * system-prompt + parse path is used instead. This is the escape hatch for:
   *   - Zod 4 schemas that use unrepresentable features (z.function(), z.lazy(), etc.)
   *   - Non-Zod schema objects that satisfy the narrow `{ parse }` interface
   *   - DeepSeek and Perplexity (no native schema mode — always prompt-only)
   *
   * **Defense-in-depth:** schema.parse() is called on the parsed result even
   * after a native strict-mode call, to catch truncation or partial outputs.
   *
   * @param schema - A Zod 4 schema (triggers strict mode) or any `{ parse }` interface.
   *                 Using a narrower interface than ZodType avoids a hard zod dependency at
   *                 the types level.
   */
  structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>>;

  /**
   * Streaming structured output — combines token streaming with Zod-validated final output (v1.3.0+).
   *
   * Emits a series of { type: 'token', token } events for each text chunk received
   * from the provider, followed by exactly one { type: 'done', data, usage } event
   * when the model finishes. The accumulated text is JSON.parse()'d and validated
   * against the schema before the 'done' event.
   *
   * **Supported providers:**
   * - OpenAI (Responses API): streams output_text.delta events, validates at end.
   * - Anthropic: streams content_block_delta text events via tool-use forced path, validates at end.
   * - DeepSeek: streams Chat Completions deltas with json_object mode, validates at end.
   *
   * **Unsupported providers:**
   * - Gemini: throws LlmError(kind:'bad_request') immediately. Gemini does not reliably
   *   support simultaneous structured-output constraints and streaming. Use stream() for
   *   tokens or structured() for validation.
   * - Perplexity: throws LlmError(kind:'bad_request') immediately. Search/retrieval
   *   models do not return tool-validated JSON.
   *
   * **Error path:** if JSON.parse() or schema.parse() fails on the accumulated text,
   * throws LlmError(kind:'structured_parse_failed'). No 'done' event is emitted.
   *
   * **AbortSignal:** propagated to the underlying SDK stream.
   *   options.signal mid-stream → kind:'cancelled', retryable:false.
   *   options.streamStallTimeoutMs → stall detection (same as stream()).
   *
   * @param messages - conversation messages.
   * @param schema   - any { parse } interface (Zod 4 recommended for strict mode on OpenAI).
   * @param options  - per-call options (timeout, signal, stallTimeout, providerOptions).
   */
  streamStructured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>>;

  /**
   * Native tool-calling — returns provider-issued tool invocations parsed against schemas.
   *
   * **Supported providers:** OpenAI (Responses API), Anthropic, Gemini, DeepSeek.
   * **Perplexity:** throws LlmError(kind:'bad_request') immediately — Perplexity models
   *   do not support tool calling.
   *
   * Tool arguments are validated against each tool's inputSchema before return.
   * Validation failure throws LlmError(kind:'tool_arguments_invalid').
   *
   * @param messages - conversation messages.
   * @param tools    - tool declarations (name, description, inputSchema).
   * @param options  - optional: toolChoice, parallelToolCalls, plus all LlmCallOptions.
   */
  withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse>;
}
