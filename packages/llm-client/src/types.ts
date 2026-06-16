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
 * v1.5.0 additions (pre-call hooks API):
 *   LlmCallType          — union of the five call-type discriminators.
 *   LlmCallContext       — context object passed to beforeCall hooks.
 *   LlmBeforeCallResult  — return shape from beforeCall; mutation or short-circuit.
 *   LlmSkipResult        — named union for the skip field (all valid response shapes).
 *   LlmAfterCallContext  — context object passed to afterCall hooks.
 *   LlmHooks             — { beforeCall?, afterCall? } interface.
 *   LlmClientConfig.hooks — optional LlmHooks; wires hooks into every call type.
 *
 * v1.6.0 additions (streaming usage in afterCall):
 *   LlmAfterCallContext.usage — now populated for all 5 call types. For non-streaming paths
 *     (complete, structured, withTools), usage comes from the response object (unchanged).
 *     For stream(), usage comes from the final chunk's usage field (emitted by the provider
 *     when stream_options.include_usage is set — OpenAI — or on the terminal chunk — others).
 *     For streamStructured(), usage comes from the 'done' event. The agent-sdk stream wrappers
 *     retained in v1.4.0 are deleted in agent-sdk@2.0.0 once this field is populated here.
 *
 * Hook semantics:
 *   - beforeCall fires once per public method invocation, NOT per retry attempt.
 *   - Returning { messages, options } from beforeCall replaces the originals for that call.
 *   - Returning { skip: response } short-circuits the provider call entirely.
 *   - beforeCall errors propagate as LlmError({ kind: 'bad_request' }).
 *   - afterCall errors are logged (structured warn) and dropped — never crash the caller.
 *   - For streaming paths (stream(), streamStructured()), afterCall fires after generator
 *     exhaustion. usage is populated in afterCall from the final chunk / done event (v1.6.0+).
 *   - LlmCallContext.model reflects the primary model at beforeCall time; if failover fires,
 *     afterCall receives the actual serving model via response.model.
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
 *
 * v5.0.0 additions (BREAKING — tool schema discriminated union):
 *   LlmToolSchema           — new discriminated union type for LlmTool.inputSchema.
 *                             Variants: { kind:'zod'; schema: ZodType } and
 *                             { kind:'jsonSchema'; schema: Record<string,unknown>; validate?: fn }.
 *   LlmTool.inputSchema     — changed from { parse(d): unknown } to LlmToolSchema.
 *                             Bare { parse: fn } objects now throw tool_schema_invalid at runtime.
 *   LlmErrorKind            — added 'tool_schema_invalid' (not retryable).
 *
 * v5.1.0 additions (Files API — video + large-file inputs):
 *   LlmFileMediaType        — MIME type union for uploadable files (video/*, image/*, PDF).
 *   LlmFileState            — 'processing' | 'active' | 'failed' lifecycle states.
 *   LlmFileRef              — provider-neutral file reference returned after upload.
 *   LlmFilesApi             — upload / refresh / waitForActive / delete namespace.
 *   LlmContentBlock         — extended with { type: 'file'; ref: LlmFileRef } variant.
 *   LlmClient.files         — LlmFilesApi namespace on every client instance.
 *
 *   Provider support matrix:
 *     Gemini    — full: upload, async state poll (PROCESSING→ACTIVE), fileData part.
 *     OpenAI    — PDF only via input_file.file_id; video rejected with bad_request.
 *     Anthropic — PDF + image via Files beta (files-api-2025-04-14); video rejected.
 *     DeepSeek / Perplexity — upload rejects with bad_request; no Files API.
 *
 *   Error kinds: all file errors map to existing LlmErrorKind values.
 *     bad_request — unsupported media type, cross-provider ref, non-active ref, failed upload.
 *     timeout     — waitForActive exceeded timeoutMs.
 *     network     — Files API network failure.
 *     server_error — Files API 5xx from provider.
 */

import type { LlmCost, PricingTable } from '@diabolicallabs/llm-pricing';
import type { z } from 'zod';

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

// ─── Multimodal content block types (v4.2.0) ─────────────────────────────────

/**
 * Image media types supported by LlmContentBlock.
 * Corresponds to the MIME types accepted by Anthropic, OpenAI, and Gemini vision APIs.
 */
export type LlmImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/**
 * Document media types supported by LlmContentBlock.
 * Only PDF is supported in v4.2.0 — URL source for documents is not generalized
 * across providers and is excluded from this type surface.
 */
export type LlmDocumentMediaType = 'application/pdf';

// ─── Files API types (v5.1.0) ─────────────────────────────────────────────────

/**
 * MIME types accepted by the Files API across providers.
 *
 * Video types (MP4, QuickTime, WebM) — Gemini only. OpenAI and Anthropic reject with bad_request.
 * Image types — Gemini (all) and Anthropic (JPEG, PNG, GIF, WebP). OpenAI rejects via Files API.
 * PDF — Gemini, OpenAI, and Anthropic all support upload + reference.
 */
export type LlmFileMediaType =
  | 'video/mp4'
  | 'video/quicktime'
  | 'video/webm'
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf';

/**
 * Lifecycle state of a file at the provider.
 *
 * processing — Gemini: file has been uploaded but is being transcoded/indexed.
 *              Call waitForActive() before referencing in a message.
 * active     — Ready to use. All providers return active refs immediately except Gemini for video.
 * failed     — Provider processing failed. The ref cannot be used. Treat as bad_request error.
 */
export type LlmFileState = 'processing' | 'active' | 'failed';

/**
 * Provider-neutral file reference returned by client.files.upload().
 *
 * Refs are NOT portable across providers — the id is provider-issued and only meaningful
 * to the provider it came from. The provider field is included so callers can detect
 * cross-provider misuse, and so the mapper can reject mismatched refs with a clear error.
 *
 * Gemini: id holds the `files/abc123` resource name which doubles as the fileUri.
 * OpenAI: id is the `file-xyz` Files API object id used in input_file.file_id.
 * Anthropic: id is the `file_...` Files beta object id used in source.file_id.
 */
export interface LlmFileRef {
  /** Provider-issued file identifier. Format is provider-specific; do not parse. */
  id: string;
  /** Provider this ref belongs to. Refs are NOT portable across providers. */
  provider: 'gemini' | 'openai' | 'anthropic';
  mediaType: LlmFileMediaType;
  sizeBytes: number;
  state: LlmFileState;
  /** ISO 8601 expiry timestamp. Present when the provider returns an expiry (Gemini: 48h TTL). */
  expiresAt?: string;
}

/**
 * Files API namespace — upload, refresh, poll, and delete file assets.
 *
 * Workflow:
 *   1. const ref = await client.files.upload({ data, mediaType });
 *   2. const activeRef = await client.files.waitForActive(ref);   // no-op for OpenAI/Anthropic
 *   3. const response = await client.complete([{ role:'user', content:[
 *        { type:'text', text:'Describe this video.' },
 *        { type:'file', ref: activeRef },
 *      ]}]);
 *   4. await client.files.delete(activeRef);  // optional cleanup
 *
 * Error kinds:
 *   bad_request  — unsupported media type, cross-provider ref, non-active ref, failed upload.
 *   timeout      — waitForActive exceeded timeoutMs.
 *   network      — Files API network failure.
 *   server_error — Files API 5xx from provider.
 */
export interface LlmFilesApi {
  /**
   * Upload a binary asset to the provider's file store.
   *
   * Returns immediately with the ref. For Gemini video uploads, the ref may have
   * state: 'processing' — call waitForActive() before referencing it in a message.
   * For OpenAI and Anthropic, refs are always active on return.
   *
   * @throws LlmError({ kind: 'bad_request' }) if the media type is not supported by the provider.
   */
  upload(input: {
    data: Buffer | Uint8Array;
    mediaType: LlmFileMediaType;
    displayName?: string;
  }): Promise<LlmFileRef>;

  /**
   * Re-fetch a ref's current state from the provider.
   *
   * For providers that return ready refs immediately (OpenAI, Anthropic),
   * this resolves with the same ref unchanged. For Gemini, it polls the file resource.
   *
   * @throws LlmError({ kind: 'network' }) on network failure.
   * @throws LlmError({ kind: 'server_error' }) on provider 5xx.
   */
  refresh(ref: LlmFileRef): Promise<LlmFileRef>;

  /**
   * Poll refresh() until the ref reaches state 'active' or the timeout fires.
   *
   * No-op for providers that always return active refs — resolves immediately.
   * For Gemini video uploads, typical processing time is 5–60 seconds.
   *
   * @param opts.timeoutMs   — max wait in ms. Default: 120000 (2 min).
   * @param opts.intervalMs  — poll interval in ms. Default: 2000.
   *
   * @throws LlmError({ kind: 'bad_request' }) if the ref reaches state 'failed'.
   * @throws LlmError({ kind: 'timeout', retryable: true }) if timeoutMs is exceeded.
   */
  waitForActive(
    ref: LlmFileRef,
    opts?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<LlmFileRef>;

  /**
   * Delete a file from the provider's store. Best-effort: logs and continues on 404.
   *
   * @throws LlmError({ kind: 'network' | 'server_error' }) on non-404 failures.
   */
  delete(ref: LlmFileRef): Promise<void>;
}

/**
 * Provider-neutral multimodal content block for LlmMessage.content (v4.2.0+).
 *
 * Replaces (or augments) a string message with typed blocks that map to each
 * provider's native request schema:
 *
 *   Anthropic — text/image/document/file(PDF+image via Files beta) natively supported.
 *   OpenAI    — text/image/document via Responses API; file(PDF) via Files API input_file.
 *   Gemini    — text/image(base64)/document(base64) via inlineData; file via Files API fileData.
 *               URL images are not supported — use base64 source only.
 *   Perplexity — all media blocks rejected with bad_request (v4.2.0).
 *                Image support is deferred pending live smoke confirmation.
 *   DeepSeek  — all media blocks rejected with bad_request.
 *
 * v5.1.0: new `file` block for provider Files API references. The ref carries the
 * media type and provider, so callers don't repeat that information in the block.
 * Cross-provider refs are rejected pre-flight with bad_request.
 *
 * Use toolkit identifier `mediaType` (camelCase), not the provider-specific `media_type`.
 * Use `type: 'url'` source only for images — document URL support is out of scope.
 */
export type LlmContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source:
        | { type: 'base64'; mediaType: LlmImageMediaType; data: string }
        | { type: 'url'; url: string };
    }
  | {
      type: 'document';
      source: { type: 'base64'; mediaType: LlmDocumentMediaType; data: string; filename?: string };
    }
  // v5.1.0: file block for provider Files API references (video, large images, PDFs).
  // ref.provider must match the receiving provider — cross-provider refs throw bad_request.
  // For Gemini refs, ensure ref.state === 'active' before use; call waitForActive() first.
  | { type: 'file'; ref: LlmFileRef };

/**
 * A single conversation turn passed to complete(), stream(), structured(), and withTools().
 * The 'system' role sets the model's behavioral instructions; 'user' and 'assistant' form
 * the conversation history. All providers normalize to this three-role shape regardless of
 * their native message format.
 *
 * v4.2.0: content now accepts `string | LlmContentBlock[]`. String content is unchanged
 * on all providers. Array content enables multimodal input (images, PDFs) where supported.
 * Unsupported media throws LlmError({ kind: 'bad_request' }) before any network call.
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LlmContentBlock[];
}

/**
 * Configuration for createClient(). Selects the provider, model, and API key;
 * controls retry behavior, timeouts, stall detection, cost tracking, and the
 * optional pre-call hooks API. Passed once at construction — per-call overrides
 * go in LlmCallOptions.
 */
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
   * Optional hooks configuration (v1.5.0+).
   * Fires for all five call types: complete, stream, structured, withTools, streamStructured.
   *
   * beforeCall fires once per public method invocation, NOT per retry attempt.
   * afterCall fires after the call completes (or after generator exhaustion for streams).
   * For streaming paths, afterCall receives response: undefined and usage populated from
   * the terminal chunk / done event (v1.6.0+). All five supported providers emit usage
   * on their final streaming event.
   *
   * @see LlmHooks for the full hook interface and examples.
   */
  hooks?: LlmHooks;
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
    /**
     * Custom pricing table. Merged over the default table at the provider level.
     * When set, this takes precedence over remoteUrl — consumer-explicit table wins.
     * Precedence order (highest to lowest):
     *   1. pricing.table  (consumer override — explicit, static)
     *   2. pricing.remoteUrl (fetched once on createClient() init, cached)
     *   3. DEFAULT_PRICING_TABLE (bundled fallback — always available)
     */
    table?: PricingTable;
    /**
     * When true, cost is computed on every call and attached to the response.
     * Default: true when pricing config is present.
     */
    computeOnEveryCall?: boolean;
    /**
     * Remote URL for the canonical pricing JSON (v1.7.0+).
     *
     * When set, createClient() fetches the pricing table from this URL on init
     * (with a stale-while-revalidate cache). Useful for picking up price updates
     * without a new npm release of @diabolicallabs/llm-pricing.
     *
     * Recommended value:
     *   'https://raw.githubusercontent.com/mannism/dlabs-toolkit/main/pricing/table.json'
     *
     * Ignored when pricing.table is also set (consumer-explicit table wins).
     *
     * On fetch failure, falls back silently to DEFAULT_PRICING_TABLE.
     * Requires @diabolicallabs/llm-pricing ^0.2.0.
     */
    remoteUrl?: string;
    /**
     * Cache TTL in milliseconds for the remote pricing table (v1.7.0+).
     *
     * Default: 86_400_000 (24 hours).
     *
     * Rationale: GitHub raw fetches are cheap but bounded. 24h matches the
     * realistic provider-repricing cadence — faster wouldn't catch drift sooner;
     * slower starts to lag noticeably.
     *
     * Only relevant when pricing.remoteUrl is set.
     */
    cacheTtlMs?: number;
  };
}

