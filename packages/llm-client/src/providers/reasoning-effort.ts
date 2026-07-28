/**
 * Shared helpers for mapping LlmReasoningEffort to provider-specific request shapes (v6.3.0).
 *
 * Modelled directly on the assertBlocksSupported pattern in content-blocks.ts: a per-provider
 * support matrix (here, a per-provider Set of accepted values) plus a throw helper — apply a
 * cross-provider capability check once, call it from every provider call site.
 *
 * Responsibilities:
 *   - resolveReasoningEffort()            — Anthropic/OpenAI/Gemini: maps LlmReasoningEffort to
 *                                            the provider-native wire value, or throws bad_request
 *                                            before any SDK call if the value is outside that
 *                                            provider's accepted set.
 *   - assertReasoningEffortUnsupported()  — Perplexity/DeepSeek: throws bad_request whenever
 *                                            reasoningEffort is set at all (neither provider
 *                                            documents a comparable request parameter).
 *
 * Provider value sets (verified against installed SDK types, 2026-07-29):
 *   Anthropic — output_config.effort:      'low' | 'medium' | 'high' | 'xhigh' | 'max'
 *   OpenAI    — reasoning.effort:          'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
 *   Gemini    — thinkingConfig.thinkingLevel (uppercase): 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH'
 *
 * Never issue an SDK call if an unsupported effort value is detected — guard must throw first.
 */

import type { LlmReasoningEffort } from '../types.js';
import { LlmError } from '../types.js';

/** Anthropic output_config.effort accepted values — no 'none'/'minimal'. */
const ANTHROPIC_EFFORT_VALUES: ReadonlySet<LlmReasoningEffort> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** OpenAI reasoning.effort accepted values — the full 7-value LlmReasoningEffort range. */
const OPENAI_EFFORT_VALUES: ReadonlySet<LlmReasoningEffort> = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/** Gemini thinkingConfig.thinkingLevel accepted values — no 'none'/'xhigh'/'max'. */
const GEMINI_EFFORT_VALUES: ReadonlySet<LlmReasoningEffort> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
]);

/** Maps a validated LlmReasoningEffort to Gemini's uppercase ThinkingLevel wire value. */
function toGeminiThinkingLevel(effort: LlmReasoningEffort): string {
  return effort.toUpperCase();
}

/**
 * Resolves a caller-supplied LlmReasoningEffort to the provider-native wire value.
 *
 * Returns undefined when effort is unset (no-op — caller should not touch its params object).
 * Returns the provider-native string when set and supported:
 *   - Anthropic: the value unchanged (lowercase, matches Anthropic.OutputConfig['effort']).
 *   - OpenAI: the value unchanged (lowercase, matches OpenAI.Reasoning['effort']).
 *   - Gemini: the value uppercased (matches the ThinkingLevel enum, e.g. 'high' -> 'HIGH').
 *
 * Throws LlmError({ kind: 'bad_request', retryable: false }) naming the provider, the
 * rejected value, and that provider's supported set, when effort is set but outside the
 * resolved provider's accepted range. Must be called before any SDK invocation.
 */
export function resolveReasoningEffort(
  effort: LlmReasoningEffort | undefined,
  provider: 'anthropic' | 'openai' | 'gemini'
): string | undefined {
  if (effort === undefined) return undefined;

  if (provider === 'anthropic') {
    if (!ANTHROPIC_EFFORT_VALUES.has(effort)) {
      throwUnsupportedEffort(provider, effort, ANTHROPIC_EFFORT_VALUES);
    }
    return effort;
  }

  if (provider === 'openai') {
    if (!OPENAI_EFFORT_VALUES.has(effort)) {
      throwUnsupportedEffort(provider, effort, OPENAI_EFFORT_VALUES);
    }
    return effort;
  }

  // provider === 'gemini'
  if (!GEMINI_EFFORT_VALUES.has(effort)) {
    throwUnsupportedEffort(provider, effort, GEMINI_EFFORT_VALUES);
  }
  return toGeminiThinkingLevel(effort);
}

/**
 * Throws LlmError({ kind: 'bad_request', retryable: false }) if options.reasoningEffort is
 * set at all — for Perplexity and DeepSeek, which do not document a comparable request
 * parameter. Must be called at the top of every public method, before any message-building
 * work, regardless of whether that method reaches an SDK call.
 */
export function assertReasoningEffortUnsupported(
  options: { reasoningEffort?: LlmReasoningEffort } | undefined,
  provider: 'perplexity' | 'deepseek'
): void {
  if (options?.reasoningEffort === undefined) return;
  throw new LlmError({
    message:
      `[llm-client] Provider '${provider}' does not support reasoningEffort` +
      ` ('${options.reasoningEffort}' was set). Neither Perplexity nor DeepSeek document a` +
      ' comparable request parameter.',
    provider,
    kind: 'bad_request',
    retryable: false,
  });
}

function throwUnsupportedEffort(
  provider: string,
  effort: LlmReasoningEffort,
  supported: ReadonlySet<LlmReasoningEffort>
): never {
  throw new LlmError({
    message:
      `[llm-client] Provider '${provider}' does not support reasoningEffort '${effort}'.` +
      ` Supported values for '${provider}': ${[...supported].join(', ')}.`,
    provider,
    kind: 'bad_request',
    retryable: false,
  });
}
