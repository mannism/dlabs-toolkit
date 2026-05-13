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

import { createAnthropicProvider } from './providers/anthropic.js';
import { createDeepSeekProvider } from './providers/deepseek.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createPerplexityProvider } from './providers/perplexity.js';
import type {
  LlmCallOptions,
  LlmCallWithToolsOptions,
  LlmClient,
  LlmClientConfig,
  LlmErrorKind,
  LlmMessage,
  LlmResponse,
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
 */
export function createClient(config: LlmClientConfig): LlmClient {
  const models = resolveModelArray(config.model);
  const fallbackOnSet: ReadonlySet<LlmErrorKind> =
    config.fallbackOn !== undefined ? new Set(config.fallbackOn) : DEFAULT_FALLBACK_ON;

  // Single-model fast path — no failover wrapping overhead.
  if (models.length === 1) {
    const singleConfig = configForModel(config, models[0]);
    const provider = createProviderClient(singleConfig);
    if (config.pricing === undefined) return provider;
    return wrapWithPricing(provider, config);
  }

  // Multi-model path — wrap with failover logic.
  const failoverClient = createFailoverClient(config, models, fallbackOnSet);
  if (config.pricing === undefined) return failoverClient;
  return wrapWithPricing(failoverClient, config);
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
    complete,
    stream,
    structured,
    streamStructured,
    withTools,
  };
}

/** Emit a structured log line on each model_fallback event. */
function emitFallbackLog(from: string, to: string, reason: LlmErrorKind): void {
  console.log(
    JSON.stringify({
      level: 'info',
      pkg: '@diabolicallabs/llm-client',
      event: 'model_fallback',
      from,
      to,
      reason,
    })
  );
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
      console.warn(
        '[llm-client] pricing config is set but @diabolicallabs/llm-pricing is not installed. ' +
          'Install it as an optional dep to enable cost computation. cost will be undefined.'
      );
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
export function createClientFromEnv(
  provider: LlmClientConfig['provider'],
  model: string,
  overrides?: Partial<Omit<LlmClientConfig, 'provider' | 'model' | 'apiKey'>>
): LlmClient {
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
