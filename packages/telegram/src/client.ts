/**
 * Factory functions for TelegramNotifier.
 *
 * createTelegramNotifier(config) — builds from explicit config.
 * createTelegramNotifierFromEnv(overrides?) — reads TELEGRAM_BOT_TOKEN,
 *   TELEGRAM_DEFAULT_CHAT_ID; throws TelegramValidationError synchronously
 *   when the token is absent.
 *
 * Implementation uses native fetch against https://api.telegram.org/bot{token}/sendMessage.
 * No SDK dependency (no grammY, no telegraf, no node-telegram-bot-api).
 * Matches the pattern in labs/src/lib/twin/telegram.ts.
 *
 * CRITICAL implementation note (§6.4, §8.9 of brief-week6.md):
 *   Telegram's retry-after value comes from the response BODY field
 *   `parameters.retry_after` (in seconds), NOT from a Retry-After header.
 *   This package reads the body value correctly.
 *
 * Secrets handling (§6.7 of brief-week6.md):
 *   - botToken is in the URL path — never log full URLs. Log redacted form:
 *     'https://api.telegram.org/bot[REDACTED]/sendMessage'
 *   - Error constructors must not include config.botToken in their message.
 *   - Never log message bodies below DEBUG level (may contain PII or user content).
 */

import type { NotifyResult } from '@diabolicallabs/notifier-core';
import { retryWithJitter } from '@diabolicallabs/notifier-core';
import { getLogger } from './logger.js';
import type { SendMessageArgs, TelegramNotifier, TelegramNotifierConfig } from './types.js';
import {
  TelegramAuthError,
  TelegramChatNotFoundError,
  TelegramError,
  TelegramRateLimitError,
  TelegramUnavailableError,
  TelegramValidationError,
} from './types.js';

// ─────────────────────────────────────────────
// Telegram API response shapes (minimal)
// ─────────────────────────────────────────────

interface TelegramApiSuccess {
  ok: true;
  result: {
    message_id: number;
    date: number;
    chat: { id: number | string };
  };
}

interface TelegramApiError {
  ok: false;
  error_code: number;
  description: string;
  parameters?: {
    retry_after?: number; // seconds — BODY field, not a header
    migrate_to_chat_id?: number;
  };
}

type TelegramApiResponse = TelegramApiSuccess | TelegramApiError;

// ─────────────────────────────────────────────
// Error-mapping helpers
// ─────────────────────────────────────────────

/**
 * Descriptions that indicate a chat-not-found or blocked condition.
 */
const CHAT_NOT_FOUND_PATTERNS = [
  'chat not found',
  'bot was blocked by the user',
  'user is deactivated',
  'bot was kicked from',
  'chat_write_forbidden',
  'need administrator rights',
];

/**
 * Map a Telegram API error response to the named error taxonomy.
 * Never includes the bot token in the resulting error message.
 */
function mapTelegramError(apiError: TelegramApiError, cause?: unknown): TelegramError {
  const code = String(apiError.error_code);
  const description = apiError.description ?? 'Unknown Telegram API error';

  // 401 — Unauthorized (invalid or revoked bot token)
  if (apiError.error_code === 401) {
    return new TelegramAuthError(`Telegram authentication failed: ${description}`, code, cause);
  }

  // 429 — Rate limited; retry_after is in the body field parameters.retry_after
  if (apiError.error_code === 429) {
    const retryAfterSec = apiError.parameters?.retry_after;
    const retryAfterMs = typeof retryAfterSec === 'number' ? retryAfterSec * 1_000 : null;
    return new TelegramRateLimitError(
      `Telegram rate limit exceeded: ${description}`,
      code,
      'exceeded',
      retryAfterMs,
      cause
    );
  }

  // 400/403 — Chat not found or bot blocked
  if (apiError.error_code === 400 || apiError.error_code === 403) {
    const descLower = description.toLowerCase();
    const isChatNotFound = CHAT_NOT_FOUND_PATTERNS.some((p) => descLower.includes(p));
    if (isChatNotFound) {
      return new TelegramChatNotFoundError(
        `Telegram chat not found or bot blocked: ${description}`,
        code,
        cause
      );
    }
    // Other 400s are validation errors (bad parse_mode, malformed payload, etc.)
    return new TelegramValidationError(`Telegram validation error: ${description}`, code, cause);
  }

  // 5xx — Service unavailable
  if (apiError.error_code >= 500) {
    return new TelegramUnavailableError(
      `Telegram service unavailable: ${description}`,
      code,
      cause
    );
  }

  // Fallback
  return new TelegramError(`Telegram API error [${code}]: ${description}`, code, cause);
}