/**
 * Normalized token usage for a completed call. Carried on every response type
 * (LlmResponse, LlmStructuredResponse, LlmToolResponse) and in LlmAfterCallContext
 * for streaming paths. The shape is provider-agnostic — Anthropic cache fields are
 * undefined for all other providers.
 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheCreationTokens?: number; // Anthropic prompt cache write tokens
  cacheReadTokens?: number; // Anthropic prompt cache read tokens
}

/**
 * Return value from complete(). Carries the model's text content alongside
 * normalized usage, latency, a provider-issued or synthesized response ID,
 * and optional cost and web citations fields.
 */
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

/**
 * A single incremental chunk yielded by stream(). Usage is present only on the
 * final chunk — all preceding chunks carry only token. Consumers must check
 * `chunk.usage !== undefined` to identify the terminal chunk.
 */
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
 * | tool_schema_invalid    | no                | LlmTool.inputSchema is missing or has an unrecognized kind — legacy { parse: fn } shape or malformed object passed to withTools() |
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
  | 'tool_schema_invalid'
  | 'cancelled'
  | 'http'
  | 'unknown';

/**
 * Normalized error thrown by all LlmClient methods. Wraps provider-specific errors
 * into a consistent shape with a kind discriminator, HTTP status code, retryability
 * flag, and optional response headers. Catch this class to handle all llm-client
 * failure modes — never match on message strings.
 * @see LlmErrorKind for the full taxonomy and default retryability per kind.
 */
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
 * Discriminated union describing the input schema attached to an LlmTool (v5.0.0+).
 *
 * Required on every LlmTool passed to withTools(). Two variants:
 *
 *   kind: 'zod'
 *     Pass a Zod 4 `ZodType`. The toolkit calls `schema.parse()` for argument
 *     validation after the model returns its arguments, and converts the schema
 *     to the provider's JSON Schema dialect automatically for the wire call.
 *     No separate `validate` function is needed — Zod handles both directions.
 *
 *     @example
 *     ```ts
 *     const weatherTool: LlmTool = {
 *       name: 'get_weather',
 *       description: 'Get the weather for a city.',
 *       inputSchema: { kind: 'zod', schema: z.object({ city: z.string() }) },
 *     };
 *     ```
 *
 *   kind: 'jsonSchema'
 *     Pass a plain JSON Schema object. The `schema` is sent to the provider
 *     verbatim (no conversion). An optional `validate` function is called on
 *     the raw model output for validation; when omitted, the output is returned
 *     as-is without type checking.
 *
 *     @example
 *     ```ts
 *     const weatherTool: LlmTool = {
 *       name: 'get_weather',
 *       description: 'Get the weather for a city.',
 *       inputSchema: {
 *         kind: 'jsonSchema',
 *         schema: {
 *           type: 'object',
 *           properties: { city: { type: 'string' } },
 *           required: ['city'],
 *         },
 *         validate: (d) => {
 *           if (typeof (d as { city?: unknown }).city !== 'string') {
 *             throw new Error('city must be a string');
 *           }
 *           return d as { city: string };
 *         },
 *       },
 *     };
 *     ```
 *
 * v5.0.0 migration:
 *   Before (v4.x): `inputSchema: { parse: (d) => d }`
 *   After  (Zod):  `inputSchema: { kind: 'zod', schema: z.object({ ... }) }`
 *   After  (JSON): `inputSchema: { kind: 'jsonSchema', schema: { ... }, validate?: fn }`
 *
 * Passing an object without a recognized `kind` field (e.g. the legacy `{ parse: fn }`
 * shape) throws `LlmError({ kind: 'tool_schema_invalid' })` at runtime. Not retryable.
 */
