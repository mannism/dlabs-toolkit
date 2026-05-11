/**
 * Shared JSON extraction utilities for structured() prompt-fallback paths.
 *
 * All four providers (Anthropic, OpenAI, Gemini, Perplexity) hit a prompt-only
 * code path when native strict modes are unavailable or opted out of via
 * structuredMode:'prompt'. Models on those paths frequently return valid JSON
 * wrapped in markdown fences and/or surrounded by prose — a naïve fence-strip +
 * JSON.parse fails on:
 *
 *   1. Content after the closing fence (e.g. Perplexity appends citation notes)
 *   2. No closing fence (model truncated or forgot)
 *   3. Prose preamble before the fence that the leading-fence regex misses
 *
 * extractJsonBlock() solves this with a single-pass character scanner that
 * finds the first balanced JSON object or array regardless of surrounding text.
 *
 * parseJsonOrThrow() wraps the extractor + fallback strip/parse + error shaping
 * into a single helper consumed by all four provider sites.
 */

import { LlmError } from './types.js';

/**
 * Strip <think>...</think> reasoning blocks and extract the first balanced
 * JSON object (`{...}`) or array (`[...]`) from model-generated text.
 *
 * The scanner respects string boundaries — a `{` or `[` inside a double-quoted
 * string does NOT increment the depth counter, so inputs like:
 *   `{ "key": "value with } brace inside" }`
 * are handled correctly.
 *
 * Returns null when no balanced block is found (pure prose, unclosed brace, etc.).
 * In that case callers fall back to the legacy strip+parse path.
 *
 * <think> stripping is applied unconditionally — the tags are harmless on
 * providers that don't emit them, and lifting it here avoids duplicating the
 * regex across four provider files.
 */
export function extractJsonBlock(text: string): string | null {
  // Strip reasoning blocks emitted by sonar-reasoning-pro and similar models.
  // The /gi flags handle case variants and multiple think blocks in one response.
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    // Skip non-opening characters quickly — tight inner loop performance.
    if (ch !== '{' && ch !== '[') continue;

    const open = ch as '{' | '[';
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let isEscaped = false;

    for (let j = i; j < stripped.length; j++) {
      const c = stripped[j];

      // Escape-sequence state: the character after a backslash is always literal —
      // it cannot open/close a string or change depth.
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (inString) {
        if (c === '\\') {
          // Next character is escaped — set flag and continue.
          isEscaped = true;
          continue;
        }
        if (c === '"') {
          // Unescaped quote closes the string context.
          inString = false;
        }
        // All other characters inside a string are skipped (no depth tracking).
        continue;
      }

      // Outside a string context:
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) {
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0) {
          // Found the closing delimiter of the outermost block starting at i.
          return stripped.slice(i, j + 1);
        }
      }
    }
    // Reached end of string without closing the block that opened at i.
    // Try the next opening character — handles cases where an early `{` in
    // prose is followed by a complete JSON block later in the response.
  }

  return null;
}

/**
 * Build a diagnostic raw-content slice for error messages.
 *
 * For short inputs (≤500 chars), the full content is included.
 * For long inputs, the first 300 chars and last 200 chars are joined with
 * a `...` separator so the error message captures both the opening structure
 * and the trailing content (where fences/prose often appear).
 *
 * The header also includes the total length so log readers can gauge how much
 * content was truncated.
 */
function buildRawSlice(raw: string): string {
  const total = raw.length;
  if (total <= 500) return raw;
  const head = raw.slice(0, 300);
  const tail = raw.slice(total - 200);
  return `(${total} chars) ${head}...${tail}`;
}

/**
 * Parse a model's raw text response into a structured value.
 *
 * Strategy (in order):
 *   1. Run extractJsonBlock — finds the first balanced JSON block regardless of
 *      fences, surrounding prose, or missing closing fence.
 *   2. If extraction returns null, fall back to the legacy fence-strip + trim
 *      approach so any inputs that worked before continue to work.
 *   3. Run JSON.parse on the extracted/cleaned string.
 *   4. On parse failure, throw a non-retryable LlmError with the provider name
 *      and a ≥500-char raw content slice for diagnostic purposes.
 *
 * @param rawContent - The raw string content from the model response.
 * @param provider   - Provider name for the LlmError.provider field.
 * @returns Parsed unknown value — callers run schema.parse() on the result.
 * @throws LlmError (retryable: false) when no valid JSON can be extracted.
 */
export function parseJsonOrThrow(rawContent: string, provider: string): unknown {
  const extracted = extractJsonBlock(rawContent);

  let candidate: string;
  if (extracted !== null) {
    candidate = extracted;
  } else {
    // Legacy fence-strip fallback — preserves behavior for any edge case where
    // the extractor returns null but the old regex approach would have worked.
    // <think> stripping is already inside extractJsonBlock; repeat it here for
    // the fallback path since extractJsonBlock strips before scanning but doesn't
    // return the stripped string when it finds nothing.
    candidate = rawContent
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/m, '')
      .trim();
  }

  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new LlmError({
      message: `${provider} structured output: response is not valid JSON. Raw: ${buildRawSlice(rawContent)}`,
      provider,
      retryable: false,
      cause: err,
    });
  }
}
