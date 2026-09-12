/**
 * Shared helpers for mapping LlmMediaResolution to Gemini-native request shapes (v6.7.0).
 *
 * Modelled directly on the resolveReasoningEffort()/assertReasoningEffortUnsupported()
 * pattern in reasoning-effort.ts: pure functions, no SDK mocking needed in tests, called
 * from the Gemini provider before any SDK invocation.
 *
 * Responsibilities:
 *   - resolveMediaResolution()   — request-level: config/call-level LlmMediaResolution ->
 *                                  GenerateContentConfig.mediaResolution (MediaResolution enum),
 *                                  or throws bad_request pre-flight for 'ultra_high' (no
 *                                  request-level ULTRA_HIGH member exists on the SDK enum).
 *   - toPartMediaResolution()    — per-part: LlmMediaResolution -> Part.mediaResolution
 *                                  (PartMediaResolution, full four-level enum).
 *
 * Gemini-only. Every other provider ignores LlmClientConfig.mediaResolution /
 * LlmCallOptions.mediaResolution / LlmContentBlock.mediaResolution entirely — this module
 * is never imported from openai.ts, anthropic.ts, deepseek.ts, or perplexity.ts.
 *
 * Enum member names verified against the installed @google/genai@2.17.0 d.ts (2026-09-05):
 *   MediaResolution: MEDIA_RESOLUTION_UNSPECIFIED | _LOW | _MEDIUM | _HIGH (no _ULTRA_HIGH).
 *   PartMediaResolutionLevel: MEDIA_RESOLUTION_UNSPECIFIED | _LOW | _MEDIUM | _HIGH | _ULTRA_HIGH.
 *
 * Never issue an SDK call if 'ultra_high' is set at request level — the guard must throw first.
 */

import { MediaResolution, type PartMediaResolution, PartMediaResolutionLevel } from '@google/genai';
import type { LlmMediaResolution } from '../types.js';
import { LlmError } from '../types.js';

/** Request-level accepted values — 'ultra_high' has no MediaResolution enum member. */
export const REQUEST_MEDIA_RESOLUTION_VALUES = ['low', 'medium', 'high'] as const;

/** Maps a request-level-valid LlmMediaResolution to the Gemini MediaResolution enum. */
const REQUEST_LEVEL_MAP: Record<(typeof REQUEST_MEDIA_RESOLUTION_VALUES)[number], MediaResolution> =
  {
    low: MediaResolution.MEDIA_RESOLUTION_LOW,
    medium: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
    high: MediaResolution.MEDIA_RESOLUTION_HIGH,
  };

/** Maps every LlmMediaResolution level (including 'ultra_high') to the per-part enum. */
const PART_LEVEL_MAP: Record<LlmMediaResolution, PartMediaResolutionLevel> = {
  low: PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW,
  medium: PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM,
  high: PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH,
  ultra_high: PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH,
};

/**
 * Resolves the request-level (GenerateContentConfig.mediaResolution) value from a
 * config-level and call-level LlmMediaResolution. Call-level wins over config-level.
 *
 * Returns undefined when neither is set (no-op — caller should not touch geminiConfig).
 * Returns the Gemini-native MediaResolution enum value when set and supported.
 *
 * Throws LlmError({ kind: 'bad_request', retryable: false, provider: 'gemini' }) when the
 * resolved level is 'ultra_high' — there is no request-level ULTRA_HIGH member; the message
 * names the per-block alternative. Must be called before any SDK invocation.
 */
export function resolveMediaResolution(
  configLevel: LlmMediaResolution | undefined,
  callLevel: LlmMediaResolution | undefined
): MediaResolution | undefined {
  const level = callLevel ?? configLevel;
  if (level === undefined) return undefined;

  if (level === 'ultra_high') {
    throw new LlmError({
      message:
        "[llm-client] 'ultra_high' is not valid for request-level mediaResolution on Gemini" +
        " — there is no request-level ULTRA_HIGH member. Set mediaResolution: 'ultra_high'" +
        ' on an individual image content block instead (per-part mediaResolution supports' +
        ' all four levels).',
      provider: 'gemini',
      kind: 'bad_request',
      retryable: false,
    });
  }

  return REQUEST_LEVEL_MAP[level];
}

/**
 * Maps a per-block LlmMediaResolution to Gemini's Part.mediaResolution shape.
 * Accepts all four levels, including 'ultra_high' — the image-only restriction on
 * 'ultra_high' is enforced by the caller (mapGeminiParts() rejects it on `document` blocks
 * before this function is invoked), not by this pure mapping function.
 */
export function toPartMediaResolution(level: LlmMediaResolution): PartMediaResolution {
  return { level: PART_LEVEL_MAP[level] };
}