export type LlmToolSchema =
  | { kind: 'zod'; schema: z.ZodType }
  | { kind: 'jsonSchema'; schema: Record<string, unknown>; validate?: (d: unknown) => unknown };

/**
 * Tool declaration passed to withTools() to describe a callable function.
 *
 * `inputSchema` must be an LlmToolSchema discriminated union (v5.0.0+).
 *
 * - `{ kind: 'zod', schema: ZodType }` — Zod 4 schema. The toolkit converts it to
 *   the provider's JSON Schema dialect for the wire call and calls `schema.parse()`
 *   to validate the model's returned arguments. Recommended for type-safe tools.
 *
 * - `{ kind: 'jsonSchema', schema: JsonSchema, validate?: fn }` — plain JSON Schema
 *   sent verbatim to the provider. The optional `validate` function is called on the
 *   raw model output; when omitted, the output is returned without validation.
 *
 * After validation succeeds, the result is placed in LlmToolCall.arguments.
 * Validation failure (from Zod or from `validate`) throws LlmError with
 * kind: 'tool_arguments_invalid', retryable: false.
 *
 * Passing the legacy v4.x `{ parse: fn }` shape (missing `kind`) throws
 * LlmError with kind: 'tool_schema_invalid', retryable: false.
 * See LlmToolSchema for migration examples.
 */
