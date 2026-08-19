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
/** String union of supported provider names extracted from LlmClientConfig. */
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
 *   reasoningEffort    — reasoning-effort dialect this model accepts (v6.3.0+).
 *                        'anthropic-effort'       = output_config.effort (low/medium/high/xhigh/max).
 *                        'openai-effort'          = reasoning.effort (all 7 LlmReasoningEffort values).
 *                        'gemini-thinking-level'  = thinkingConfig.thinkingLevel (minimal/low/medium/high).
 *                        null = this model's provider doesn't support the field, or (for Anthropic/
 *                        OpenAI/Gemini specifically) this model has not been confirmed to support it.
 *                        Cross-reference the tag against providers/reasoning-effort.ts's exported
 *                        value sets for the exact accepted subset — this field is a dialect tag,
 *                        not a per-model value-set enumeration.
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
  reasoningEffort: 'anthropic-effort' | 'openai-effort' | 'gemini-thinking-level' | null;
}

// ─── Capability table ─────────────────────────────────────────────────────────

/**
 * ISO 8601 date the capability table was last verified against provider documentation.
 * Compare against Date.now() to detect staleness.
 */
export const CAPABILITIES_VERSIONED_AT = '2026-07-29';

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
    // claude-opus-5 (v6.3.0+): context window (1M) and max output tokens (128k) verified
    // live against platform.claude.com/docs/en/about-claude/models/whats-new-opus-5 (2026-07-29).
    // reasoningEffort confirmed via platform.claude.com/docs/en/build-with-claude/effort, which
    // lists Claude Opus 5 among the models supporting output_config.effort at all 5 levels.
    'claude-opus-5': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'anthropic-effort',
    },
    // claude-fable-5 (v6.5.0+): context window (1M) and max output tokens (128k) verified
    // live against platform.claude.com/docs/en/about-claude/models/overview (2026-08-08).
    // reasoningEffort confirmed via platform.claude.com/docs/en/build-with-claude/effort (2026-08-08),
    // which lists claude-fable-5 in the "Supported models" line for output_config.effort.
    'claude-fable-5': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'anthropic-effort',
    },
    // claude-sonnet-5 (v6.5.0+): context window (1M) and max output tokens (128k) verified
    // live against platform.claude.com/docs/en/about-claude/models/overview (2026-08-08).
    // reasoningEffort confirmed via platform.claude.com/docs/en/build-with-claude/effort (2026-08-08),
    // which lists claude-sonnet-5 in the "Supported models" line for output_config.effort.
    'claude-sonnet-5': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'anthropic-effort',
    },
    // claude-opus-4-8 (v6.5.0+): context window (1M) and max output tokens (128k) verified
    // live against platform.claude.com/docs/en/about-claude/models/overview (2026-08-08).
    // reasoningEffort confirmed via platform.claude.com/docs/en/build-with-claude/effort (2026-08-08),
    // which lists claude-opus-4-8 in the "Supported models" line for output_config.effort.
    'claude-opus-4-8': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: 'ephemeral',
      structuredOutput: 'tool-use',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'anthropic-effort',
    },
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
      reasoningEffort: 'anthropic-effort',
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
      reasoningEffort: 'anthropic-effort',
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
      reasoningEffort: 'anthropic-effort',
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
    // gpt-5.6 family (v6.3.0+): Sol/Terra/Luna are the three tiers; 'gpt-5.6' the bare alias
    // routes to Sol. Context window (~1.05M, rounded to 1_000_000 for consistency with sibling
    // gpt-5.x rows) and max output tokens (128k) verified live against
    // developers.openai.com/api/docs/guides/reasoning + /models/gpt-5.6-sol (2026-07-29).
    // reasoningEffort: 'openai-effort' confirmed for all three — the reasoning guide explicitly
    // names gpt-5.6-sol/terra/luna as reasoning.effort-capable models.
    'gpt-5.6-sol': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'openai-effort',
    },
    'gpt-5.6-terra': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'openai-effort',
    },
    'gpt-5.6-luna': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'openai-effort',
    },
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
      reasoningEffort: 'openai-effort',
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
      reasoningEffort: 'openai-effort',
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
      reasoningEffort: 'openai-effort',
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
      reasoningEffort: 'openai-effort',
    },
    // gpt-5.4-nano (v6.4.0+): diverges from sibling gpt-5.4/gpt-5.4-mini — context window
    // (400k) and max output tokens (128k) verified live against
    // developers.openai.com/api/docs/models/gpt-5.4-nano (2026-08-08). Function calling,
    // vision, and file_search/PDF input all confirmed supported on the same page.
    // reasoningEffort: 'openai-effort' confirmed — page lists reasoning.effort levels
    // none/low/medium/high/xhigh.
    'gpt-5.4-nano': {
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'openai-effort',
    },
    // gpt-5.4-pro (v6.4.0+): priced at extended-reasoning-workload rates identical to
    // gpt-5.5-pro ($30/$180 per 1M, pricing/table.json), but its capability shape diverges
    // from gpt-5.5-pro's maxOutputTokens (32_768) — verified live against
    // developers.openai.com/api/docs/models/gpt-5.4-pro (2026-08-08): context window
    // 1,050,000 (rounded to 1_000_000 per the gpt-5.6 rounding convention above) and max
    // output tokens 128,000. Function calling, vision, and file_search/PDF input confirmed
    // supported on the same page. reasoningEffort: 'openai-effort' confirmed — page lists
    // reasoning.effort levels medium/high/xhigh.
    'gpt-5.4-pro': {
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      streaming: true,
      tools: true,
      parallelTools: true,
      promptCache: null,
      structuredOutput: 'json-schema',
      responseIds: 'provider',
      streamStructured: true,
      mediaInput: { image: { base64: true, url: true }, document: { pdfBase64: true } },
      reasoningEffort: 'openai-effort',
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
      reasoningEffort: null,
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
      reasoningEffort: 'openai-effort',
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
      reasoningEffort: 'openai-effort',
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
      reasoningEffort: 'gemini-thinking-level',
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: 'gemini-thinking-level',
    },
    // Google's current GA flagship Flash model (released 2026-05-19).
    // contextWindow is 2^20 (1,048,576) per ai.google.dev/gemini-api/docs/models/gemini-3.5-flash.
    'gemini-3.5-flash': {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
      reasoningEffort: 'gemini-thinking-level',
    },
    // gemini-3.5-flash-lite (v6.4.0+): input token limit 1,048,576 and output token limit
    // 65,536 verified live against ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
    // (2026-08-08) — same shape as sibling gemini-3.5-flash, not gemini-3.1-flash-lite's
    // lower 8_192 output ceiling. Thinking and function calling both confirmed supported
    // on the same page.
    'gemini-3.5-flash-lite': {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
      reasoningEffort: 'gemini-thinking-level',
    },
    // gemini-3.6-flash (v6.4.0+): input token limit 1,048,576 and output token limit
    // 65,536 verified live against ai.google.dev/gemini-api/docs/models/gemini-3.6-flash
    // (2026-08-08) — same shape as sibling gemini-3.5-flash. Thinking and function calling
    // both confirmed supported on the same page.
    'gemini-3.6-flash': {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
      reasoningEffort: 'gemini-thinking-level',
    },
    // gemini-3.7-flash: input token limit 1,048,576 and output token limit 65,536 verified
    // live against ai.google.dev/gemini-api/docs/models/gemini-3.7-flash (2026-08-18) —
    // same shape as sibling gemini-3.6-flash. Thinking and function calling both confirmed
    // supported on the same page. Nuance: thinkingLevel: 'minimal' errors on this specific
    // model (unlike some 3.x siblings) — callers should use 'low' or higher.
    'gemini-3.7-flash': {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
      reasoningEffort: 'gemini-thinking-level',
    },
    // gemini-3-flash-preview: input token limit 1,048,576 and output token limit 65,536
    // verified live against ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview
    // (2026-08-18) — same shape as sibling gemini 3.x Flash models.
    'gemini-3-flash-preview': {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
      reasoningEffort: 'gemini-thinking-level',
    },
    // gemini-2.5-flash-lite: input token limit 1,048,576 and output token limit 65,536
    // verified live against ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite
    // (2026-08-18). reasoningEffort: null — this model DOES support Gemini thinking, but via
    // the older thinkingConfig.thinkingBudget dialect (2.5-series), not the thinkingLevel
    // dialect this field encodes (3.x-series). null means "not exposed via this field," not
    // "no thinking support" — matches the existing gemini-2.5-flash entry for the same
    // reason. Do not "fix" this to 'gemini-thinking-level': that dialect is rejected by
    // 2.5-series models.
    'gemini-2.5-flash-lite': {
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      streaming: true,
      tools: true,
      parallelTools: false,
      promptCache: null,
      structuredOutput: 'response-schema',
      responseIds: 'synthesized',
      streamStructured: false,
      mediaInput: { image: { base64: true, url: false }, document: { pdfBase64: true } },
      reasoningEffort: null,
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
  // parallelTools: true — DeepSeek V4 (deepseek-v4-flash/pro) supports parallel_tool_calls
  //   on Chat Completions.
  // deepseek-v4-pro promotional pricing note: 75% discount expires 2026-05-31.
  //
  // deepseek-chat / deepseek-reasoner retirement (2026-08-18): DeepSeek fully retired both
  // IDs on 2026-07-24 15:59 UTC with no fallback alias — calls now error at DeepSeek's API.
  // They are intentionally absent from this table (getModelCapabilities returns null for
  // them, consistent with "unknown model — degrade gracefully"). The client-side rejection
  // that stops a doomed request before it reaches DeepSeek lives in
  // providers/deepseek.ts (assertNotRetiredModel), not here — this table is inspection-only
  // and was never wired into call dispatch.
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
      reasoningEffort: null,
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
