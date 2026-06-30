/**
 * Pluggable logger for @diabolicallabs/telegram.
 *
 * Default behavior: structured JSON to stdout (Railway-friendly log ingester).
 * Consumers call setTelegramLogger() once at bootstrap to route through their
 * application logger (pino, winston, Datadog, OpenTelemetry, etc.).
 *
 * Stable event names:
 *   TELEGRAM_SEND_OK           — sendMessage succeeded
 *   TELEGRAM_RETRY             — retrying after transient error
 *   TELEGRAM_RATE_LIMIT        — 429 encountered; retry_after from body
 *   TELEGRAM_AUTH_ERROR        — 401; not retried
 *   TELEGRAM_CHAT_NOT_FOUND    — 400/403 chat not found or bot blocked; not retried
 *   TELEGRAM_VALIDATION_ERROR  — 400 family; not retried
 *   TELEGRAM_UNAVAILABLE_ERROR — 5xx after retries exhausted
 */

import type { Logger } from '@diabolicallabs/notifier-core';

const defaultLogger: Logger = {
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
};

let activeLogger: Logger = defaultLogger;

/**
 * Override the default Telegram notifier logger.
 * Pass `null` to reset to the built-in JSON-to-stdout default.
 */
export function setTelegramLogger(logger: Logger | null): void {
  activeLogger = logger ?? defaultLogger;
}

export function getLogger(): Logger {
  return activeLogger;
}
