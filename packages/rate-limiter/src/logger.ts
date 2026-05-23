/**
 * Pluggable logger for @diabolicallabs/rate-limiter.
 *
 * Matches toolkit-wide convention from @diabolicallabs/llm-pricing,
 * @diabolicallabs/llm-client, and @diabolicallabs/notion.
 *
 * Default behavior: structured JSON to stdout.
 *
 * Stable event names:
 *   RL_ALLOWED      — request admitted (DEBUG-level; optional for consumers)
 *   RL_REJECTED     — request rejected (over limit)
 *   RL_REDIS_ERROR  — Redis threw; records the onRedisError policy applied
 */

import type { Logger } from './types.js';

const defaultLogger: Logger = {
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
};

let activeLogger: Logger = defaultLogger;

/**
 * Replace the package's logger. Pass null to reset to the default.
 */
export function setRateLimiterLogger(logger: Logger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal accessor. Always returns the currently-active logger. */
export function getLogger(): Logger {
  return activeLogger;
}
