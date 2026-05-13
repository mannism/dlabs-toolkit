/**
 * instrumentClient — wraps an LlmClient with cost-tracking middleware.
 *
 * v1.4.0 — internal refactor (B1-hybrid):
 *   complete(), structured(), and withTools() now use the afterCall hook pattern
 *   internally — a shared buildAfterCallHandler() constructs the ingestion dispatch
 *   handler, wired through the hook lifecycle instead of bespoke closures.
 *
 *   The five per-method closures in v1.3.x are replaced by:
 *     - Non-streaming paths (complete, structured, withTools): thin delegation wrappers
 *       that call the original client and fire the afterCall handler manually.
 *     - stream() and streamStructured(): RETAINED wrappers for usage capture from the
 *       done/final-chunk event (usage not yet surfaced in afterCall context for streams).
 *
 *   These retained stream wrappers will be deleted when LlmAfterCallContext.usage
 *   lands in v1.6.0 (tracked in source brief §3.1 deferred item).
 *
 * Public API unchanged from v1.3.x:
 *   instrumentClient(client, config) → InstrumentedLlmClient
 *   InstrumentedLlmClient — same shape as LlmClient + sdkConfig
 *   CallRecord, AgentSdkConfig, AgentIdentity — all unchanged
 *
 * v1.1.0: cost field propagation.
 *   When the wrapped LlmClient has pricing configured (via LlmClientConfig.pricing),
 *   complete(), structured(), and withTools() responses carry a cost? LlmCost field.
 *   buildCallRecord() accepts an optional cost and includes it in the CallRecord.
 *   stream() and streamStructured() cannot propagate cost — streaming does not
 *   produce a single accumulated response with a cost field.
 *
 * v1.2.0: requestedModel propagation.
 *   When llm-client provider failover fired, LlmResponse.requestedModel holds the
 *   originally-requested primary model. buildCallRecord() accepts requestedModel and
 *   populates CallRecord.requestedModel so ingestion sees both the serving model
 *   (CallRecord.model) and the originally-requested one.
 *
 * v1.3.0: streamStructured() wrapper.
 *   Async generator passthrough that collects usage from the final 'done' event and
 *   dispatches exactly one CallRecord per call. No cost annotation (same as stream()).
 */

import type {
  LlmCallOptions,
  LlmClient,
  LlmMessage,
  LlmResponse,
  LlmStreamChunk,
  LlmStreamStructuredEvent,
  LlmStructuredResponse,
  LlmToolResponse,
  LlmUsage,
} from '@diabolicallabs/llm-client';
import type { LlmCost } from '@diabolicallabs/llm-pricing';
import type { AgentSdkConfig, CallRecord, InstrumentedLlmClient } from './types.js';

// ---------------------------------------------------------------------------
// CallRecord builder
// ---------------------------------------------------------------------------

/**
 * Builds a CallRecord from normalized LlmUsage data.
 * call_id uses crypto.randomUUID() — Node 20 built-in, no external package.
 * toolResponse is optional — populated only for withTools() calls to enable
 * per-tool cost attribution in the Spend Dashboard.
 * cost is optional — propagated from LlmResponse.cost when pricing is configured
 * on the LlmClient. When undefined, the cost field is omitted from the record.
 * requestedModel is optional — propagated from LlmResponse.requestedModel when
 * provider failover occurred. When present, model = actually-serving fallback model.
 */
