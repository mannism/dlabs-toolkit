/**
 * Pluggable logger for @diabolicallabs/slack.
 *
 * Default behavior: structured JSON to stdout (Railway-friendly log ingester).
 * Consumers call setSlackLogger() once at bootstrap to route through their
 * application logger (pino, winston, Datadog, OpenTelemetry, etc.).
 *
 * Stable event names:
 *   SLACK_POST_MESSAGE_OK         — postMessage succeeded
 *   SLACK_POST_WEBHOOK_OK         — postWebhook succeeded
 *   SLACK_RETRY                   — retrying after transient error
 *   SLACK_RATE_LIMIT              — 429 encountered; waiting per Retry-After
 *   SLACK_RATELIMITER_UNAVAILABLE — rate-limiter peer-dep threw (Redis down); sending anyway
 *   SLACK_AUTH_ERROR              — 401/403-class error; not retried
 *   SLACK_CHANNEL_NOT_FOUND       — channel_not_found; not retried
 *   SLACK_VALIDATION_ERROR        — bad payload; not retried
 *   SLACK_UNAVAILABLE_ERROR       — 5xx after retries exhausted
 */

import type { Logger } from '@diabolicallabs/notifier-core';

const defaultLogger: Logger = {
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
};

let activeLogger: Logger = defaultLogger;

/**
 * Override the default Slack notifier logger.
 * Pass `null` to reset to the built-in JSON-to-stdout default.
 */
export function setSlackLogger(logger: Logger | null): void {
  activeLogger = logger ?? defaultLogger;
}

export function getLogger(): Logger {
  return activeLogger;
}
