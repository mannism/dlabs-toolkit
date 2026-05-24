/**
 * @diabolicallabs/telegram
 *
 * Send-only Telegram notifier using native fetch against api.telegram.org.
 * No SDK dependency (no grammY, no telegraf, no node-telegram-bot-api).
 *
 * Features:
 *   - sendMessage via POST to /bot{token}/sendMessage
 *   - Named error taxonomy (TelegramAuthError, TelegramChatNotFoundError, etc.)
 *   - Retry-after from response BODY field `parameters.retry_after` (NOT a header)
 *   - Retry with full-jitter exponential backoff (via retryWithJitter from notifier-core)
 *   - MarkdownV2 escape helper (escapeMarkdownV2)
 *   - InlineKeyboardMarkup type for rich content
 *   - Secrets safety: bot token never logged (URL redacted in all log lines)
 *   - Pluggable logger (setTelegramLogger)
 *
 * @example
 * import { createTelegramNotifierFromEnv, escapeMarkdownV2 } from '@diabolicallabs/telegram';
 * const tg = createTelegramNotifierFromEnv();
 * await tg.sendMessage({
 *   chatId: process.env.MY_CHAT_ID,
 *   text: escapeMarkdownV2('Deploy *complete* — 1.2.3'),
 *   parseMode: 'MarkdownV2',
 * });
 */

// Factory functions
export { createTelegramNotifier, createTelegramNotifierFromEnv } from './client.js';

// Logger
export { setTelegramLogger } from './logger.js';

// MarkdownV2 helper
export { escapeMarkdownV2 } from './markdown.js';

// Types
export type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  SendMessageArgs,
  TelegramNotifier,
  TelegramNotifierConfig,
} from './types.js';

// Error classes — exported as values for instanceof checks
export {
  TelegramAuthError,
  TelegramChatNotFoundError,
  TelegramError,
  TelegramRateLimitError,
  TelegramUnavailableError,
  TelegramValidationError,
} from './types.js';