/**
 * Determine whether an error is retryable.
 * Auth, validation, chat-not-found, and rate-limit errors are not retried
 * (retrying wouldn't help, or the retry delay should be external).
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof TelegramAuthError) return false;
  if (err instanceof TelegramChatNotFoundError) return false;
  if (err instanceof TelegramValidationError) return false;
  if (err instanceof TelegramRateLimitError) return false;
  return true;
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

/**
 * Create a TelegramNotifier with explicit config.
 *
 * @param config - TelegramNotifierConfig; botToken is never logged.
 */
export function createTelegramNotifier(config: TelegramNotifierConfig): TelegramNotifier {
  const {
    botToken,
    defaultChatId,
    maxRetries = 3,
    baseDelayMs = 500,
    capDelayMs = 2_000,
    timeoutMs = 10_000,
    logger: configLogger,
    apiBase = 'https://api.telegram.org',
  } = config;

  if (botToken === undefined || botToken === '') {
    throw new TelegramValidationError(
      'TelegramNotifier requires a botToken. Pass config.botToken or set TELEGRAM_BOT_TOKEN.',
      'missing_bot_token'
    );
  }

  const log = configLogger ?? getLogger();

  // Build the API URL with the token in the path — never log this URL directly.
  const apiUrl = `${apiBase}/bot${botToken}/sendMessage`;
  // Redacted form for logging — token is never in any log line.
  const redactedUrl = `${apiBase}/bot[REDACTED]/sendMessage`;

  // ─── sendMessage ───────────────────────────────────

  async function sendMessage(args: SendMessageArgs): Promise<NotifyResult> {
    return retryWithJitter(
      async () => {
        // Build the request body
        const body: Record<string, unknown> = {
          chat_id: args.chatId,
          text: args.text,
        };
        if (args.parseMode !== undefined) body['parse_mode'] = args.parseMode;
        if (args.replyMarkup !== undefined) body['reply_markup'] = args.replyMarkup;
        if (args.disableWebPagePreview === true) body['disable_web_page_preview'] = true;
        if (args.replyToMessageId !== undefined)
          body['reply_to_message_id'] = args.replyToMessageId;

        let response: Response;
        try {
          response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new TelegramError(`Telegram fetch failed: ${message}`, 'network_error', err);
        }

        let parsed: TelegramApiResponse;
        try {
          parsed = (await response.json()) as TelegramApiResponse;
        } catch (err) {
          throw new TelegramError(
            `Telegram API returned non-JSON response (status ${response.status})`,
            'parse_error',
            err
          );
        }

        if (!parsed.ok) {
          throw mapTelegramError(parsed, parsed);
        }

        const messageId = String(parsed.result.message_id);
        log.warn('TELEGRAM_SEND_OK', {
          chatId: String(args.chatId),
          messageId,
          url: redactedUrl,
        });
        return {
          platform: 'telegram',
          messageId,
          deliveredAt: new Date(),
        } satisfies NotifyResult;
      },
      {
        maxRetries,
        baseDelayMs,
        capDelayMs,
        isRetryable,
        onRetry: (err, attempt, delayMs) => {
          log.warn('TELEGRAM_RETRY', {
            chatId: String(args.chatId),
            attempt,
            delayMs: Math.round(delayMs),
            error: err instanceof Error ? err.message : String(err),
          });
        },
      }
    );
  }

  // ─── send (Notifier interface) ─────────────────────

  return {
    sendMessage,

    async send(message) {
      // message.to is the chatId in the Telegram context
      const chatId = message.to !== '' ? message.to : defaultChatId;
      if (chatId === undefined || chatId === '') {
        throw new TelegramValidationError(
          'send() requires message.to (chatId) or config.defaultChatId to be set.',
          'missing_chat_id'
        );
      }
      return sendMessage({ chatId, text: message.text });
    },
  };
}

/**
 * Create a TelegramNotifier from environment variables.
 *
 * Reads:
 *   TELEGRAM_BOT_TOKEN       — required — from @BotFather
 *   TELEGRAM_DEFAULT_CHAT_ID — optional — default chat_id for sendMessage
 *
 * Throws TelegramValidationError synchronously when TELEGRAM_BOT_TOKEN is absent.
 */
export function createTelegramNotifierFromEnv(
  overrides?: Partial<Omit<TelegramNotifierConfig, 'botToken' | 'defaultChatId'>>
): TelegramNotifier {
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature in TS strict
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature in TS strict
  const defaultChatId = process.env['TELEGRAM_DEFAULT_CHAT_ID'];

  if (botToken === undefined || botToken === '') {
    throw new TelegramValidationError(
      'TELEGRAM_BOT_TOKEN environment variable is not set. ' +
        'Get a token from @BotFather on Telegram.',
      'missing_bot_token'
    );
  }

  return createTelegramNotifier({
    botToken,
    ...(defaultChatId !== undefined && defaultChatId !== '' ? { defaultChatId } : {}),
    ...overrides,
  });
}
