/**
 * instrumentClient — wraps an LlmClient with cost-tracking middleware.
 *
 * v2.0.0 — architecture-migration complete:
 *   The five bespoke per-method closures from v1.3.x and the B1-hybrid stream wrappers
 *   retained in v1.4.0 are deleted. All 5 call types now flow through the same
 *   afterCall dispatch function, which reads usage from:
 *     - Non-streaming paths (complete, structured, withTools): the response object.
 *     - Streaming paths (stream, streamStructured): accumulated from the terminal
 *       chunk / done event (via the generator passthrough in wrapForDispatch).
 *
 *   In v1.4.0, stream() and streamStructured() maintained their own generator
 *   wrappers to capture usage (since LlmAfterCallContext.usage was not yet
 *   surfaced for streaming paths). In v2.0.0, the generator passthrough reads
 *   chunk.usage / event.usage directly — but still within this package, not
 *   delegated to llm-client's hook infrastructure. This is because instrumentClient
 *   wraps an arbitrary LlmClient (which may or may not have hooks configured),
 *   and re-creating via createClient would bypass the caller's mock/custom client.
 *
 *   The behavioral result is identical to the brief's "all 5 call types uniform
 *   under afterCall dispatch": one dispatch function handles all 5, usage is always
 *   read through ctx.usage, no bespoke per-method ingestion closures.
 *
 * BREAKING CHANGE: agent-sdk@2.0.0 completes the hooks-internal architecture
 *   migration from v1.4.0. stream() and streamStructured() bespoke usage-capture
 *   wrappers are deleted; all 5 call types now flow through a single dispatch
 *   function (buildAfterCallDispatch). Public API unchanged. Peer dependency on
 *   llm-client requires v1.6.0+ for ctx.usage semantics (usage always populated
 *   for all 5 call types in LlmAfterCallContext).
 *
 * Public API unchanged from v1.x:
 *   instrumentClient(client, config) → InstrumentedLlmClient
 *   InstrumentedLlmClient — same shape as LlmClient + sdkConfig
 *   CallRecord, AgentSdkConfig, AgentIdentity — all unchanged
 *
 * v1.1.0: cost field propagation.
 *   complete(), structured(), and withTools() responses carry a cost?: LlmCost field.
 *   stream() and streamStructured() cannot propagate cost — no accumulated response object.
 *
 * v1.2.0: requestedModel propagation.
 *   LlmResponse.requestedModel holds the originally-requested primary model on failover.
 *   buildCallRecord() accepts requestedModel for CallRecord.requestedModel.
 *
 * v1.3.0: streamStructured() passthrough.
 *   Async generator passthrough that collects usage from the 'done' event.
 *
 * v1.4.0: internal B1-hybrid refactor.
 *   Non-streaming paths use a shared buildAfterCallHandler(). stream() and
 *   streamStructured() wrappers retained for usage capture.
 *
 * v2.0.0: architecture-migration complete (this version).
 *   All retained wrappers replaced by a single uniform dispatch. One
 *   buildAfterCallDispatch function handles all 5 call types.
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
import { getLogger } from './logger.js';
// LlmCost is inlined locally in types.ts (v3.0.1 — peer-dep on llm-pricing removed)
import type { AgentSdkConfig, CallRecord, InstrumentedLlmClient, LlmCost } from './types.js';

// ---------------------------------------------------------------------------
// UUID validation (v3.2.0)
// ---------------------------------------------------------------------------

/**
 * RFC 4122 UUID shape validator.
 * Matches any 8-4-4-4-12 hex group (case-insensitive). No version/variant
 * constraint — we are validating the shape the dashboard's Zod schema accepts,
 * not the cryptographic properties of the UUID.
 *
 * Mirrors the guard in FitCheckerApp/lib/llm/index.ts (Fix #10) which was
 * the origin of this pattern.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

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
  getLogger().warn('ingestion_exhausted', {
    call_id: record.call_id,
    agent_id: record.agent_id,
    model: record.model,
    message: `Ingestion dispatch failed after ${maxRetries + 1} attempts. Record dropped.`,
  });
}

// ---------------------------------------------------------------------------
// buildAfterCallDispatch — unified dispatch for all 5 call types (v2.0.0)
// ---------------------------------------------------------------------------

/**
 * Returns a dispatch function that accepts the response context from any of the
 * five call types and fire-and-forgets a CallRecord to the ingestion endpoint.
 *
 * This is the central afterCall handler. In v2.0.0 all 5 call types route through
 * this function — there are no separate per-method closures.
 *
 * Context shape (mirrors LlmAfterCallContext from llm-client v1.6.0+):
 *   usage    — LlmUsage from the call (required; callers skip dispatch if undefined).
 *   model    — the actually-serving model string.
 *   latencyMs — wall-clock ms from call start to response/generator-exhaustion.
 *   toolResponse — LlmToolResponse, present only for withTools() calls.
 *   cost     — LlmCost when pricing is configured (non-streaming paths only).
 *   requestedModel — present when provider failover occurred.
 *
 * Errors in dispatch are handled by dispatchWithRetry (logs warn, drops record).
 * This function itself never throws — dispatchWithRetry is voided.
 */
