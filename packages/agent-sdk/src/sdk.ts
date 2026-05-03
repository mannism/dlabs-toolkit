/**
 * instrumentClient — wraps an LlmClient with cost-tracking middleware.
 * Week 1 scaffold: stub only. Full implementation in Week 4.
 */

import type { LlmClient } from '@diabolicallabs/llm-client';
import type { AgentSdkConfig, InstrumentedLlmClient } from './types.js';

/**
 * Wraps an existing LlmClient with cost-tracking middleware.
 * Returns an InstrumentedLlmClient that is a drop-in replacement for LlmClient.
 * Every call to complete(), stream(), or structured() will:
 *   1. Execute the LLM call normally
 *   2. Dispatch a CallRecord to the ingestion URL asynchronously (non-blocking)
 *   3. Return the LLM response to the caller without waiting for ingestion
 */
export function instrumentClient(
  _client: LlmClient,
  _config: AgentSdkConfig
): InstrumentedLlmClient {
  throw new Error(
    '[dlabs-toolkit] instrumentClient is not yet implemented. Implementation ships Week 4.'
  );
}