function buildCallRecord(
  usage: LlmUsage,
  model: string,
  latencyMs: number,
  config: AgentSdkConfig,
  toolResponse?: LlmToolResponse,
  cost?: LlmCost,
  requestedModel?: string
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
    ...(toolResponse !== undefined &&
      toolResponse.toolCalls.length > 0 && {
        tool_calls: toolResponse.toolCalls,
      }),
    ...(cost !== undefined && { cost }),
    ...(requestedModel !== undefined && { requestedModel }),
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
// buildAfterCallHandler — shared afterCall hook logic
// ---------------------------------------------------------------------------

/**
 * Returns an async function that, given an LLM response from a non-streaming call,
 * builds a CallRecord and fire-and-forgets it to the ingestion endpoint.
 *
 * This is the central dispatch handler, used by complete(), structured(), and withTools().
 * It replaces the bespoke per-method closures from v1.3.x with a single reusable handler.
 *
 * Errors in dispatch are handled by dispatchWithRetry (logs warn, drops record).
 * This function itself never throws — dispatchWithRetry is voided.
 */
function buildAfterCallHandler(sdkConfig: AgentSdkConfig) {
  return function dispatchAfterCall(opts: {
    usage: LlmUsage;
    model: string;
    latencyMs: number;
    toolResponse?: LlmToolResponse;
    cost?: LlmCost;
    requestedModel?: string;
  }): void {
    const record = buildCallRecord(
      opts.usage,
      opts.model,
      opts.latencyMs,
      sdkConfig,
      opts.toolResponse,
      opts.cost,
      opts.requestedModel
    );
    // Non-blocking — ingestion is fire-and-forget
    void dispatchWithRetry(record, sdkConfig);
  };
}

// ---------------------------------------------------------------------------
// instrumentClient
// ---------------------------------------------------------------------------

/**
 * Wraps an existing LlmClient with cost-tracking middleware.
 * Returns an InstrumentedLlmClient that is a drop-in replacement for LlmClient.
 *
 * v1.4.0 internal refactor:
 *   Non-streaming paths (complete, structured, withTools) use buildAfterCallHandler()
 *   to share ingestion dispatch logic rather than duplicating it across closures.
 *   Public API is unchanged — same signature, same return type, same behavior.
 *
 * When config.disabled is true, the underlying client is returned directly
 * with sdkConfig attached — no instrumentation overhead, no fetch calls.
 */
export function instrumentClient(client: LlmClient, config: AgentSdkConfig): InstrumentedLlmClient {
  // Disabled mode: skip all instrumentation, expose underlying client directly
  if (config.disabled === true) {
    return { ...client, sdkConfig: config };
  }

  // Shared afterCall dispatch handler — used by complete(), structured(), withTools()
  const afterCall = buildAfterCallHandler(config);

  // complete() — non-streaming, usage available on the response
  async function complete(...args: Parameters<LlmClient['complete']>): Promise<LlmResponse> {
    const start = Date.now();
    const response = await client.complete(...args);
    const latencyMs = Date.now() - start;

    // Propagate cost and requestedModel from llm-client when pricing/failover is configured.
    afterCall({
      usage: response.usage,
      model: response.model,
      latencyMs,
      ...(response.cost !== undefined && { cost: response.cost }),
      ...(response.requestedModel !== undefined && { requestedModel: response.requestedModel }),
    });

    return response;
  }

  // RETAINED FOR v1.5.0 — token usage is captured here from the `done` event.
  // Delete when LlmAfterCallContext.usage lands in v1.6.0
  // (tracked in source brief §3.1 deferred item).
  // stream() — async generator passthrough; usage arrives on final chunk.
  // Cost is NOT propagated for streams: there is no single response object,
  // and chunk-level cost accumulation is out of scope. Callers who need
  // per-call cost should use complete() or structured() instead.
  async function* stream(...args: Parameters<LlmClient['stream']>): AsyncGenerator<LlmStreamChunk> {
    let finalUsage: LlmUsage | undefined;
    // config.model is string | string[] — for streaming, the provider already resolved it to
    // the active model string. Use the first element (primary) for the CallRecord.
    const model = Array.isArray(client.config.model)
      ? (client.config.model[0] ?? 'unknown')
      : client.config.model;
    const start = Date.now();

    for await (const chunk of client.stream(...args)) {
      if (chunk.usage !== undefined) {
        finalUsage = chunk.usage;
      }
      yield chunk; // pass through immediately — never buffer
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

    // Propagate cost and requestedModel from llm-client when pricing/failover is configured.
    // response.requestedModel is set when provider failover fired (Wave 2b, v1.2.0+).
    afterCall({
      usage: response.usage,
      model: response.model,
      latencyMs,
      ...(response.cost !== undefined && { cost: response.cost }),
      ...(response.requestedModel !== undefined && { requestedModel: response.requestedModel }),
    });

    return response;
  }

  // RETAINED FOR v1.5.0 — token usage is captured here from the `done` event.
  // Delete when LlmAfterCallContext.usage lands in v1.6.0
  // (tracked in source brief §3.1 deferred item).
  // streamStructured() — async generator passthrough; usage arrives on the final 'done' event.
  // One CallRecord is dispatched per call using the done event's usage field.
  // Cost is NOT propagated (same rationale as stream() — no accumulated response object).
  // Model is resolved from client.config the same way as stream() — primary or first element.
  async function* streamStructured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    let finalUsage: LlmUsage | undefined;
    const model = Array.isArray(client.config.model)
      ? (client.config.model[0] ?? 'unknown')
      : client.config.model;
    const start = Date.now();

    for await (const event of client.streamStructured<T>(messages, schema, options)) {
      if (event.type === 'done') {
        finalUsage = event.usage;
      }
      yield event; // pass through immediately — never buffer
    }

    // Stream completed — dispatch if usage was captured from the done event
    if (finalUsage !== undefined) {
      const latencyMs = Date.now() - start;
      const record = buildCallRecord(finalUsage, model, latencyMs, config);
      // Non-blocking — void the promise
      void dispatchWithRetry(record, config);
    }
  }

  // withTools() — intercepts native tool-calling calls.
  // Captures tool_calls in the CallRecord to enable per-tool cost attribution.
  // Errors are propagated to the caller — ingestion is fire-and-forget.
  async function withTools(...args: Parameters<LlmClient['withTools']>): Promise<LlmToolResponse> {
    const start = Date.now();
    const response = await client.withTools(...args);
    const latencyMs = Date.now() - start;

    // Propagate cost and requestedModel from llm-client when configured.
    afterCall({
      usage: response.usage,
      model: response.model,
      latencyMs,
      toolResponse: response,
      ...(response.cost !== undefined && { cost: response.cost }),
      ...(response.requestedModel !== undefined && { requestedModel: response.requestedModel }),
    });

    return response;
  }

  return {
    config: client.config,
    sdkConfig: config,
    complete,
    stream,
    structured,
    streamStructured,
    withTools,
  };
}
