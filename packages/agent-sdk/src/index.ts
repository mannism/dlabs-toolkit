/**
 * @diabolicallabs/agent-sdk
 *
 * Cost-tracking middleware that wraps @diabolicallabs/llm-client.
 * Intercepts every LLM call (complete, stream, structured, withTools,
 * streamStructured) to capture a CallRecord and dispatch it asynchronously
 * (fire-and-forget) to the Agent Spend Dashboard ingestion API.
 *
 * The instrumentation is non-blocking: the LLM response is returned to the
 * caller before the ingestion request completes. If ingestion fails, the SDK
 * retries up to maxIngestionRetries, then drops the record and logs a warning.
 *
 * All 5 call types route through a single buildAfterCallDispatch() function.
 * CallRecord.tool_calls captures withTools() invocations; CallRecord.cost
 * propagates per-call USD cost when llm-client is configured with pricing.
 * CallRecord.requestedModel preserves the originally-requested model on
 * provider failover. Pluggable logger via setAgentSdkLogger.
 *
 * Requires @diabolicallabs/llm-client@^4.0.0.
 */

// Pluggable logger — swap at bootstrap for custom log routing
export type { AgentSdkLogger } from './logger.js';
export { setAgentSdkLogger } from './logger.js';
// Instrumentation factory — wraps an LlmClient with cost-tracking
export { instrumentClient } from './sdk.js';
// Types: agent identity, SDK config, instrumented client, call record
export type { AgentIdentity, AgentSdkConfig, CallRecord, InstrumentedLlmClient } from './types.js';
