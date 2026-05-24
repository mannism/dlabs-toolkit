/**
 * @diabolicallabs/notifier-core
 *
 * Shared interface, error taxonomy, Logger, and retry helper for the
 * Diabolical Labs notifier package family.
 *
 * Platform packages (@diabolicallabs/slack, @diabolicallabs/telegram) import
 * their contracts from here. Callers who want portability across platforms
 * program against the Notifier interface.
 *
 * Zero runtime dependencies — types, classes, and a pure retry function only.
 *
 * @example
 * import type { Notifier, NotifyMessage, NotifyResult } from '@diabolicallabs/notifier-core';
 * import { PlatformError, PlatformRateLimitError, retryWithJitter } from '@diabolicallabs/notifier-core';
 */

// Retry helper
export { computeJitter, retryWithJitter } from './retry.js';
// Interfaces
export type {
  Logger,
  Notifier,
  NotifyMessage,
  NotifyResult,
} from './types.js';
// Error taxonomy — exported as values (not just types) for instanceof checks
export {
  PlatformAuthError,
  PlatformError,
  PlatformNotFoundError,
  PlatformRateLimitError,
  PlatformUnavailableError,
  PlatformValidationError,
} from './types.js';
