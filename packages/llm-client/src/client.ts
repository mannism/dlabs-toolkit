/**
 * Factory functions for LlmClient.
 *
 * createClient — dispatches to the correct provider implementation.
 * createClientFromEnv — convenience wrapper that reads API keys from env vars.
 *
 * Provider dispatch:
 *   'anthropic'  → fully implemented (Week 2)
 *   'openai'     → fully implemented (Week 2)
 *   'gemini'     → fully implemented (Week 3)
 *   'deepseek'   → fully implemented (Week 3)
 *   'perplexity' → fully implemented (Week 5) — search-grounded, citations, providerOptions
 *
 * v1.1.0 — optional cost computation:
 *   When config.pricing is set, a thin wrapper attaches cost?: LlmCost to every
 *   complete(), structured(), and withTools() response. Requires the optional peer dep
 *   @diabolicallabs/llm-pricing to be installed. If not installed, cost remains undefined
 *   and a warning is emitted once at createClient() time.
 *
 * v1.2.0 — provider failover:
 *   When config.model is a string array, the first element is the primary model.
 *   On errors whose kind appears in config.fallbackOn (default: ['not_found']), after
 *   exhausting retries on the primary, the call is retried from scratch with the next
 *   model in the array. LlmResponse.requestedModel is populated on fallback responses.
 *   Providers always receive a config copy with model: string (single-element, resolved).
 *
 * Internal model contract:
 *   Providers receive a config with model: string (never an array). The array-to-string
 *   normalization and failover loop live entirely in this file. Providers are unaware of
 *   failover — they just see a config with a resolved model string per attempt.
 */

import { runAfterCall, runBeforeCall } from './hooks.js';
import { getLogger } from './logger.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createDeepSeekProvider } from './providers/deepseek.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createPerplexityProvider } from './providers/perplexity.js';
import type {
  LlmAfterCallContext,
  LlmCallContext,
  LlmCallOptions,
  LlmCallWithToolsOptions,
  LlmClient,
  LlmClientConfig,
  LlmErrorKind,
  LlmMessage,
  LlmResponse,
  LlmSkipResult,
  LlmStreamChunk,
  LlmStreamStructuredEvent,
  LlmStructuredResponse,
  LlmTool,
  LlmToolResponse,
} from './types.js';
import { LlmError } from './types.js';

// Default error kinds that trigger failover to the next model in the array.
const DEFAULT_FALLBACK_ON: ReadonlySet<LlmErrorKind> = new Set<LlmErrorKind>(['not_found']);

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Normalize config.model to string[]. Always returns at least one element.
 * A single string is coerced to [string]. This is the single point of normalization.
 */
function resolveModelArray(model: string | string[]): [string, ...string[]] {
  if (Array.isArray(model)) {
    if (model.length === 0) {
      throw new LlmError({
        message: '[llm-client] config.model array must not be empty',
        provider: 'unknown',
        retryable: false,
        kind: 'bad_request',
      });
    }
    return model as [string, ...string[]];
  }
  return [model];
}

/**
 * Create a provider-facing config copy with model coerced to a single string.
 * Providers must always see `model: string` — they pass it directly to SDK calls.
 */
function configForModel(base: LlmClientConfig, model: string): LlmClientConfig & { model: string } {
  return { ...base, model };
}

/**
 * Instantiate the correct provider implementation for a config with model: string.
 * This is the low-level dispatch — no failover, no cost wrapping.
 */
function createProviderClient(config: LlmClientConfig & { model: string }): LlmClient {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider(config);
    case 'openai':
      return createOpenAIProvider(config);
    case 'gemini':
      return createGeminiProvider(config);
    case 'deepseek':
      return createDeepSeekProvider(config);
    case 'perplexity':
      return createPerplexityProvider(config);
    default: {
      // TypeScript exhaustiveness check
      const _exhaustive: never = config.provider;
      throw new LlmError({
        message: `[dlabs-toolkit] Unknown provider: ${String(_exhaustive)}`,
        provider: String(_exhaustive),
        retryable: false,
      });
    }
  }
}

