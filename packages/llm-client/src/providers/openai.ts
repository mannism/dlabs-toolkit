/**
 * OpenAI provider for @diabolicallabs/llm-client.
 *
 * Implements: complete(), stream(), structured()
 *
 * API surface: OpenAI Responses API (`client.responses.create`) — not Chat Completions.
 * This is a full migration from chat.completions.create (v0.4.x) to responses.create (v1.0.0).
 * See MIGRATION.md §"Breaking change 3" for the consumer-facing migration note.
 *
 * Key API differences from Chat Completions (Tom §1.2, §1.3, §1.6):
 *   - Tool shape is FLAT: { type:'function', name, description, parameters } — no nested 'function' key.
 *   - Structured output uses `text: { format: { type:'json_schema', name, schema, strict } }` not `response_format`.
 *   - Streaming events are `ResponseTextDeltaEvent` / `ResponseOutputItemDoneEvent` — not `choices[0].delta.content`.
 *   - `parallel_tool_calls` is a top-level param (same as Chat Completions).
 *   - `previous_response_id` is available for multi-turn conversations.
 *
 * Token normalization:
 *   Responses API: response.usage.input_tokens / output_tokens / total_tokens
 *   → LlmUsage: inputTokens / outputTokens / totalTokens
 *
 * Error mapping:
 *   APIConnectionTimeoutError → kind:'timeout', retryable:true
 *   APIConnectionError → kind:'network', retryable:true
 *   APIStatusError.status → classifyHttpStatus() → LlmError.kind + retryable flag
 *
 * v1.0.0 additions:
 *   - Full Responses API migration for complete(), stream(), structured().
 *   - LlmErrorKind taxonomy: classifyHttpStatus() applied to all status codes.
 *   - structured_parse_failed kind on schema validation failures.
 *   - structured() strict path uses `text.format` (Responses API) not `response_format`.
 */

import OpenAI from 'openai';
import { classifyAbort, createAttemptController, withStallTimeout } from '../abort.js';
import { parseJsonOrThrow } from '../extract-json.js';
import { isZodSchema, toProviderSchema } from '../json-schema.js';
import { classifyHttpStatus, mergeRetryOptsWithSignal, normalizeThrownError, withRetry } from '../retry.js';
import type {
  LlmCallOptions,
  LlmClient,
  LlmClientConfig,
  LlmMessage,
  LlmResponse,
  LlmStreamChunk,
  LlmStructuredResponse,
  LlmUsage,
} from '../types.js';
import { LlmError } from '../types.js';

const PROVIDER = 'openai';

/** Normalize OpenAI Responses API usage object to LlmUsage. */
function normalizeUsage(usage: OpenAI.Responses.ResponseUsage | undefined | null): LlmUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
  };
}

/**
 * Convert LlmMessages to OpenAI Responses API input format.
 *
 * The Responses API accepts a flat array of input items. System messages become
 * a 'system' role input; user/assistant messages become 'user'/'assistant'.
 * Unlike Chat Completions, the Responses API uses `input` not `messages`.
 */
function buildResponsesInput(
  messages: LlmMessage[]
): OpenAI.Responses.EasyInputMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * Extract text content from a Responses API response.
 * The response content is in output[].content[].text (OutputText items).
 */
function extractTextContent(response: OpenAI.Responses.Response): string {
  const parts: string[] = [];
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const contentItem of item.content) {
        if (contentItem.type === 'output_text') {
          parts.push(contentItem.text);
        }
      }
    }
  }
  return parts.join('');
}

/**
 * Normalize any OpenAI SDK error into LlmError.
 * Exported for direct unit testing of the normalization logic.
 */
export function normalizeOpenAIError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // APIConnectionTimeoutError is a subclass of APIConnectionError — check it first so the
  // timeout subtype maps to kind:'timeout' rather than falling through to the generic
  // connection-error branch (which emits no kind discriminator).
  if (
    typeof OpenAI.APIConnectionTimeoutError === 'function' &&
    err instanceof OpenAI.APIConnectionTimeoutError
  ) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      kind: 'timeout',
      retryable: true,
      cause: err,
    });
  }

  // APIConnectionError is a subclass of APIError with status: undefined — check it first
  // so network failures are always retryable regardless of the missing status code.
  if (typeof OpenAI.APIConnectionError === 'function' && err instanceof OpenAI.APIConnectionError) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      kind: 'network',
      retryable: true,
      cause: err,
    });
  }

  // Catch all other APIError subclasses: RateLimitError (429), AuthenticationError (401),
  // InternalServerError (500), etc. Classify to specific LlmErrorKind via HTTP status.
  if (typeof OpenAI.APIError === 'function' && err instanceof OpenAI.APIError) {
    const status: number | undefined = err.status;
    if (status !== undefined) {
      const kind = classifyHttpStatus(status);
      const retryable = kind === 'rate_limit' || kind === 'server_error';
      return new LlmError({
        message: err.message,
        provider: PROVIDER,
        statusCode: status,
        kind,
        retryable,
        cause: err,
      });
    }
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      kind: 'unknown',
      retryable: false,
      cause: err,
    });
  }

  return normalizeThrownError(err, PROVIDER);
}

