/**
 * Provider capability matrix for @diabolicallabs/llm-client (v1.4.0+).
 *
 * Exposes a single lookup function: getModelCapabilities(provider, model) → ModelCapabilities | null.
 * Returns null for unknown models — callers should degrade gracefully, not throw.
 *
 * Data sourced from:
 *   - Tom's Wave 2a/3a research (2026-05-13).
 *   - Provider implementations in packages/llm-client/src/providers/*.ts.
 *   - @diabolicallabs/llm-pricing DEFAULT_PRICING_TABLE model list (canonical model coverage).
 *
 * versionedAt: '2026-05-13'
 *
 * Maintenance: update when provider capabilities change or new models are added.
 * Mirror the @diabolicallabs/llm-pricing versionedAt field when models are added/removed.
 */

import type { LlmClientConfig } from './types.js';

// Re-export LlmProvider type from config for convenience
export type LlmProvider = LlmClientConfig['provider'];

/**
 * Structured capability descriptor for a specific provider + model combination.
 *
 * Fields:
 *
 *   contextWindow      — maximum input tokens per call.
 *   maxOutputTokens    — maximum tokens in a single response.
 *   streaming          — supports stream() (true for all currently-implemented providers).
 *   tools              — supports withTools() native tool-calling.
 *   parallelTools      — model/provider can invoke multiple tools in a single turn.
 *                        false for Gemini (no parallelTools flag) and Perplexity (no tools).
 *   promptCache        — Anthropic prompt-cache tier supported by this toolkit build.
 *                        'ephemeral' = 5-min TTL (providerOptions.promptCache: 'ephemeral').
 *                        null for all non-Anthropic providers.
 *   structuredOutput   — the mechanism used by structured() for this provider/model.
 *                        'tool-use'       = Anthropic: forced tool-use with Zod schema.
 *                        'json-schema'    = OpenAI / DeepSeek: text.format json_schema (or JSON mode).
 *                        'response-schema' = Gemini: responseSchema in GenerateContentConfig.
 *                        null             = Perplexity: prompt-only (no native schema support).
 *   responseIds        — whether the provider issues native response IDs or the toolkit synthesizes them.
 *                        'provider'    = provider issues an id on every response.
 *                        'synthesized' = toolkit generates a UUID v7-style id (time-sortable).
 *   streamStructured   — supports streamStructured() (v1.3.0+).
 *                        false for Gemini and Perplexity.
 *   mediaInput         — multimodal content block support (v4.2.0+).
 *                        image.base64    — accepts LlmContentBlock image with source.type 'base64'.
 *                        image.url       — accepts LlmContentBlock image with source.type 'url'.
 *                        document.pdfBase64 — accepts LlmContentBlock document with base64 PDF.
 *                        All false for providers that reject media blocks before any SDK call.
 */
export interface ModelCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  streaming: boolean;
  tools: boolean;
  parallelTools: boolean;
  promptCache: 'ephemeral' | '1h' | null;
  structuredOutput: 'tool-use' | 'json-schema' | 'response-schema' | null;
  responseIds: 'provider' | 'synthesized';
  streamStructured: boolean;
  /**
   * Multimodal content block capability matrix (v4.2.0+).
   * Indicates which LlmContentBlock source types the model + provider pair accepts.
   * Callers can check this before constructing a multimodal LlmMessage to avoid
   * the pre-flight bad_request error when the provider does not support the block type.
   */
  mediaInput: {
    image: { base64: boolean; url: boolean };
    document: { pdfBase64: boolean };
  };
}

// ─── Capability table ─────────────────────────────────────────────────────────

/**
 * ISO 8601 date the capability table was last verified against provider documentation.
 * Compare against Date.now() to detect staleness.
 */
export const CAPABILITIES_VERSIONED_AT = '2026-06-06';