// ─── createClient ────────────────────────────────────────────────────────────

/**
 * Create an LlmClient for the given provider and config.
 *
 * When config.model is a single string: behaves identically to all previous versions.
 * When config.model is a string[]: enables provider failover. The client tries each
 * model in order, moving to the next on errors whose kind matches config.fallbackOn.
 *
 * When config.pricing is set, cost computation is applied to every
 * complete(), structured(), and withTools() response.
 *
 * When config.pricing.remoteUrl is set (v1.7.0+), the pricing table is fetched
 * from that URL on init (with a stale-while-revalidate cache). Adds at most one
 * network round-trip to createClient(). Falls back silently to DEFAULT_PRICING_TABLE
 * on fetch failure — never throws.
 *
 * Pricing source precedence (highest to lowest):
 *   1. pricing.table (consumer override — explicit, static)
 *   2. pricing.remoteUrl (fetched on init, cached per TTL)
 *   3. DEFAULT_PRICING_TABLE (bundled fallback — always available)
 */
export async function createClient(config: LlmClientConfig): Promise<LlmClient> {
  const models = resolveModelArray(config.model);
  const fallbackOnSet: ReadonlySet<LlmErrorKind> =
    config.fallbackOn !== undefined ? new Set(config.fallbackOn) : DEFAULT_FALLBACK_ON;

  // Resolve pricing table if remoteUrl is set and pricing.table is not (table wins).
  // resolvedPricingConfig carries the same shape as config.pricing but may have
  // an overridden table from the remote fetch.
  let resolvedPricingConfig = config.pricing;

  if (
    config.pricing !== undefined &&
    config.pricing.remoteUrl !== undefined &&
    config.pricing.table === undefined
  ) {
    // Dynamic import — keeps @diabolicallabs/llm-pricing optional.
    // If it's not installed, the import fails and we skip remoteUrl silently.
    try {
      const pricingMod = await import('@diabolicallabs/llm-pricing');
      const { fetchRemoteTable } = pricingMod as {
        fetchRemoteTable: (
          url: string,
          opts?: { cacheTtlMs?: number }
        ) => Promise<{
          table: import('@diabolicallabs/llm-pricing').PricingTable;
          source: 'remote' | 'cache' | 'fallback';
          fetchedAt?: string;
          error?: string;
        }>;
      };

      // exactOptionalPropertyTypes: omit cacheTtlMs from options when undefined
      // to avoid passing { cacheTtlMs: undefined } to a { cacheTtlMs?: number } param.
      const fetchOpts =
        config.pricing.cacheTtlMs !== undefined
          ? { cacheTtlMs: config.pricing.cacheTtlMs }
          : undefined;
      const result = await fetchRemoteTable(config.pricing.remoteUrl, fetchOpts);

      // Log pricing source on init — structured line for observability.
      getLogger().warn('pricing_source', {
        source: result.source,
        url: config.pricing.remoteUrl,
        fetchedAt: result.fetchedAt,
        error: result.error,
      });

      // Merge the fetched table into the pricing config for this client instance.
      resolvedPricingConfig = { ...config.pricing, table: result.table };
    } catch {
      // llm-pricing not installed or fetchRemoteTable unavailable.
      // Log and continue with bundled default — cost will be computed from DEFAULT_PRICING_TABLE.
      getLogger().warn('pricing_source', {
        source: 'fallback',
        url: config.pricing.remoteUrl,
        error: '@diabolicallabs/llm-pricing is not installed or fetchRemoteTable unavailable',
      });
    }
  } else if (config.pricing !== undefined) {
    // No remoteUrl — log the source so all clients emit the pricing_source line.
    const source = config.pricing.table !== undefined ? 'consumer_override' : 'bundled';
    getLogger().warn('pricing_source', { source });
  }

  // Build the resolved config — pricing.table now reflects the remote fetch result.
  // exactOptionalPropertyTypes: only spread pricing when it's defined (never set to undefined).
  const resolvedConfig: LlmClientConfig =
    resolvedPricingConfig !== config.pricing && resolvedPricingConfig !== undefined
      ? { ...config, pricing: resolvedPricingConfig }
      : config;

  // Build the inner client (provider + optional failover + optional pricing).
  // wrapWithHooks is applied last so it is the outermost layer — hooks see the
  // final cost-annotated response and wrap the full retry + failover stack.
  let inner: LlmClient;
  if (models.length === 1) {
    const singleConfig = configForModel(resolvedConfig, models[0]);
    inner = createProviderClient(singleConfig);
  } else {
    inner = createFailoverClient(resolvedConfig, models, fallbackOnSet);
  }

  if (resolvedConfig.pricing !== undefined) {
    inner = wrapWithPricing(inner, resolvedConfig);
  }

  // Hooks are outermost — wrapWithHooks is a no-op when config.hooks is undefined.
  return wrapWithHooks(inner, resolvedConfig);
}

