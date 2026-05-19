/**
 * Pluggable logger for @diabolicallabs/llm-pricing.
 *
 * Why this exists: the package emits diagnostics for deprecation, unknown-model,
 * date-strip fallback, and remote-fetch failure events. The default behavior
 * writes structured JSON to stdout so Railway-style log ingesters classify the
 * line by the embedded `level` field, not by stream (stderr → severity:error).
 *
 * Consumers that want different routing — human-readable stderr for CLIs, a
 * Datadog/OpenTelemetry adapter for hosted apps — call setPricingLogger() once
 * at bootstrap to swap in their own implementation.
 */

import type { PricingLogger } from './types.js';

/**
 * Default logger: structured JSON to stdout.
 *
 * Shape: { "level": "warn", "event": "<event_name>", ...payload }
 *
 * Stdout (not stderr) so log ingesters that map stream → severity (e.g. Railway)
 * see these as info, not error. The `level` field carries the intent.
 */
const defaultLogger: PricingLogger = {
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
};

let activeLogger: PricingLogger = defaultLogger;

/**
 * Replace the package's logger. Pass null to reset to the default.
 *
 * @example
 * // Human-readable stderr for a CLI
 * setPricingLogger({
 *   warn: (event, data) => console.warn(`[${event}]`, data),
 * });
 *
 * @example
 * // Reset to default (structured JSON to stdout)
 * setPricingLogger(null);
 */
export function setPricingLogger(logger: PricingLogger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal accessor. Always returns the currently-active logger. */
export function getLogger(): PricingLogger {
  return activeLogger;
}
