/**
 * @diabolicallabs/agent-sdk
 *
 * Cost-tracking middleware that wraps @diabolicallabs/llm-client.
 * Intercepts every LLM call to capture a CallRecord and dispatches it
 * asynchronously (fire-and-forget) to the Agent Spend Dashboard ingestion API.
 *
 * The instrumentation is non-blocking: the LLM response is returned to the
 * caller before the ingestion request completes. If ingestion fails, the SDK
 * retries up to maxIngestionRetries, then drops the record and logs a warning.
 *
 * Implementation begins Week 4. This file exports the public type surface only.
 */

// Instrumentation factory — wraps an LlmClient with cost-tracking
export { instrumentClient } from './sdk.js';

// Types: agent identity, SDK config, instrumented client, call record
export type { AgentIdentity, AgentSdkConfig, CallRecord, InstrumentedLlmClient } from './types.js';
