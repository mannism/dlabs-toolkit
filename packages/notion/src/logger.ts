/**
 * Pluggable logger for @diabolicallabs/notion.
 *
 * Why this exists: the package emits structured diagnostics for retry events,
 * rate-limit backoff, and error mapping. The default behavior writes structured
 * JSON to stdout so Railway-style log ingesters classify the line by the embedded
 * `level` field, not by stream.
 *
 * Consumers that want different routing — human-readable stderr for CLIs, a
 * Datadog/OpenTelemetry adapter for hosted apps — call setNotionLogger() once
 * at bootstrap to swap in their own implementation.
 *
 * Stable event names:
 *   NOTION_CONFLICT_RETRY     — 409 retrying, payload: { attempt, delayMs, pageId? }
 *   NOTION_RATE_LIMIT_RETRY   — 429 SDK retry exhausted, payload: { code }
 *   NOTION_REQUEST_ERROR      — any mapped error; payload: { code, status?, message }
 *   NOTION_ENV_KEY_MISSING    — createNotionClientFromEnv called with no NOTION_API_KEY
 */

import type { Logger } from './types.js';

/**
 * Default logger: structured JSON to stdout.
 * Shape: { "level": "warn", "event": "<event_name>", ...payload }
 */
const defaultLogger: Logger = {
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
};

let activeLogger: Logger = defaultLogger;

/**
 * Replace the package's logger. Pass null to reset to the default.
 *
 * @example
 * setNotionLogger({ warn: (event, data) => console.warn(`[${event}]`, data) });
 * setNotionLogger(null); // reset to default
 */
export function setNotionLogger(logger: Logger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal accessor. Always returns the currently-active logger. */
export function getLogger(): Logger {
  return activeLogger;
}
