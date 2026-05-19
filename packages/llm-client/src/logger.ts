/**
 * Pluggable logger for @diabolicallabs/llm-client.
 *
 * Why this exists: the package emits diagnostics for pricing-source, model-fallback,
 * pricing-peer-dep-missing, and aftercall-hook-error events. The default behavior
 * writes structured JSON to stdout so Railway-style log ingesters classify the
 * line by the embedded `level` field, not by stream (stderr → severity:error).
 *
 * Consumers that want different routing — human-readable stderr for CLIs, a
 * Datadog/OpenTelemetry adapter for hosted apps — call setLlmClientLogger() once
 * at bootstrap to swap in their own implementation.
 *
 * Stable event names (consumers may key alerts on these):
 *   pricing_source         — emitted at createClient() init time when pricing config is set.
 *                            payload: { source: 'bundled' | 'consumer_override' | 'remote' | 'cache' | 'fallback', url?, fetchedAt?, error? }
 *   pricing_peer_dep_missing — @diabolicallabs/llm-pricing not installed but pricing config is set.
 *                            payload: { message }
 *   model_fallback         — primary model rejected; next model in the array served the call.
 *                            payload: { from, to, reason } where reason is an LlmErrorKind.
 *   aftercall_hook_error   — afterCall hook threw; error was dropped to protect the caller.
 *                            payload: { callType, model, message }
 *
 * Note on log level semantics: all four events route through the `warn` method.
 * The payload may include a `level` field (e.g. `model_fallback` carries `level:'info'`)
 * so consumers that ingest the structured JSON can filter by severity beyond the
 * logger-level call.
 *
 * @example Bootstrap override for Railway-hosted consumers (no-op — default already works)
 * setLlmClientLogger(null); // reset to stdout JSON
 *
 * @example Human-readable stderr for a CLI
 * setLlmClientLogger({
 *   warn: (event, data) => console.warn(`[${event}]`, data),
 * });
 *
 * @example Pino / Winston / Datadog adapter
 * setLlmClientLogger({
 *   warn: (event, data) => appLogger.warn({ event, ...data }, event),
 * });
 */

/**
 * Pluggable logger interface for @diabolicallabs/llm-client.
 * Configure via `setLlmClientLogger()`. Mirrors the shape of PricingLogger
 * in @diabolicallabs/llm-pricing so the two packages feel like one pattern.
 *
 * Default behavior: structured JSON to stdout via `console.log`. Override to
 * route diagnostics through your application logger (pino, winston, Datadog,
 * OpenTelemetry, etc.) or back to human-readable stderr for CLI consumers.
 */
export interface LlmClientLogger {
  warn: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Default logger: structured JSON to stdout.
 *
 * Shape: { "level": "warn", "event": "<event_name>", ...payload }
 *
 * Stdout (not stderr) so log ingesters that map stream → severity (e.g. Railway)
 * see these as info, not error. The `level` field carries the intent.
 */
const defaultLogger: LlmClientLogger = {
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
};

let activeLogger: LlmClientLogger = defaultLogger;

/**
 * Replace the package's logger. Pass null to reset to the default.
 *
 * @example
 * // Human-readable stderr for a CLI
 * setLlmClientLogger({
 *   warn: (event, data) => console.warn(`[${event}]`, data),
 * });
 *
 * @example
 * // Reset to default (structured JSON to stdout)
 * setLlmClientLogger(null);
 */
export function setLlmClientLogger(logger: LlmClientLogger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal accessor. Always returns the currently-active logger. */
export function getLogger(): LlmClientLogger {
  return activeLogger;
}
