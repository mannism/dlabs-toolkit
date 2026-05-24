/**
 * Unit tests for escapeMarkdownV2.
 *
 * Covers all 18 escapable characters from Telegram's MarkdownV2 spec:
 *   \ _ * [ ] ( ) ~ ` > # + - = | { } . !
 */

import { describe, expect, it } from 'vitest';
import { escapeMarkdownV2 } from './markdown.js';

// All special characters, in the order documented in the Telegram API spec.
// Backslash is first (must be escaped before others to avoid double-escaping).
const SPECIAL_CHARS = [
  '\\',
  '_',
  '*',
  '[',
  ']',
  '(',
  ')',
  '~',
  '`',
  '>',
  '#',
  '+',
  '-',
  '=',
  '|',
  '{',
  '}',
  '.',
  '!',
] as const;

describe('escapeMarkdownV2', () => {
  it('returns plain text unchanged when no special chars', () => {
    expect(escapeMarkdownV2('Hello World')).toBe('Hello World');
  });

  it('returns an empty string unchanged', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });

  // Test each of the 18 special characters individually
  for (const char of SPECIAL_CHARS) {
    it(`escapes '${char === '\\' ? '\\\\' : char}' correctly`, () => {
      const input = `before${char}after`;
      const result = escapeMarkdownV2(input);
      // The escaped character must have a backslash prepended
      expect(result).toBe(`before\\${char}after`);
    });
  }

  it('round-trip: all 18 special chars escaped in a single string', () => {
    const allSpecial = SPECIAL_CHARS.join('');
    const escaped = escapeMarkdownV2(allSpecial);
    // Each char should be preceded by a backslash
    for (const char of SPECIAL_CHARS) {
      // Escaped form: \\ before the char (raw: backslash + char)
      expect(escaped).toContain(`\\${char}`);
    }
    // The result should be longer than input (each char got a backslash)
    expect(escaped.length).toBe(allSpecial.length * 2);
  });

  it('does not double-escape backslashes', () => {
    // Input: two backslashes. Output: each gets escaped once → four chars
    expect(escapeMarkdownV2('\\\\')).toBe('\\\\\\\\');
  });

  it('escapes only special chars and leaves others alone', () => {
    expect(escapeMarkdownV2('Price: $1.99')).toBe('Price: $1\\.99');
  });

  it('practical example: deploy notification', () => {
    const input = 'Deploy v1.0.0 complete! (GEOAudit)';
    const result = escapeMarkdownV2(input);
    // . ! ( ) are special
    expect(result).toBe('Deploy v1\\.0\\.0 complete\\! \\(GEOAudit\\)');
  });

  it('practical example: channel mention does not break escaping', () => {
    const input = '#alerts @fleet';
    const result = escapeMarkdownV2(input);
    expect(result).toBe('\\#alerts @fleet');
  });

  it('escapes markdown formatting chars: * _ ~ `', () => {
    expect(escapeMarkdownV2('*bold* _italic_ ~strikethrough~ `code`')).toBe(
      '\\*bold\\* \\_italic\\_ \\~strikethrough\\~ \\`code\\`'
    );
  });
});
