/**
 * Pluggable logger for @diabolicallabs/prompt-registry.
 *
 * Matches toolkit-wide convention from @diabolicallabs/llm-pricing,
 * @diabolicallabs/llm-client, @diabolicallabs/notion, and @diabolicallabs/rate-limiter.
 *
 * Default behavior: structured JSON to stdout.
 *
 * SECURITY INVARIANT: every call site in this package passes only
 * name/type/version/length/hash metadata to the logger — never raw prompt
 * `content` and never connection strings or credentials. See masking.ts for
 * the helper consumers use when building their own audit-log display of
 * prompt bodies. src/__tests__/unit/logging-security.test.ts asserts this
 * invariant by spying on the logger across every registry method.
 *
 * Stable event names:
 *   PROMPT_SEEDED           — seed() inserted a new v1 row
 *   PROMPT_SEED_SKIPPED     — seed() found existing versions, left them alone
 *   PROMPT_PUBLISHED        — publish() inserted + activated a new version
 *   PROMPT_ROLLED_BACK      — rollback() re-activated a prior version
 *   PROMPT_NOT_FOUND        — get()/rollback() target does not exist
 *   PROMPT_VERSION_CONFLICT — concurrent publish() lost the version-number race
 *   PROMPT_STORAGE_ERROR    — adapter call threw
 */

import type { Logger } from './types.js';

const defaultLogger: Logger = {
  info: (event, data) => {
    console.log(JSON.stringify({ level: 'info', event, ...data }));
  },
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
  error: (event, data) => {
    console.log(JSON.stringify({ level: 'error', event, ...data }));
  },
};

let activeLogger: Logger = defaultLogger;

/** Replace the package's logger. Pass null to reset to the default (structured JSON to stdout). */
export function setPromptRegistryLogger(logger: Logger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal accessor. Always returns the currently-active logger. */
export function getLogger(): Logger {
  return activeLogger;
}
