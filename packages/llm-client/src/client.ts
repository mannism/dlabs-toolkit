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
  LlmMessage,
  LlmResponse,
  LlmStructuredResponse,
  LlmTool,
  LlmToolResponse,
} from './types.js';
import { LlmError } from './types.js';

/**
 * Create an LlmClient for the given provider and config.
 * Dispatches to the provider-specific implementation.
 * All five providers are fully implemented.
 *
 * When config.pricing is set, cost computation is applied to every
 * complete(), structured(), and withTools() response.
 */
export function createClient(config: LlmClientConfig): LlmClient {
  let baseClient: LlmClient;

  switch (config.provider) {
    case 'anthropic':
      baseClient = createAnthropicProvider(config);
      break;

    case 'openai':
      baseClient = createOpenAIProvider(config);
      break;

    case 'gemini':
      baseClient = createGeminiProvider(config);
      break;

    case 'deepseek':
      baseClient = createDeepSeekProvider(config);
      break;

    case 'perplexity':
      baseClient = createPerplexityProvider(config);
      break;

    default: {
      // TypeScript exhaustiveness check — if a new provider is added to the union
      // without a case here, this will be a compile-time error.
      const _exhaustive: never = config.provider;
      throw new LlmError({
        message: `[dlabs-toolkit] Unknown provider: ${String(_exhaustive)}`,
        provider: String(_exhaustive),
        retryable: false,
      });
    }
  }

  // If pricing is not configured, return the bare provider client.
  if (config.pricing === undefined) {
    return baseClient;
  }

  // Pricing is configured — wrap the client with cost computation.
  return wrapWithPricing(baseClient, config);
}

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
    structured,
    withTools,
  };
}

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
