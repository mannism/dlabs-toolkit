/**
 * Types for @diabolicallabs/llm-pricing.
 *
 * Design: flat provider → model → pricing structure. Consumers can override the
 * entire table or patch individual model entries at createClient() time.
 *
 * All monetary values are USD per 1 million tokens.
 */

/** Per-model pricing record. All prices in USD per 1M tokens. */
export interface ModelPricing {
  /** USD per 1M input tokens (standard / cache miss rate). */
  inputPer1M: number;

  /** USD per 1M output tokens. */
  outputPer1M: number;

  /**
   * USD per 1M cache read tokens.
   * Undefined = cache not supported or not opt-in for this model.
   */
  cacheReadPer1M?: number;

  /**
   * USD per 1M cache write tokens.
   * Anthropic: 5-minute (ephemeral) write rate — maps to providerOptions.promptCache: 'ephemeral'.
   * Undefined = cache write not separately billed (e.g. DeepSeek auto-caches server-side).
   */
  cacheWritePer1M?: number;

  /**
   * USD per 1M cache write tokens for the 1-hour duration tier.
   * Anthropic-only — omit for all other providers.
   * computeCost() uses this only when a future LlmUsage.cacheWrite1hTokens field is present.
   */
  cacheWrite1hPer1M?: number;

  /**
   * Long-context input threshold in tokens (e.g. 200_000 for Gemini 3.1 Pro).
   * When set, inputPer1M is the short-context rate and longContextInputPer1M applies above the threshold.
   */
  longContextThreshold?: number;

  /** USD per 1M input tokens when totalInputTokens > longContextThreshold. */
  longContextInputPer1M?: number;

  /** USD per 1M output tokens when totalInputTokens > longContextThreshold. */
  longContextOutputPer1M?: number;

  /** USD per 1M cache read tokens when totalInputTokens > longContextThreshold. */
  longContextCacheReadPer1M?: number;

  /**
   * Reasoning models (o-series, DeepSeek thinking mode) bill reasoning tokens
   * against outputPer1M but do not return them in visible output.
   * When true, computeCost() marks the result isPartial = true and warns consumers.
   */
  hasInvisibleReasoningTokens?: boolean;

  /**
   * Models with known cost components that computeCost() cannot fully cover from token usage.
   * Example: sonar-deep-research has citation token fees and per-search-query fees.
   * computeCost() returns a floor cost and sets LlmCost.isPartial = true.
   */
  partialCostCoverage?: boolean;

  /** ISO 8601 date this record was last verified against provider pricing documentation. */
  verifiedAt: string;

  /** Source URL for this pricing record — official provider docs or best available cross-reference. */
  sourceUrl: string;

  /**
   * If this model ID is a deprecated alias, the canonical ID it resolves to.
   * computeCost() emits a `pricing_deprecated_alias` log event (via the configured
   * PricingLogger) when it resolves through a deprecated alias.
   */
  deprecatedAliasFor?: string;
}

/** The top-level pricing table. Structured as provider → model → pricing. */
export interface PricingTable {
  /** ISO 8601 date the table was last verified and published. Used for staleness detection. */
  versionedAt: string;

  anthropic: Record<string, ModelPricing>;
  openai: Record<string, ModelPricing>;
  gemini: Record<string, ModelPricing>;
  deepseek: Record<string, ModelPricing>;
  perplexity: Record<string, ModelPricing>;
  xai: Record<string, ModelPricing>;
}

/** Supported provider names — matches @diabolicallabs/llm-client provider strings. */
export type Provider = 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'perplexity' | 'xai';

/** Token usage shape — mirrors LlmUsage from @diabolicallabs/llm-client. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Anthropic 5-minute ephemeral cache write tokens. */
  cacheCreationTokens?: number;
  /** Anthropic cache read (hit) tokens. */
  cacheReadTokens?: number;
}

/** Computed cost for a single LLM call. All monetary values in USD. */
export interface LlmCost {
  /** Input token cost (USD). */
  input: number;
  /** Output token cost (USD). */
  output: number;
  /** Cache read token cost (USD). */
  cacheRead: number;
  /** Cache write token cost (USD). */
  cacheWrite: number;
  /** Total cost (USD) = input + output + cacheRead + cacheWrite. */
  total: number;
  currency: 'USD';
  /**
   * True when the model has known billing components that could not be computed
   * from token usage alone (e.g. o-series reasoning tokens, sonar-deep-research fees).
   * The total is a floor, not a ceiling.
   */
  isPartial: boolean;
}

/** Input to computeCost(). */
export interface ComputeCostInput {
  usage: LlmUsage;
  provider: Provider;
  model: string;
  /** Override the default pricing table for this call. Merged at the model level. */
  pricingTable?: PricingTable;
}

/**
 * Pluggable logger interface. Configure via `setPricingLogger()`.
 *
 * Default behavior: structured JSON to stdout via `console.log`. Override to
 * route diagnostics through your application logger (pino, winston, Datadog,
 * OpenTelemetry, etc.) or back to human-readable stderr for CLI consumers.
 *
 * Stable event names emitted by the package:
 * - `pricing_deprecated_alias` — `{ provider, model, deprecatedAliasFor }`
 * - `pricing_date_strip_fallback` — `{ provider, model, alias }`
 * - `pricing_unknown_model` — `{ provider, model }`
 * - `pricing_fetch_failed` — `{ url, error, fallback }`
 */
export interface PricingLogger {
  warn: (event: string, data: Record<string, unknown>) => void;
}