// ─── createFailoverClient ────────────────────────────────────────────────────

/**
 * Returns an LlmClient that attempts the primary model first, then falls through
 * to subsequent models on errors whose kind is in the fallbackOn set.
 *
 * Each model in the array creates its own provider client, cached lazily after first use.
 * The outer client exposes config.model as the original array (as-is) for introspection.
 * Per-call responses carry requestedModel (the primary/originally-requested model) when
 * the actual call was served by a fallback.
 */
function createFailoverClient(
  config: LlmClientConfig,
  models: [string, ...string[]],
  fallbackOnSet: ReadonlySet<LlmErrorKind>
): LlmClient {
  // Lazily-created provider clients, one per model index.
  const providerCache: Map<number, LlmClient> = new Map();

  function getProvider(index: number): LlmClient {
    const cached = providerCache.get(index);
    if (cached !== undefined) return cached;
    const model = models[index];
    if (model === undefined) {
      throw new LlmError({
        message: `[llm-client] failover: model index ${index} out of range`,
        provider: config.provider,
        retryable: false,
        kind: 'bad_request',
      });
    }
    const provider = createProviderClient(configForModel(config, model));
    providerCache.set(index, provider);
    return provider;
  }

  const primaryModel = models[0];

  /** Try complete() on each model in order, emitting a structured log on fallback. */
  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    for (let i = 0; i < models.length; i++) {
      try {
        const response = await getProvider(i).complete(messages, options);
        // Tag with requestedModel only when a fallback actually fired.
        if (i > 0) {
          return { ...response, requestedModel: primaryModel };
        }
        return response;
      } catch (err) {
        if (err instanceof LlmError && fallbackOnSet.has(err.kind) && i < models.length - 1) {
          // Log the fallback event before moving to the next model.
          emitFallbackLog(models[i] ?? primaryModel, models[i + 1] ?? primaryModel, err.kind);
          continue;
        }
        throw err;
      }
    }
    // Unreachable — loop always returns or throws.
    throw new LlmError({
      message: '[llm-client] failover: all models exhausted',
      provider: config.provider,
      retryable: false,
    });
  }

  /** stream() does not support failover — streams are stateful and cannot be replayed. */
  async function* stream(
    messages: LlmMessage[],
    options?: LlmCallOptions
  ): AsyncGenerator<import('./types.js').LlmStreamChunk> {
    // Always use primary model for streaming — mid-stream failover is unsafe.
    yield* getProvider(0).stream(messages, options);
  }

  /**
   * streamStructured() does not support failover — same reason as stream().
   * Mid-stream model switching would break the token sequence the consumer is accumulating.
   * Always uses the primary model.
   */
  async function* streamStructured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    yield* getProvider(0).streamStructured(messages, schema, options);
  }

  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    for (let i = 0; i < models.length; i++) {
      try {
        const response = await getProvider(i).structured(messages, schema, options);
        // Tag with requestedModel only when a fallback actually fired.
        if (i > 0) {
          return { ...response, requestedModel: primaryModel };
        }
        return response;
      } catch (err) {
        if (err instanceof LlmError && fallbackOnSet.has(err.kind) && i < models.length - 1) {
          emitFallbackLog(models[i] ?? primaryModel, models[i + 1] ?? primaryModel, err.kind);
          continue;
        }
        throw err;
      }
    }
    throw new LlmError({
      message: '[llm-client] failover: all models exhausted',
      provider: config.provider,
      retryable: false,
    });
  }

  async function withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    for (let i = 0; i < models.length; i++) {
      try {
        const response = await getProvider(i).withTools(messages, tools, options);
        if (i > 0) {
          return { ...response, requestedModel: primaryModel };
        }
        return response;
      } catch (err) {
        if (err instanceof LlmError && fallbackOnSet.has(err.kind) && i < models.length - 1) {
          emitFallbackLog(models[i] ?? primaryModel, models[i + 1] ?? primaryModel, err.kind);
          continue;
        }
        throw err;
      }
    }
    throw new LlmError({
      message: '[llm-client] failover: all models exhausted',
      provider: config.provider,
      retryable: false,
    });
  }

  return {
    // Expose the original config (with array model) for introspection.
    config: Object.freeze({ ...config }),
    // files: delegate to primary provider — failover is not supported for Files API calls
    // since refs are provider-specific and cannot be retried against a different model.
    get files() {
      return getProvider(0).files;
    },
    complete,
    stream,
    structured,
    streamStructured,
    withTools,
  };
}