/** Provider-keyed, model-keyed capability lookup table. */
const CAPABILITY_TABLE: Record<LlmProvider, Record<string, ModelCapabilities>> = {
  // ── Anthropic ──────────────────────────────────────────────────────────────
  //
  // promptCache: 'ephemeral' (5-min TTL) is the only tier wired in the toolkit
  //   via providerOptions.promptCache. The 1-hr tier exists on Anthropic's API
  //   but is not yet exposed as a toolkit option.
  // structuredOutput: 'tool-use' — Anthropic structured() forces a tool call with
  //   Zod schema as input_schema; the model must invoke the tool to return structured data.
  // responseIds: 'provider' — Anthropic returns response.id on every API response.
  // streamStructured: true — Anthropic streams content_block_delta events from the
  //   forced tool-use path; accumulated + Zod-validated at end.
  anthropic: {
    'claude-opus-4-7': {
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'claude-opus-4-6': {
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'claude-sonnet-4-6': {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'claude-sonnet-4-5-20250929': {
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'claude-haiku-4-5': {
      contextWindow: 200_000,
      maxOutputTokens: 8_096,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'claude-haiku-4-5-20251001': {
      contextWindow: 200_000,
      maxOutputTokens: 8_096,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'claude-haiku-3-5': {
      contextWindow: 200_000,
      maxOutputTokens: 8_096,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'claude-haiku-3': {
      contextWindow: 200_000,
      maxOutputTokens: 4_096,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      // claude-haiku-3 does not support vision or document input
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  //
  // structuredOutput: 'json-schema' — OpenAI uses text.format { type: 'json_schema', strict: true }
  //   on the Responses API (openai.ts migrated from chat.completions.create to responses.create).
  // responseIds: 'provider' — OpenAI Responses API returns rawResponse.id on every call.
  // streamStructured: true — OpenAI streams ResponseTextDeltaEvent output_text events,
  //   accumulated + Zod-validated at end.
  // parallelTools: true — parallel_tool_calls flag supported on Responses API.
  // o-series notes: o3/o4-mini are reasoning models that charge invisible reasoning tokens
  //   against the output budget. maxOutputTokens below is the completion ceiling, not the
  //   reasoning token budget which is additional.
  openai: {
    'gpt-5.5': {
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'gpt-5.5-pro': {
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'gpt-5.4': {
      contextWindow: 256_000,
      maxOutputTokens: 32_768,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'gpt-5.4-mini': {
      contextWindow: 256_000,
      maxOutputTokens: 32_768,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'gpt-4.1': {
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    o3: {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      // o3 is a reasoning model — vision support documented by OpenAI as supported.
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
    },
    'o4-mini': {
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      // o4-mini is a reasoning model. OpenAI docs list vision support for o4-mini.
      // Set based on published capability docs (June 2026); reverify if model updates.
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: false } },
    },
  },

  // ── Gemini ─────────────────────────────────────────────────────────────────
  //
  // structuredOutput: 'response-schema' — Gemini uses responseSchema in GenerateContentConfig.
  // responseIds: 'synthesized' — Gemini does not issue response IDs; toolkit synthesizes
  //   UUID v7-style IDs (time-derived + random) for tool calls. Non-tool complete() calls
  //   also get synthesized IDs after 3.4 (response IDs everywhere).
  // streamStructured: false — Gemini streamStructured() throws bad_request (v1.3.0);
  //   simultaneous streaming + structured validation is not reliably supported.
  // parallelTools: false — Gemini has no equivalent to OpenAI's parallel_tool_calls flag;
  //   the parameter is ignored.
  // contextWindow/maxOutputTokens: Gemini 3.1 Pro has 1M context and 65k output.
  //   Gemini 2.5 Flash is the GEOAudit default with 1M context.
  gemini: {
    'gemini-3.1-pro-preview': {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      // Gemini accepts image/PDF via inlineData (base64 bytes only).
      // image.url is false — Gemini inlineData does not accept URLs; use base64 bytes only.
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
    },
    'gemini-2.5-pro': {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
    },
    'gemini-2.5-flash': {
      contextWindow: 1_000_000,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
    },
    'gemini-3.1-flash-lite': {
      contextWindow: 1_000_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
    },
  },

  // ── DeepSeek ───────────────────────────────────────────────────────────────
  //
  // DeepSeek uses the OpenAI SDK pointed at https://api.deepseek.com.
  // structuredOutput: 'json-schema' — DeepSeek uses Chat Completions JSON mode
  //   (prompt-only path in the toolkit since deepseek does not support Responses API).
  //   Note: This is the prompt-only fallback, not strict-schema mode.
  // responseIds: 'provider' — DeepSeek Chat Completions returns rawResponse.id.
  // streamStructured: true — DeepSeek streams Chat Completions deltas in json_object mode,
  //   accumulated + Zod-validated at end (v1.3.0).
  // parallelTools: true — DeepSeek V3 (deepseek-v4-flash/pro) supports parallel_tool_calls
  //   on Chat Completions. deepseek-reasoner (deepseek-v4-pro alias) has limited tool support.
  // deepseek-v4-pro promotional pricing note: 75% discount expires 2026-05-31.
  deepseek: {
    'deepseek-v4-flash': {
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      // DeepSeek does not support vision or document input (June 2026).
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
    'deepseek-v4-pro': {
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
    // Deprecated aliases — same capabilities as their canonical counterparts.
    // deepseek-reasoner (R1) note: tool-calling support is limited and may not
    // reliably invoke tools on all task types. Prefer deepseek-v4-flash for tool use.
    'deepseek-chat': {
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
    'deepseek-reasoner': {
      contextWindow: 64_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
  },

  // ── Perplexity ─────────────────────────────────────────────────────────────
  //
  // Sonar models are search/retrieval models — not general-purpose chat completions.
  // tools: false — withTools() throws bad_request immediately (Tom §5.2).
  // parallelTools: false — tools not supported.
  // structuredOutput: null — prompt-only path only; no native schema enforcement.
  //   Note: structured() works via prompt injection + JSON.parse().
  // responseIds: 'provider' — Perplexity returns response.id on API responses.
  // streamStructured: false — throws bad_request immediately (v1.3.0).
  perplexity: {
    sonar: {
      contextWindow: 127_072,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: false,
      parallelTools: false,
      promptCache: null,
      structuredOutput: null,
      responseIds: 'provider',
      streamStructured: false,
      // Perplexity image support deferred (smoke test not run — PERPLEXITY_API_KEY absent 2026-06-06).
      // All media blocks rejected with bad_request in v4.2.0. Documents always unsupported.
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
    'sonar-pro': {
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: false,
      parallelTools: false,
      promptCache: null,
      structuredOutput: null,
      responseIds: 'provider',
      streamStructured: false,
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
    'sonar-reasoning-pro': {
      contextWindow: 127_072,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: false,
      parallelTools: false,
      promptCache: null,
      structuredOutput: null,
      responseIds: 'provider',
      streamStructured: false,
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
    'sonar-deep-research': {
      contextWindow: 127_072,
      maxOutputTokens: 8_192,
      streaming: true,
      tools: false,
      parallelTools: false,
      promptCache: null,
      structuredOutput: null,
      responseIds: 'provider',
      streamStructured: false,
      mediaInput: { image: { base64: false, url: false }, document: { pdfBase64: false } },
    },
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Look up the capability descriptor for a provider + model combination.
 *
 * Returns null for unknown models — callers should degrade gracefully.
 * Never throws.
 *
 * @example
 * const caps = getModelCapabilities('anthropic', 'claude-opus-4-7');
 * if (caps === null) {
 *   console.warn('Unknown model — capability matrix not available');
 * } else if (!caps.tools) {
 *   throw new Error('This workflow requires tool calling');
 * }
 */
export function getModelCapabilities(
  provider: LlmProvider,
  model: string
): ModelCapabilities | null {
  const providerTable = CAPABILITY_TABLE[provider];
  if (providerTable === undefined) return null;
  return providerTable[model] ?? null;
}
