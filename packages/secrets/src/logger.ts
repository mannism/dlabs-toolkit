/**
 * Pluggable logger for @diabolicallabs/secrets.
 *
 * Matches toolkit-wide convention from @diabolicallabs/rate-limiter,
 * @diabolicallabs/llm-pricing, @diabolicallabs/llm-client, and
 * @diabolicallabs/notion.
 *
 * Default behavior: structured JSON to stdout. Never logs masterKey,
 * plaintext, or ciphertext — only event name and non-sensitive metadata.
 *
 * Stable event names:
 *   SECRETS_DECRYPT_FAILED       — decrypt() rejected (node:crypto threw)
 *   SECRETS_MALFORMED_CIPHERTEXT — decrypt() given a non-conforming string
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
export function setSecretsLogger(logger: Logger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal accessor. Always returns the currently-active logger. */
export function getLogger(): Logger {
  return activeLogger;
}