/** Emit a structured log line on each model_fallback event. */
function emitFallbackLog(from: string, to: string, reason: LlmErrorKind): void {
  // level:'info' in the payload signals ingesters that this is informational,
  // not a warning — the fallback succeeded. Routed through the logger so consumers
  // can redirect or suppress it alongside other llm-client diagnostics.
  getLogger().warn('model_fallback', { level: 'info', from, to, reason });
}

// ─── wrapWithPricing ─────────────────────────────────────────────────────────

/**
 * Wrap an LlmClient to attach cost?: LlmCost on every response.
 *
 * Uses a lazy dynamic import of @diabolicallabs/llm-pricing so that the package
 * remains an optional peer dep — consumers who don't set pricing: {} never pay
 * the import cost, and those without llm-pricing installed get a clear warning
 * instead of a module-not-found crash.
 */
function wrapWithPricing(base: LlmClient, config: LlmClientConfig): LlmClient {
  const pricingConfig = config.pricing;
  if (pricingConfig === undefined) return base;

  // Type alias for the computeCost function signature — keeps the code readable.
  type ComputeCostFn = (opts: {
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    };
    provider: string;
    model: string;
    pricingTable?: unknown;
  }) => {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    currency: 'USD';
    isPartial: boolean;
  };

  // Resolve computeCost lazily — memoize after first successful load.
  // 'notLoaded': not yet attempted. null: load failed (llm-pricing not installed).
  type LoadState = 'notLoaded' | null | ComputeCostFn;
  let loadState: LoadState = 'notLoaded';

  async function loadComputeCost(): Promise<ComputeCostFn | null> {
    if (loadState !== 'notLoaded') {
      // Already loaded or confirmed failed — return null or the fn
      return loadState === null ? null : (loadState as ComputeCostFn);
    }
    try {
      const mod = await import('@diabolicallabs/llm-pricing');
      const fn = mod.computeCost as ComputeCostFn;
      loadState = fn;
      return fn;
    } catch {
      getLogger().warn('pricing_peer_dep_missing', {
        message:
          '@diabolicallabs/llm-pricing is not installed. ' +
          'Install it as an optional dep to enable cost computation. cost will be undefined.',
      });
      loadState = null;
      return null;
    }
  }

  interface UsageShape {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  }

  function buildCostOpts(usage: UsageShape, model: string) {
    return {
      usage,
      provider: config.provider,
      model,
      pricingTable: pricingConfig?.table,
    };
  }

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const response = await base.complete(messages, options);
    const fn = await loadComputeCost();
    if (fn !== null) {
      const cost = fn(buildCostOpts(response.usage, response.model));
      return { ...response, cost };
    }
    return response;
  }

  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    const response = await base.structured(messages, schema, options);
    const fn = await loadComputeCost();
    if (fn !== null) {
      const cost = fn(buildCostOpts(response.usage, response.model));
      return { ...response, cost };
    }
    return response;
  }

  async function withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    const response = await base.withTools(messages, tools, options);
    const fn = await loadComputeCost();
    if (fn !== null) {
      const cost = fn(buildCostOpts(response.usage, response.model));
      return { ...response, cost };
    }
    return response;
  }

  return {
    config: base.config,
    // files: delegate to base — cost wrapping does not apply to Files API calls.
    files: base.files,
    complete,
    // stream() yields individual chunks — cost cannot be computed mid-stream.
    // Delegate directly to the base provider's generator.
    stream: (messages: LlmMessage[], options?: LlmCallOptions) => base.stream(messages, options),
    // streamStructured() accumulates tokens; the 'done' event carries usage but not cost.
    // Cost annotation on streaming calls is out of scope — delegate to base.
    streamStructured: <T>(
      messages: LlmMessage[],
      schema: { parse: (data: unknown) => T },
      options?: LlmCallOptions
    ) => base.streamStructured(messages, schema, options),
    structured,
    withTools,
  };
}

