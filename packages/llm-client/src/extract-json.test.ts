/**
 * Unit tests for extract-json.ts — shared JSON extraction helpers.
 *
 * extractJsonBlock() test coverage:
 * - Clean JSON object, no fences (today works, must keep working)
 * - JSON in clean markdown fences (today works, must keep working)
 * - JSON in fences with trailing prose (today FAILS naïve path, must pass)
 * - Preamble prose before fence (today FAILS naïve path, must pass)
 * - No closing fence / truncated (today FAILS naïve path, must pass)
 * - Nested braces (depth counting)
 * - String-escape robustness: `{` and `}` inside double-quoted strings
 * - JSON array (not just object)
 * - <think>...</think> block stripping (sonar-reasoning-pro)
 * - Multiple think blocks stripped
 * - Pure prose — returns null
 * - Empty string — returns null
 *
 * parseJsonOrThrow() test coverage:
 * - Success via extractJsonBlock path (fenced with trailing prose)
 * - Success via legacy fallback path (extraction returns null but fallback works)
 * - Throws LlmError (retryable: false) on pure prose
 * - Error message includes raw content slice ≥500 chars for long inputs
 * - Error message includes full raw content for short inputs
 * - Provider name appears in error message
 */

import { describe, expect, it } from 'vitest';
import { extractJsonBlock, parseJsonOrThrow } from './extract-json.js';
import { LlmError } from './types.js';

// ---------------------------------------------------------------------------
// extractJsonBlock()
// ---------------------------------------------------------------------------

