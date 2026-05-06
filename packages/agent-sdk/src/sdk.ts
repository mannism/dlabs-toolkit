/**
 * instrumentClient — wraps an LlmClient with cost-tracking middleware.
 *
 * Each call to complete(), stream(), or structured() is intercepted:
 *  1. The LLM call executes normally.
 *  2. A CallRecord is built from the response (tokens, latency, identifiers).
 *  3. The record is dispatched to config.ingestionUrl asynchronously — the LLM
 *     response is returned to the caller before ingestion completes.
 *  4. Failed dispatches retry with exponential backoff up to maxIngestionRetries.
 *  5. If all retries fail, the record is dropped and a structured warning is logged.
 *     The error is never propagated to the LLM caller.
 */

import type {
  LlmClient,
  LlmResponse,
  LlmStreamChunk,
  LlmStructuredResponse,
  LlmUsage,
} from '@diabolicallabs/llm-client';
import type { AgentSdkConfig, CallRecord, InstrumentedLlmClient } from './types.js';

// ---------------------------------------------------------------------------
// CallRecord builder
// ---------------------------------------------------------------------------

/**
 * Builds a CallRecord from normalized LlmUsage data.
 * call_id uses crypto.randomUUID() — Node 20 built-in, no external package.
 */
function buildCallRecord(
  usage: LlmUsage,
  model: string,
  latencyMs: number,
  config: AgentSdkConfig
): CallRecord {
  return {
    agent_id: config.identity.agentId,
    model,
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    ...(usage.cacheCreationTokens !== undefined && {
      cache_creation_tokens: usage.cacheCreationTokens,
    }),
    ...(usage.cacheReadTokens !== undefined && {
      cache_read_tokens: usage.cacheReadTokens,
    }),
    latency_ms: latencyMs,
    ...(config.identity.taskLabel !== undefined && {
      task_label: config.identity.taskLabel,
    }),
    ...(config.identity.projectId !== undefined && {
      project_id: config.identity.projectId,
    }),
    timestamp: new Date().toISOString(),
    call_id: crypto.randomUUID(),
  };
}

// ---------------------------------------------------------------------------
// Ingestion dispatch with retry
// ---------------------------------------------------------------------------

/**
 * Dispatches a single attempt to the ingestion endpoint.
 * Returns true on HTTP 2xx, false on any error (network, timeout, non-2xx).
 * Never throws — all errors are caught internally.
 */
async function dispatchOnce(
  record: CallRecord,
  ingestionUrl: string,
  ingestionKey: string,
  timeoutMs: number
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ingestionUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ingestionKey}`,
      },
      body: JSON.stringify(record),
    });
    return response.ok;
  } catch {
    // Network errors, AbortError (timeout), JSON stringify errors — all treated as failure
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatches a CallRecord with exponential backoff retry.
 * On exhaustion, logs a structured warning and drops the record.
 * Never throws — ingestion errors are always silent to the LLM caller.
 */
async function dispatchWithRetry(record: CallRecord, config: AgentSdkConfig): Promise<void> {
  const maxRetries = config.maxIngestionRetries ?? 3;
  const timeoutMs = config.ingestionTimeoutMs ?? 5000;
  const baseDelayMs = 500;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const success = await dispatchOnce(record, config.ingestionUrl, config.ingestionKey, timeoutMs);
    if (success) return;

    if (attempt < maxRetries) {
      // Exponential backoff: 500ms, 1000ms, 2000ms, ...
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  // All retries exhausted — drop the record and warn
  // Structured log: include call_id for audit trail but never log ingestionKey
  console.warn(
    JSON.stringify({
      level: 'warn',
      pkg: '@diabolicallabs/agent-sdk',
      event: 'ingestion_exhausted',
      call_id: record.call_id,
      agent_id: record.agent_id,
      model: record.model,
      message: `Ingestion dispatch failed after ${maxRetries + 1} attempts. Record dropped.`,
    })
  );
}

// ---------------------------------------------------------------------------
// instrumentClient
// ---------------------------------------------------------------------------

/**
 * Wraps an existing LlmClient with cost-tracking middleware.
 * Returns an InstrumentedLlmClient that is a drop-in replacement for LlmClient.
 *
 * When config.disabled is true, the underlying client is returned directly
 * with sdkConfig attached — no instrumentation overhead, no fetch calls.
 */
export function instrumentClient(client: LlmClient, config: AgentSdkConfig): InstrumentedLlmClient {
  // Disabled mode: skip all instrumentation, expose underlying client directly
  if (config.disabled === true) {
    return { ...client, sdkConfig: config };
  }

  // complete() — non-streaming, usage available on the response
  async function complete(...args: Parameters<LlmClient['complete']>): Promise<LlmResponse> {
    const start = Date.now();
    const response = await client.complete(...args);
    const latencyMs = Date.now() - start;

    const record = buildCallRecord(response.usage, response.model, latencyMs, config);
    // Dispatch non-blocking — do not await
    void dispatchWithRetry(record, config);

    return response;
  }

  // stream() — async generator passthrough; usage arrives on final chunk
  async function* stream(...args: Parameters<LlmClient['stream']>): AsyncGenerator<LlmStreamChunk> {
    let finalUsage: LlmUsage | undefined;
    const model = client.config.model;
    const start = Date.now();

    try {
      for await (const chunk of client.stream(...args)) {
        if (chunk.usage !== undefined) {
          finalUsage = chunk.usage;
        }
        yield chunk; // pass through immediately — never buffer
      }
    } catch (err) {
      // Stream error: no usage data, no record. Propagate to caller.
      throw err;
    }

    // Stream completed — dispatch if usage was captured
    if (finalUsage !== undefined) {
      const latencyMs = Date.now() - start;
      const record = buildCallRecord(finalUsage, model, latencyMs, config);
      // Non-blocking — void the promise
      void dispatchWithRetry(record, config);
    }
  }

  // structured() — same pattern as complete(), usage on the structured response
  async function structured<T>(
    messages: Parameters<LlmClient['complete']>[0],
    schema: { parse: (data: unknown) => T },
    options?: Parameters<LlmClient['complete']>[1]
  ): Promise<LlmStructuredResponse<T>> {
    const start = Date.now();
    const response = await client.structured<T>(messages, schema, options);
    const latencyMs = Date.now() - start;

    const record = buildCallRecord(response.usage, client.config.model, latencyMs, config);
    void dispatchWithRetry(record, config);

    return response;
  }

  return {
    config: client.config,
    sdkConfig: config,
    complete,
    stream,
    structured,
  };
}
