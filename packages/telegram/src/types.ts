/**
 * Type definitions for @diabolicallabs/telegram.
 *
 * Uses native fetch — no SDK dep (no grammY, no telegraf, no node-telegram-bot-api).
 * Local types cover the surface needed for v1.0.0.
 */

import type { Logger, Notifier, NotifyResult } from '@diabolicallabs/notifier-core';
import {
  PlatformAuthError,
  PlatformError,
  PlatformNotFoundError,
  PlatformRateLimitError,
  PlatformUnavailableError,
  PlatformValidationError,
} from '@diabolicallabs/notifier-core';

// ─────────────────────────────────────────────
// Local Telegram types (no SDK)
// ─────────────────────────────────────────────

/**
 * Inline keyboard button. Text is always required.
 * Only url and callback_data are included in v1.0.0 — other variants
 * (web_app, login_url, etc.) are additive minor bumps.
 */
export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

/**
 * Telegram InlineKeyboardMarkup — 2D array of buttons.
 */
export interface InlineKeyboardMarkup {
  inline_keyboard: ReadonlyArray<ReadonlyArray<InlineKeyboardButton>>;
}

// ─────────────────────────────────────────────
// Config / args
// ─────────────────────────────────────────────

/**
 * Configuration for createTelegramNotifier().
 */
export interface TelegramNotifierConfig {
  botToken: string; // from @BotFather — never log this
  defaultChatId?: string | number; // optional default for sendMessage
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 500
  capDelayMs?: number; // default: 2000
  timeoutMs?: number; // default: 10_000
  logger?: Logger; // from @diabolicallabs/notifier-core
  apiBase?: string; // default: 'https://api.telegram.org' — override for testing
}

/**
 * Arguments for sendMessage.
 *
 * chatId can be:
 *   - A numeric user/group/channel ID (number)
 *   - A username for public channels (string, e.g. '@mychannel')
 */
export interface SendMessageArgs {
  chatId: string | number;
  text: string;
  parseMode?: 'MarkdownV2' | 'HTML'; // omit for plain text
  replyMarkup?: InlineKeyboardMarkup;
  disableWebPagePreview?: boolean;
  replyToMessageId?: number;
}

// ─────────────────────────────────────────────
// TelegramNotifier interface
// ─────────────────────────────────────────────

/**
 * The Telegram notifier interface. Extends the portable Notifier interface.
 * `send()` routes to `sendMessage`.
 */
export interface TelegramNotifier extends Notifier {
  sendMessage(args: SendMessageArgs): Promise<NotifyResult>;
}

// ─────────────────────────────────────────────
// Error taxonomy
// ─────────────────────────────────────────────

/**
 * Base Telegram error — generic fallback.
 */
export class TelegramError extends PlatformError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'telegram', code, cause);
  }
}

/**
 * 401 Unauthorized — invalid bot token.
 * Non-retryable.
 */
export class TelegramAuthError extends PlatformAuthError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'telegram', code, cause);
  }
}

/**
 * Chat not found or bot blocked by user.
 * Non-retryable.
 *
 * Telegram surfaces both cases as 400/403:
 *   - 400 Bad Request: chat not found
 *   - 403 Forbidden: bot was blocked by the user
 *
 * See §6.6 of brief-week6.md for cold-DM constraint documentation.
 */
export class TelegramChatNotFoundError extends PlatformNotFoundError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'telegram', code, cause);
  }
}

/**
 * Rate limit error — 429 after retries exhausted.
 *
 * IMPORTANT: Telegram's retry-after value comes from the response BODY field
 * `parameters.retry_after` (in seconds), NOT from a header. This is a known
 * Telegram-specific behavior documented in Tom research §Telegram.
 */
export class TelegramRateLimitError extends PlatformRateLimitError {
  constructor(
    message: string,
    code: string,
    kind: 'exceeded' | 'unavailable',
    retryAfterMs: number | null,
    cause?: unknown
  ) {
    super(message, 'telegram', code, kind, retryAfterMs, cause);
  }
}

/**
 * Validation error — 400 Bad Request family (bad chat_id, malformed parse_mode,
 * MarkdownV2 escape error). Also thrown synchronously by createTelegramNotifierFromEnv
 * when TELEGRAM_BOT_TOKEN is absent.
 */
export class TelegramValidationError extends PlatformValidationError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'telegram', code, cause);
  }
}

/**
 * Telegram API unavailable — 5xx after retries exhausted.
 */
export class TelegramUnavailableError extends PlatformUnavailableError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'telegram', code, cause);
  }
}
