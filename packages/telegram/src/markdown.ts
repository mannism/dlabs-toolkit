/**
 * MarkdownV2 escaping for Telegram.
 *
 * Telegram's MarkdownV2 spec requires escaping these 18 characters:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *   and also \
 *
 * A parse_mode mismatch is a silent failure — Telegram sends the message but
 * renders the raw unescaped text instead of formatted output. Always use this
 * helper when building MarkdownV2 strings dynamically.
 *
 * @see https://core.telegram.org/bots/api#markdownv2-style
 */

// All characters that must be escaped in MarkdownV2, including backslash itself.
// Backslash must be first — escaping it after others would double-escape.
const MARKDOWNV2_SPECIAL_CHARS = /[\\_*[\]()~`>#+\-=|{}.!]/g;

/**
 * Escape a string for use in a Telegram MarkdownV2 message.
 *
 * Escapes: \ _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * @example
 * escapeMarkdownV2('Hello, world!') // 'Hello, world\\!'
 * escapeMarkdownV2('Price: $1.99')  // 'Price: \\$1\\.99'  ($ not special, . is)
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(MARKDOWNV2_SPECIAL_CHARS, (char) => `\\${char}`);
}