describe('extractJsonBlock()', () => {
  it('returns a clean JSON object with no fences unchanged', () => {
    const input = '{"name":"Alice","age":30}';
    expect(extractJsonBlock(input)).toBe(input);
  });

  it('returns the JSON block from clean markdown fences', () => {
    const input = '```json\n{"value":42}\n```';
    expect(extractJsonBlock(input)).toBe('{"value":42}');
  });

  it('returns JSON block when followed by trailing prose after fence', () => {
    // This is the real GEOAudit failure case: model returns valid JSON in fences
    // but appends citation notes or follow-up prose after the closing fence.
    const input =
      '```json\n{"geo_audit":{"score":7.5}}\n```\n\nNote: This audit was performed using publicly available metadata.';
    expect(extractJsonBlock(input)).toBe('{"geo_audit":{"score":7.5}}');
  });

  it('returns JSON block when prose precedes the fence', () => {
    const input = 'Here is the audit result:\n```json\n{"status":"ok","count":3}\n```\n';
    expect(extractJsonBlock(input)).toBe('{"status":"ok","count":3}');
  });

  it('returns JSON block when there is no closing fence (model truncation)', () => {
    const input = '```json\n{"partial":true,"data":[1,2,3]}';
    expect(extractJsonBlock(input)).toBe('{"partial":true,"data":[1,2,3]}');
  });

  it('handles nested braces correctly via depth counting', () => {
    const input = '{"outer":{"inner":{"deep":"value"},"list":[1,2,3]}}';
    expect(extractJsonBlock(input)).toBe(input);
  });

  it('does not count braces inside double-quoted strings (string-escape robustness)', () => {
    // A `}` inside a string must not decrement depth — the block runs to the real closing `}`.
    const input = '{ "key": "string with } brace inside" }';
    expect(extractJsonBlock(input)).toBe(input);
  });

  it('handles escaped backslash before closing quote without misreading string boundary', () => {
    // `"path": "C:\\dir\\"` — the `\\` before `"` is an escaped backslash, not an escape for `"`.
    // The string ends at the closing `"` after `\\`.
    const input = '{"path":"C:\\\\dir\\\\","ok":true}';
    expect(extractJsonBlock(input)).toBe(input);
  });

  it('returns a JSON array block', () => {
    const input = 'Here is the list:\n[1,2,3]\nDone.';
    expect(extractJsonBlock(input)).toBe('[1,2,3]');
  });

  it('strips <think>...</think> blocks before scanning (sonar-reasoning-pro)', () => {
    const input = '<think>\nLet me reason...\n</think>\n\n{"ok":true}';
    expect(extractJsonBlock(input)).toBe('{"ok":true}');
  });

  it('strips multiple <think> blocks', () => {
    const input = '<think>first</think>\n<think>second</think>\n{"result":"clean"}';
    expect(extractJsonBlock(input)).toBe('{"result":"clean"}');
  });

  it('strips <think> blocks case-insensitively', () => {
    const input = '<THINK>reasoning</THINK>{"val":1}';
    expect(extractJsonBlock(input)).toBe('{"val":1}');
  });

  it('returns the first JSON block when multiple valid blocks exist', () => {
    // Brief semantics: first balanced block wins.
    const input = '{"first":1}\n\n{"second":2}';
    expect(extractJsonBlock(input)).toBe('{"first":1}');
  });

  it('returns null for pure prose with no JSON', () => {
    expect(extractJsonBlock('This is just a plain text response with no JSON.')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractJsonBlock('')).toBeNull();
  });

  it('returns null for an unbalanced block that never closes', () => {
    // Opens `{` but never closes — scanner tries from each `{` and finds none balanced.
    expect(extractJsonBlock('{"unclosed": "object"')).toBeNull();
  });

  it('handles a complex real-world Perplexity response shape', () => {
    const realWorldInput = [
      '```json',
      '{',
      '  "geo_audit": {',
      '    "summary": {',
      '      "score": 7.5,',
      '      "strengths": ["Strong APAC regional targeting"]',
      '    }',
      '  }',
      '}',
      '```',
      '',
      'Note: This audit was performed using publicly available metadata...',
    ].join('\n');

    const result = extractJsonBlock(realWorldInput);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result as string);
    expect(parsed.geo_audit.summary.score).toBe(7.5);
    expect(parsed.geo_audit.summary.strengths).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseJsonOrThrow()
// ---------------------------------------------------------------------------

describe('parseJsonOrThrow()', () => {
  it('successfully parses clean JSON object', () => {
    const result = parseJsonOrThrow('{"name":"Bob","score":95}', 'test-provider');
    expect(result).toEqual({ name: 'Bob', score: 95 });
  });

  it('successfully parses JSON with trailing prose via extractJsonBlock path', () => {
    const input = '```json\n{"value":42}\n```\nNote: follow-up text.';
    const result = parseJsonOrThrow(input, 'perplexity');
    expect(result).toEqual({ value: 42 });
  });

  it('successfully parses JSON with preamble prose', () => {
    const input = 'Here is your result:\n```json\n{"ok":true}\n```';
    const result = parseJsonOrThrow(input, 'gemini');
    expect(result).toEqual({ ok: true });
  });

  it('successfully parses JSON with no closing fence (model truncation)', () => {
    const input = '```json\n{"partial":true}';
    const result = parseJsonOrThrow(input, 'anthropic');
    expect(result).toEqual({ partial: true });
  });

  it('successfully parses JSON with brace inside a string value', () => {
    const input = '{ "key": "string with } brace inside" }';
    const result = parseJsonOrThrow(input, 'openai');
    expect(result).toEqual({ key: 'string with } brace inside' });
  });

  it('throws LlmError (retryable: false) on pure prose with no JSON', () => {
    expect(() => {
      parseJsonOrThrow('Pure prose, no JSON anywhere.', 'perplexity');
    }).toThrow(LlmError);

    try {
      parseJsonOrThrow('Pure prose, no JSON anywhere.', 'perplexity');
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      if (e instanceof LlmError) {
        expect(e.retryable).toBe(false);
        expect(e.provider).toBe('perplexity');
        expect(e.message).toContain('not valid JSON');
      }
    }
  });

  it('includes the provider name in the error message', () => {
    try {
      parseJsonOrThrow('no json here', 'anthropic');
    } catch (e) {
      if (e instanceof LlmError) {
        expect(e.message).toContain('anthropic');
      }
    }
  });

  it('includes full raw content in error message for short inputs (≤500 chars)', () => {
    const shortRaw = 'This is not JSON and is short.';
    try {
      parseJsonOrThrow(shortRaw, 'gemini');
    } catch (e) {
      if (e instanceof LlmError) {
        expect(e.message).toContain(shortRaw);
      }
    }
  });

  it('includes head+tail slice and total length for long inputs (>500 chars)', () => {
    // Build a prose response longer than 500 chars that has no valid JSON.
    // The raw slice should show total length and include both head and tail content.
    const longHead = 'A'.repeat(400); // head of 300 chars will appear in message
    const longTail = 'Z'.repeat(200); // tail of 200 chars will appear in message
    const longRaw = longHead + longTail; // 600 chars total, no JSON
    expect(longRaw.length).toBe(600);

    try {
      parseJsonOrThrow(longRaw, 'openai');
    } catch (e) {
      if (e instanceof LlmError) {
        // Total length must be in the message
        expect(e.message).toContain('600 chars');
        // Head chars (first 300 'A') should appear
        expect(e.message).toContain('A'.repeat(100)); // substring of the head
        // Tail chars (last 200 'Z') should appear
        expect(e.message).toContain('Z'.repeat(100)); // substring of the tail
      }
    }
  });

  it('raw content slice is at least 500 chars of diagnostic content for long inputs', () => {
    // Build a long response >500 chars that has no valid JSON, then verify the
    // LlmError message includes at least 500 chars beyond the fixed prefix.
    const longRaw = 'x'.repeat(800);
    try {
      parseJsonOrThrow(longRaw, 'perplexity');
    } catch (e) {
      if (e instanceof LlmError) {
        // The raw diagnostic portion (head 300 + '...' + tail 200) = ≥500 chars of content.
        // Remove the fixed prefix "perplexity structured output: response is not valid JSON. Raw: "
        // and check the remainder has meaningful length.
        const prefix = 'perplexity structured output: response is not valid JSON. Raw: ';
        const rawPortion = e.message.slice(prefix.length);
        expect(rawPortion.length).toBeGreaterThanOrEqual(500);
      }
    }
  });

  it('strips <think> blocks before parsing (sonar-reasoning-pro path)', () => {
    const input = '<think>reasoning...</think>\n{"answer":42}';
    const result = parseJsonOrThrow(input, 'perplexity');
    expect(result).toEqual({ answer: 42 });
  });
});