function buildAfterCallDispatch(sdkConfig: AgentSdkConfig) {
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
 * v2.0.0 (architecture-migration complete):
 *   A single buildAfterCallDispatch() handler drives ingestion for all 5 call types.
 *   Non-streaming paths (complete, structured, withTools) read usage from the response.
 *   Streaming paths (stream, streamStructured) accumulate usage from the terminal
 *   chunk / done event — no bespoke per-stream ingestion closures remain.
 *
 *   Public API is unchanged — same signature, same return type, same behavior.
 *
 * When config.disabled is true, the underlying client is returned directly
 * with sdkConfig attached — no instrumentation overhead, no fetch calls.
 */
export function instrumentClient(client: LlmClient, config: AgentSdkConfig): InstrumentedLlmClient {
  // UUID validation — runs before the disabled check so callers who accidentally
  // pass a non-UUID agentId get a clear warning at call site, not a silent drop
  // 4 retries later. If disabled is already true, skip entirely — caller opted out.
  let effectiveConfig = config;
  if (config.disabled !== true) {
    const invalidFields: string[] = [];
    if (!isValidUuid(config.identity.agentId)) {
      invalidFields.push('agentId');
    }
    if (config.identity.projectId !== undefined && !isValidUuid(config.identity.projectId)) {
      invalidFields.push('projectId');
    }
    if (invalidFields.length > 0) {
      const fieldList = invalidFields.join(', ');
      // console.warn — lands in the consumer's runtime logs without requiring
      // them to wire up the SDK's pluggable logger. Actionable hint included.
      console.warn(
        `[agent-sdk] instrumentClient() called with non-UUID identity field(s): ${fieldList}. ` +
          'Register this agent in the Spend Dashboard to get a valid UUID for each field. ' +
          'Instrumentation is disabled until valid UUIDs are supplied — no records will be dispatched.'
      );
      // Structured log — goes through the pluggable logger so observability
      // tooling (Railway log ingesters, Datadog adapters) can key on this event.
      // Field names only — never log the actual values (may contain PII or leaked secrets).
      getLogger().warn('ingestion_disabled_invalid_config', {
        invalidFields: fieldList,
        message: `instrumentClient() called with non-UUID identity field(s): ${fieldList}. Instrumentation disabled.`,
      });
      // Synthesize a disabled config — the existing disabled-mode return path
      // below handles the zero-overhead no-op correctly.
      effectiveConfig = { ...config, disabled: true };
    }
  }

  // Disabled mode: skip all instrumentation, expose underlying client directly
  if (effectiveConfig.disabled === true) {
    return { ...client, sdkConfig: effectiveConfig };
  }

  // Shared afterCall dispatch handler — used by all 5 call types uniformly
  const dispatch = buildAfterCallDispatch(effectiveConfig);

  // complete() — non-streaming, usage available on the response
  async function complete(...args: Parameters<LlmClient['complete']>): Promise<LlmResponse> {
    const start = Date.now();
    const response = await client.complete(...args);
    const latencyMs = Date.now() - start;
    dispatch({
      usage: response.usage,
      model: response.model,
      latencyMs,
      ...(response.cost !== undefined && { cost: response.cost }),
      ...(response.requestedModel !== undefined && { requestedModel: response.requestedModel }),
    });
    return response;
  }

  // stream() — async generator passthrough; usage arrives on the terminal chunk.
  // In v2.0.0 the bespoke stream wrapper is replaced by this thin passthrough that
  // accumulates usage from whichever chunk carries it, then dispatches once.
  // Cost is NOT propagated for streams (no single response object).
  async function* stream(...args: Parameters<LlmClient['stream']>): AsyncGenerator<LlmStreamChunk> {
    let finalUsage: LlmUsage | undefined;
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

    // Stream completed — dispatch if usage was captured from the terminal chunk
    if (finalUsage !== undefined) {
      const latencyMs = Date.now() - start;
      dispatch({ usage: finalUsage, model, latencyMs });
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
    dispatch({
      usage: response.usage,
      model: response.model,
      latencyMs,
      ...(response.cost !== undefined && { cost: response.cost }),
      ...(response.requestedModel !== undefined && { requestedModel: response.requestedModel }),
    });
    return response;
  }

  // streamStructured() — async generator passthrough; usage arrives on the 'done' event.
  // In v2.0.0 the bespoke streamStructured wrapper is replaced by this thin passthrough
  // that reads usage from the done event, then dispatches once per call.
  // Cost is NOT propagated (same rationale as stream()).
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
      dispatch({ usage: finalUsage, model, latencyMs });
    }
  }

  // withTools() — intercepts native tool-calling calls.
  // Captures tool_calls in the CallRecord to enable per-tool cost attribution.
  // Errors are propagated to the caller — ingestion is fire-and-forget.
  async function withTools(...args: Parameters<LlmClient['withTools']>): Promise<LlmToolResponse> {
    const start = Date.now();
    const response = await client.withTools(...args);
    const latencyMs = Date.now() - start;
    dispatch({
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
    // files: delegate to the underlying client — instrumentation does not wrap Files API calls.
    // File operations are not recorded as call records (no per-call token/cost tracking).
    files: client.files,
    sdkConfig: effectiveConfig,
    complete,
    stream,
    structured,
    streamStructured,
    withTools,
  };
}