export interface LlmTool {
  name: string;
  description: string;
  inputSchema: LlmToolSchema;
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

// ─── Hooks API (v1.5.0) ──────────────────────────────────────────────────────

/**
 * Discriminates which LlmClient method was invoked.
 * Passed in LlmCallContext so beforeCall/afterCall hooks can branch per call type.
 */
export type LlmCallType = 'complete' | 'stream' | 'structured' | 'withTools' | 'streamStructured';

/**
 * Context object passed to beforeCall hooks before the provider call executes.
 *
 * model reflects the primary (first) model in the config array at beforeCall time.
 * If provider failover fires after beforeCall returns, afterCall will receive the
 * actual serving model via response.model — a small asymmetry; see LlmAfterCallContext.
 *
 * Hooks fire once per public method invocation, NOT per retry attempt.
 * If complete() retries 3 times internally, beforeCall fires once (before attempt 1)
 * and afterCall fires once (after the final successful response). The retry layer is
 * below the hook layer — hooks are a consumer-facing interception point, not retry observers.
 */
export interface LlmCallContext {
  messages: LlmMessage[];
  options: LlmCallOptions | undefined;
  /** Provider name, e.g. 'anthropic', 'openai'. */
  provider: string;
  /**
   * Resolved primary model string (the first element when config.model is an array).
   * May differ from response.model when provider failover occurs.
   */
  model: string;
  /** Which LlmClient method was invoked. */
  callType: LlmCallType;
}

/**
 * Named union for the skip field in LlmBeforeCallResult.
 *
 * For non-streaming call types (complete, structured, withTools): use the matching
 * response shape. For streaming call types (stream, streamStructured): use the matching
 * AsyncGenerator shape. The dispatcher validates shape against callType at runtime.
 */
export type LlmSkipResult =
  | LlmResponse
  | LlmStructuredResponse<unknown>
  | LlmToolResponse
  | AsyncGenerator<LlmStreamChunk>
  | AsyncGenerator<LlmStreamStructuredEvent<unknown>>;

/**
 * Return shape for beforeCall hooks.
 *
 * To mutate the request: return { messages?, options? } — the provided values replace
 * the originals for this call only. Subsequent calls use the original config values.
 *
 * To short-circuit: return { skip: response } — the dispatcher returns skip to the
 * caller immediately, without executing the provider call or the retry/failover layers.
 * The type of skip must match callType (e.g. LlmResponse for 'complete'). Mismatches
 * are caught at runtime and thrown as LlmError({ kind: 'bad_request' }).
 *
 * Returning undefined or void passes through with no mutation.
 */
export interface LlmBeforeCallResult {
  messages?: LlmMessage[];
  options?: LlmCallOptions;
  skip?: LlmSkipResult;
}

/**
 * Context object passed to afterCall hooks after the provider call completes.
 *
 * For non-streaming paths (complete, structured, withTools):
 *   response is the full response object; usage mirrors response.usage; error is undefined on success.
 *
 * For streaming paths (stream, streamStructured):
 *   response is undefined — no accumulated response object exists.
 *   usage is populated from the final chunk's usage field (stream) or the 'done' event (streamStructured).
 *   If the stream ends without emitting a usage value (e.g. the provider does not include usage on the
 *   terminal chunk), usage is undefined.
 *   latencyMs measures call-to-generator-exhaustion time.
 *
 * afterCall fires after any successful call or after an error. When error is defined,
 * response is undefined. afterCall exceptions are logged (structured warn) and dropped —
 * they must never crash a call that already returned.
 */
export interface LlmAfterCallContext {
  request: LlmCallContext;
  /**
   * The response object, when available.
   * Undefined for streaming paths (stream, streamStructured) — no accumulated response object
   * exists. Also undefined when error is defined (call failed).
   * Read usage directly from the usage field for stream/streamStructured paths (v1.6.0+).
   */
  response: LlmResponse | LlmStructuredResponse<unknown> | LlmToolResponse | undefined;
  /**
   * Normalized token usage for the call (v1.6.0+).
   *
   * Non-streaming paths (complete, structured, withTools): always present on success;
   * mirrors response.usage. Undefined when error is defined (call failed before a response).
   *
   * Streaming paths (stream, streamStructured): present when the provider emits usage on
   * the terminal chunk (stream) or the 'done' event (streamStructured). Undefined when the
   * stream errors before emitting usage, or when the provider does not include usage
   * on the final chunk (provider-dependent — all five supported providers do emit it).
   */
  usage: LlmUsage | undefined;
  /**
   * The error, when the call failed. Undefined on success.
   * afterCall fires on both success and error paths.
   */
  error: LlmError | undefined;
  /** Milliseconds from call initiation to completion (or to generator exhaustion for streams). */
  latencyMs: number;
}

/**
 * Hook registration interface. Pass as hooks? on LlmClientConfig.
 *
 * Both hooks are optional and async-only. Sync work is expressible inside an async function.
 *
 * @example PII redaction before call
 * ```ts
 * const client = createClient({
 *   provider: 'openai', model: 'gpt-5.5', apiKey: '...',
 *   hooks: {
 *     beforeCall: async (ctx) => ({
 *       messages: ctx.messages.map(m => ({
 *         ...m,
 *         content: redactPii(m.content),
 *       })),
 *     }),
 *   },
 * });
 * ```
 *
 * @example Short-circuit cache
 * ```ts
 * hooks: {
 *   beforeCall: async (ctx) => {
 *     const cached = await cache.get(cacheKey(ctx.messages));
 *     if (cached) return { skip: cached };
 *   },
 * }
 * ```
 *
 * @example Custom logging
 * ```ts
 * hooks: {
 *   afterCall: async (ctx) => {
 *     logger.info({ callType: ctx.request.callType, latencyMs: ctx.latencyMs });
 *   },
 * }
 * ```
 */
export interface LlmHooks {
  /**
   * Fires before the provider call executes.
   * Return { messages, options } to mutate the request.
   * Return { skip } to short-circuit and return a pre-built response.
   * Return void to pass through unchanged.
   * Errors propagate as LlmError({ kind: 'bad_request' }) to the caller.
   */
  beforeCall?: (ctx: LlmCallContext) => Promise<LlmBeforeCallResult | undefined>;
  /**
   * Fires after the provider call completes (or after generator exhaustion for streams).
   * Informational only — errors are logged (structured warn) and dropped.
   * Never use afterCall for logic that must not fail silently.
   */
  afterCall?: (ctx: LlmAfterCallContext) => Promise<void>;
}

// ─── LlmClient interface ──────────────────────────────────────────────────────

/**
 * The unified LLM client interface — what every consumer programs against.
 * Obtain an instance via createClient() or createClientFromEnv(). Provides
 * five call types across up to five providers: complete, stream, structured,
 * withTools, and streamStructured. The config field exposes the resolved
 * configuration for inspection and is readonly after construction.
 *
 * v5.1.0: files namespace — upload, poll, and reference binary assets via the
 * provider's Files API (Gemini full, OpenAI PDF, Anthropic PDF+image, DeepSeek/Perplexity unsupported).
 */
export interface LlmClient {
  readonly config: Readonly<LlmClientConfig>;

  /**
   * Files API namespace for uploading and managing file assets (v5.1.0+).
   *
   * Use this to upload video, large images, and PDFs to the provider's file store before
   * referencing them in messages via { type: 'file', ref } content blocks.
   *
   * Provider support:
   *   Gemini    — full: video + image + PDF. Async processing for video (call waitForActive()).
   *   OpenAI    — PDF only via input_file.file_id. Video/image rejects with bad_request.
   *   Anthropic — PDF + image via Files beta. Video rejects with bad_request.
   *   DeepSeek / Perplexity — not supported; upload() throws bad_request immediately.
   *
   * @see LlmFilesApi for the full method signatures and error semantics.
   */
  readonly files: LlmFilesApi;

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