/** Create the OpenAI provider implementation using the Responses API. */
export function createOpenAIProvider(config: LlmClientConfig): LlmClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // We manage retries ourselves via withRetry
  });

  const retryOpts = {
    maxRetries: config.maxRetries ?? 3,
    baseDelayMs: config.baseDelayMs ?? 1_000,
    provider: PROVIDER,
  };

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model ?? config.model;
    const input = buildResponsesInput(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    return withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
            model,
            input,
            stream: false,
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_output_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // timeout: effectiveTimeoutMs overrides the SDK socket deadline for this call,
          // ensuring the per-call budget matches the AbortController budget (Fix A, v0.4.2).
          const response = await client.responses.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
          });

          const content = extractTextContent(response);

          return {
            content,
            model: response.model,
            usage: normalizeUsage(response.usage),
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );
  }

  async function* stream(
    messages: LlmMessage[],
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? config.model;
    const input = buildResponsesInput(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model,
      input,
      stream: true,
    };

    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_output_tokens = maxTokens;

    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
    let sdkStream: Awaited<ReturnType<typeof client.responses.create>>;

    try {
      // timeout: effectiveTimeoutMs overrides the SDK socket deadline for this call (Fix A, v0.4.2).
      sdkStream = await client.responses.create(params, {
        signal: ctl.signal,
        timeout: effectiveTimeoutMs,
      });
    } catch (err) {
      ctl.dispose();
      throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    let finalUsage: LlmUsage | undefined;

    try {
      // Responses API streaming events are ResponseStreamEvent typed objects.
      // Text tokens arrive as 'response.output_text.delta' events.
      // Usage arrives in the 'response.completed' event on response.usage.
      // biome-ignore lint/complexity/useLiteralKeys: ResponseStreamEvent union — dot access triggers noPropertyAccessFromIndexSignature
      for await (const event of withStallTimeout(sdkStream as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>, stallMs, ctl, PROVIDER)) {
        if (event.type === 'response.output_text.delta') {
          const delta = event.delta;
          if (delta !== undefined && delta.length > 0) {
            yield { token: delta };
          }
        } else if (event.type === 'response.completed') {
          // Usage is on the completed response object
          finalUsage = normalizeUsage(event.response.usage);
        }
      }
    } catch (err) {
      throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    } finally {
      ctl.dispose();
    }

    // Yield usage on the final sentinel chunk
    if (finalUsage !== undefined) {
      yield { token: '', usage: finalUsage };
    }
  }

  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    // Detect Zod 4 schema and check for prompt-mode escape hatch.
    // isZodSchema throws if a Zod 3 schema is passed (clear upgrade message).
    // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown> — noPropertyAccessFromIndexSignature requires bracket notation
    const structuredMode = options?.providerOptions?.['structuredMode'];
    const useStrict = isZodSchema(schema) && structuredMode !== 'prompt';

    if (!useStrict) {
      return structuredPromptFallback(messages, schema, options);
    }

    // ── Strict path: Responses API text.format.type = 'json_schema' ──────────
    // On the Responses API, structured output is configured via `text.format` (not `response_format`).
    // The `name` field is required and `strict: true` enforces schema conformance.
    // Tom §1.3: ResponseFormatTextJSONSchemaConfig shape verified against SDK types.
    const jsonSchema = toProviderSchema(schema, 'openai');
    const model = options?.model ?? config.model;
    const input = buildResponsesInput(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
            model,
            input,
            stream: false,
            text: {
              format: {
                type: 'json_schema',
                name: 'response',
                schema: jsonSchema as Record<string, unknown>,
                strict: true,
              },
            },
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_output_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // timeout: effectiveTimeoutMs overrides the SDK socket deadline (Fix A, v0.4.2).
          return await client.responses.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
          });
        } catch (err) {
          throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    // Check for model refusal — strict mode can return a refusal output item
    for (const item of rawResponse.output) {
      if (item.type === 'message') {
        for (const contentItem of item.content) {
          if (contentItem.type === 'refusal') {
            throw new LlmError({
              message: `OpenAI structured output: model refused to generate. Refusal: ${contentItem.refusal.slice(0, 200)}`,
              provider: PROVIDER,
              kind: 'content_filter',
              retryable: false,
            });
          }
        }
      }
    }

    const rawContent = extractTextContent(rawResponse);

    let parsed: unknown;
    try {
      // Strict mode guarantees valid JSON, but parse defensively
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new LlmError({
        message: `OpenAI structured output: response is not valid JSON. Raw: ${rawContent.slice(0, 200)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    // Defense-in-depth: validate against the Zod schema even after strict-mode call
    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `OpenAI structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      model: rawResponse.model,
      id: rawResponse.id,
      usage: normalizeUsage(rawResponse.usage),
      latencyMs: Date.now() - start,
    };
  }

  /**
   * Prompt-only fallback for structured() — used when schema is not Zod 4 or
   * providerOptions.structuredMode === 'prompt'.
   * Uses the Responses API with no schema enforcement (plain text output + JSON parse).
   */
  async function structuredPromptFallback<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    const jsonSystemInstruction: LlmMessage = {
      role: 'system',
      content:
        'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
    };

    const augmentedMessages = [jsonSystemInstruction, ...messages];
    const model = options?.model ?? config.model;
    const input = buildResponsesInput(augmentedMessages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
            model,
            input,
            stream: false,
            // Responses API text.format for JSON object mode (no schema enforcement)
            text: {
              format: {
                type: 'json_object',
              },
            },
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_output_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // timeout: effectiveTimeoutMs overrides the SDK socket deadline (Fix A, v0.4.2).
          return await client.responses.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
          });
        } catch (err) {
          throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    const rawContent = extractTextContent(rawResponse);

    // parseJsonOrThrow: tries extractJsonBlock first (handles fences, prose, no closing fence),
    // falls back to legacy strip+parse, then throws a non-retryable LlmError with a
    // ≥500-char raw content slice when no valid JSON can be extracted.
    const parsed = parseJsonOrThrow(rawContent, PROVIDER);

    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `OpenAI structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      model: rawResponse.model,
      id: rawResponse.id,
      usage: normalizeUsage(rawResponse.usage),
      latencyMs: Date.now() - start,
    };
  }

  return {
    config,
    complete,
    stream,
    structured,
  };
}