// ─── wrapWithHooks ───────────────────────────────────────────────────────────

/**
 * Wrap an LlmClient to fire beforeCall/afterCall hooks on every method invocation.
 *
 * Hooks fire once per public method invocation — NOT per retry attempt.
 * The retry layer is inside the provider; hooks are the outermost layer.
 *
 * Wrapping order (outermost → innermost):
 *   wrapWithHooks → wrapWithPricing → createFailoverClient → createProviderClient
 *
 * This ensures hooks see the final cost-annotated response from wrapWithPricing,
 * and that beforeCall mutation reaches the provider before any retry or failover logic.
 *
 * v1.6.0: streaming paths now accumulate usage from the terminal chunk (stream) or
 * the 'done' event (streamStructured) and surface it as afterCtx.usage. This allows
 * afterCall hooks — including agent-sdk's ingestion handler — to record token counts
 * without maintaining their own generator wrappers.
 */
function wrapWithHooks(base: LlmClient, config: LlmClientConfig): LlmClient {
  const { hooks } = config;
  if (hooks === undefined) return base;

  /** Resolve the primary model string from config for LlmCallContext. */
  const primaryModel = Array.isArray(config.model) ? (config.model[0] ?? 'unknown') : config.model;

  /** Build a base LlmCallContext for a given call type and arguments. */
  function makeCtx(
    callType: LlmCallContext['callType'],
    messages: LlmMessage[],
    options: LlmCallOptions | undefined
  ): LlmCallContext {
    return { messages, options, provider: config.provider, model: primaryModel, callType };
  }

  /**
   * Normalize any caught value to an LlmError.
   * Ensures the afterCall hook always receives a typed LlmError.
   */
  function asLlmError(err: unknown): LlmError {
    if (err instanceof LlmError) return err;
    return new LlmError({ message: String(err), provider: config.provider, retryable: false });
  }

  /**
   * Helper: assert that a skip result matches the expected response type for non-streaming calls.
   * A skip returning an AsyncGenerator for a non-streaming call type is a consumer bug.
   */
  function assertNonStreamingSkip(
    skip: LlmSkipResult,
    callType: LlmCallContext['callType'],
    provider: string
  ): asserts skip is LlmResponse | LlmStructuredResponse<unknown> | LlmToolResponse {
    if (
      skip !== null &&
      typeof skip === 'object' &&
      typeof (skip as AsyncGenerator<unknown>)[Symbol.asyncIterator] === 'function'
    ) {
      throw new LlmError({
        message: `[llm-client] beforeCall hook returned an AsyncGenerator as skip for non-streaming call type '${callType}'. Return a plain response object instead.`,
        provider,
        retryable: false,
        kind: 'bad_request',
      });
    }
  }

  // ── complete() ──────────────────────────────────────────────────────────────
  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const ctx = makeCtx('complete', messages, options);
    const beforeResult = await runBeforeCall(hooks, ctx);

    if (beforeResult.kind === 'skip') {
      assertNonStreamingSkip(beforeResult.response, 'complete', config.provider);
      return beforeResult.response as LlmResponse;
    }

    const start = Date.now();
    let error: LlmError | undefined;
    let response: LlmResponse | undefined;
    try {
      response = await base.complete(beforeResult.messages, beforeResult.options);
      return response;
    } catch (err) {
      error = asLlmError(err);
      throw err;
    } finally {
      const afterCtx: LlmAfterCallContext = {
        request: ctx,
        response,
        // usage mirrors response.usage on success; undefined on error (no response).
        usage: response?.usage,
        error,
        latencyMs: Date.now() - start,
      };
      await runAfterCall(hooks, afterCtx);
    }
  }

  // ── stream() ─────────────────────────────────────────────────────────────────
  // v1.6.0: accumulates usage from the terminal chunk (where usage is present) and
  // surfaces it as afterCtx.usage. All five supported providers emit usage on the
  // final chunk when streaming. Chunks without usage are passed through unchanged.
  async function* stream(
    messages: LlmMessage[],
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamChunk> {
    const ctx = makeCtx('stream', messages, options);
    const beforeResult = await runBeforeCall(hooks, ctx);

    if (beforeResult.kind === 'skip') {
      // skip for a streaming call must be an AsyncGenerator<LlmStreamChunk>
      const gen = beforeResult.response as AsyncGenerator<LlmStreamChunk>;
      yield* gen;
      return;
    }

    const start = Date.now();
    let error: LlmError | undefined;
    let streamUsage: import('./types.js').LlmUsage | undefined;
    try {
      for await (const chunk of base.stream(beforeResult.messages, beforeResult.options)) {
        // Capture usage from whichever chunk carries it (providers emit on the final chunk).
        if (chunk.usage !== undefined) {
          streamUsage = chunk.usage;
        }
        yield chunk;
      }
    } catch (err) {
      error = asLlmError(err);
      throw err;
    } finally {
      const afterCtx: LlmAfterCallContext = {
        request: ctx,
        response: undefined,
        usage: streamUsage,
        error,
        latencyMs: Date.now() - start,
      };
      await runAfterCall(hooks, afterCtx);
    }
  }

  // ── structured() ─────────────────────────────────────────────────────────────
  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    const ctx = makeCtx('structured', messages, options);
    const beforeResult = await runBeforeCall(hooks, ctx);

    if (beforeResult.kind === 'skip') {
      assertNonStreamingSkip(beforeResult.response, 'structured', config.provider);
      return beforeResult.response as LlmStructuredResponse<T>;
    }

    const start = Date.now();
    let error: LlmError | undefined;
    let response: LlmStructuredResponse<T> | undefined;
    try {
      response = await base.structured(beforeResult.messages, schema, beforeResult.options);
      return response;
    } catch (err) {
      error = asLlmError(err);
      throw err;
    } finally {
      const afterCtx: LlmAfterCallContext = {
        request: ctx,
        response,
        usage: response?.usage,
        error,
        latencyMs: Date.now() - start,
      };
      await runAfterCall(hooks, afterCtx);
    }
  }

  // ── streamStructured() ────────────────────────────────────────────────────────
  // v1.6.0: captures usage from the 'done' event (the single terminal event that
  // carries the full accumulated token count) and surfaces it as afterCtx.usage.
  async function* streamStructured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    const ctx = makeCtx('streamStructured', messages, options);
    const beforeResult = await runBeforeCall(hooks, ctx);

    if (beforeResult.kind === 'skip') {
      const gen = beforeResult.response as AsyncGenerator<LlmStreamStructuredEvent<T>>;
      yield* gen;
      return;
    }

    const start = Date.now();
    let error: LlmError | undefined;
    let streamUsage: import('./types.js').LlmUsage | undefined;
    try {
      for await (const event of base.streamStructured(
        beforeResult.messages,
        schema,
        beforeResult.options
      )) {
        // The 'done' event carries the full accumulated usage for the call.
        if (event.type === 'done') {
          streamUsage = event.usage;
        }
        yield event;
      }
    } catch (err) {
      error = asLlmError(err);
      throw err;
    } finally {
      const afterCtx: LlmAfterCallContext = {
        request: ctx,
        response: undefined,
        usage: streamUsage,
        error,
        latencyMs: Date.now() - start,
      };
      await runAfterCall(hooks, afterCtx);
    }
  }

  // ── withTools() ──────────────────────────────────────────────────────────────
  async function withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    const ctx = makeCtx('withTools', messages, options);
    const beforeResult = await runBeforeCall(hooks, ctx);

    if (beforeResult.kind === 'skip') {
      assertNonStreamingSkip(beforeResult.response, 'withTools', config.provider);
      return beforeResult.response as LlmToolResponse;
    }

    const start = Date.now();
    let error: LlmError | undefined;
    let response: LlmToolResponse | undefined;
    try {
      response = await base.withTools(
        beforeResult.messages,
        tools,
        beforeResult.options as LlmCallWithToolsOptions | undefined
      );
      return response;
    } catch (err) {
      error = asLlmError(err);
      throw err;
    } finally {
      const afterCtx: LlmAfterCallContext = {
        request: ctx,
        response,
        usage: response?.usage,
        error,
        latencyMs: Date.now() - start,
      };
      await runAfterCall(hooks, afterCtx);
    }
  }

  return {
    config: base.config,
    // files: delegate to base — hooks do not wrap Files API calls.
    // File operations are not part of the message call lifecycle.
    files: base.files,
    complete,
    stream,
    structured,
    streamStructured,
    withTools,
  };
}

