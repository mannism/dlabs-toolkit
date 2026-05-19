/**
 * Pluggable logger for @diabolicallabs/agent-sdk.
 *
 * Why this exists: the package emits a diagnostic warn when all ingestion retries
 * are exhausted and the CallRecord is dropped (`ingestion_exhausted`). The default
 * behavior writes structured JSON to stdout so Railway-style log ingesters classify
 * the line by the embedded `level` field, not by stream (stderr → severity:error).
 *
 * Consumers that want different routing — human-readable stderr for CLIs, a
 * Datadog/OpenTelemetry adapter for hosted apps — call setAgentSdkLogger() once
 * at bootstrap to swap in their own implementation.
 *
 * Stable event names (consumers may key alerts on these):
 *   ingestion_exhausted — all ingestion retries failed; record was dropped.
 *                         payload: { call_id, agent_id, model, message }
 *
 * @example Bootstrap override for Railway-hosted consumers (no-op — default already works)
 * setAgentSdkLogger(null); // reset to stdout JSON
 *
 * @example Human-readable stderr for a CLI
 * setAgentSdkLogger({
 *   warn: (event, data) => console.warn(`[${event}]`, data),
 * });
 *
 * @example Pino / Winston / Datadog adapter
 * setAgentSdkLogger({
 *   warn: (event, data) => appLogger.warn({ event, ...data }, event),
 * });
 */

/**
 * Pluggable logger interface for @diabolicallabs/agent-sdk.
 * Configure via `setAgentSdkLogger()`. Mirrors the shape of PricingLogger in
 * @diabolicallabs/llm-pricing and LlmClientLogger in @diabolicallabs/llm-client
 * so all three packages feel like one pattern.
 *
 * Default behavior: structured JSON to stdout via `console.log`. Override to
 * route diagnostics through your application logger (pino, winston, Datadog,
 * OpenTelemetry, etc.) or back to human-readable stderr for CLI consumers.
 */
export interface AgentSdkLogger {
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
const defaultLogger: AgentSdkLogger = {
  warn: (event, data) => {
    console.log(JSON.stringify({ level: 'warn', event, ...data }));
  },
};

let activeLogger: AgentSdkLogger = defaultLogger;

/**
 * Replace the package's logger. Pass null to reset to the default.
 *
 * @example
 * // Human-readable stderr for a CLI
 * setAgentSdkLogger({
 *   warn: (event, data) => console.warn(`[${event}]`, data),
 * });
 *
 * @example
 * // Reset to default (structured JSON to stdout)
 * setAgentSdkLogger(null);
 */
export function setAgentSdkLogger(logger: AgentSdkLogger | null): void {
  activeLogger = logger ?? defaultLogger;
}

/** Internal accessor. Always returns the currently-active logger. */
export function getLogger(): AgentSdkLogger {
  return activeLogger;
}