// ─── createClientFromEnv ─────────────────────────────────────────────────────

/**
 * Convenience: create an LlmClient from environment variables.
 *
 * Reads API keys from the environment based on provider:
 *   anthropic  → ANTHROPIC_API_KEY
 *   openai     → OPENAI_API_KEY
 *   gemini     → GOOGLE_AI_API_KEY
 *   deepseek   → DEEPSEEK_API_KEY
 *   perplexity → PERPLEXITY_API_KEY — recommended default model: 'sonar'
 *
 * Throws LlmError if the required env var is not set.
 */
export async function createClientFromEnv(
  provider: LlmClientConfig['provider'],
  model: string,
  overrides?: Partial<Omit<LlmClientConfig, 'provider' | 'model' | 'apiKey'>>
): Promise<LlmClient> {
  const apiKey = resolveApiKey(provider);
  return createClient({ provider, model, apiKey, ...overrides });
}

/** Read the API key for a given provider from environment variables. */
function resolveApiKey(provider: LlmClientConfig['provider']): string {
  const envVarMap: Record<LlmClientConfig['provider'], string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GOOGLE_AI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
  };

  const envVar = envVarMap[provider];
  const apiKey = process.env[envVar];

  if (apiKey === undefined || apiKey.trim() === '') {
    throw new LlmError({
      message: `[dlabs-toolkit] ${envVar} is not set. Set this environment variable to use the ${provider} provider.`,
      provider,
      retryable: false,
    });
  }

  return apiKey;
}
