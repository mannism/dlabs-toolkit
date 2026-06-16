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
import {
  classifyHttpStatus,
  mergeRetryOptsWithSignal,
  normalizeThrownError,
  withRetry,
} from '../retry.js';
import type {
  LlmCallOptions,
  LlmCallWithToolsOptions,
  LlmClient,
  LlmClientConfig,
  LlmFileRef,
  LlmFilesApi,
  LlmMessage,
  LlmResponse,
  LlmStreamChunk,
  LlmStreamStructuredEvent,
  LlmStructuredResponse,
  LlmTool,
  LlmToolCall,
  LlmToolResponse,
  LlmUsage,
} from '../types.js';
import { LlmError } from '../types.js';
import { assertBlocksSupported, mapOpenAIContent } from './content-blocks.js';

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
 *
 * v4.2.0 multimodal support:
 *   - String content is passed through unchanged (all existing callers unaffected).
 *   - LlmContentBlock[] content is mapped to Responses API content items via mapOpenAIContent().
 *   - Pre-flight assertBlocksSupported() runs before message construction to guarantee
 *     no unsupported block type reaches the SDK call site.
 *
 * OpenAI Responses API supports: text, image (base64 + url), document (base64 PDF).
 */
function buildResponsesInput(messages: LlmMessage[]): OpenAI.Responses.EasyInputMessage[] {
  // Pre-flight: assert all blocks in this message set are supported by OpenAI Responses API.
  // fileRef: true — file blocks are supported for PDF refs (media type validation is in mapOpenAIContent).
  assertBlocksSupported(messages, PROVIDER, {
    textBlock: true,
    imageBase64: true,
    imageUrl: true,
    documentBase64: true,
    fileRef: true,
  });

  return messages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: mapOpenAIContent(m.content),
      } as OpenAI.Responses.EasyInputMessage;
    }
    return {
      role: m.role,
      content: m.content,
    } as OpenAI.Responses.EasyInputMessage;
  });
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
  // Providers always receive model as a string (client.ts resolves arrays before dispatch).
  const resolvedModel = Array.isArray(config.model) ? config.model[0]! : config.model;
  const resolvedConfig = { ...config, model: resolvedModel } as LlmClientConfig & {
    model: string;
  };

  const client = new OpenAI({
    apiKey: config.apiKey,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // We manage retries ourselves via withRetry
  });

  const retryOpts = {
    maxRetries: config.maxRetries ?? 3,
    baseDelayMs: config.baseDelayMs ?? 1_000,
    provider: PROVIDER,
    ...(config.retry !== undefined && { retryConfig: config.retry }),
  };

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model ?? resolvedConfig.model;
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
            id: response.id,
            idSource: 'provider' as const,
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
    const model = options?.model ?? resolvedConfig.model;
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
      for await (const event of withStallTimeout(
        sdkStream as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
        stallMs,
        ctl,
        PROVIDER
      )) {
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
    const model = options?.model ?? resolvedConfig.model;
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
      idSource: 'provider' as const,
      usage: normalizeUsage(rawResponse.usage),
      latencyMs: Date.now() - start,
    };
  }

  /**
   * streamStructured() — stream tokens from the Responses API and validate at end (v1.3.0+).
   *
   * Uses text.format json_schema (strict mode when schema is Zod 4) so the Responses API
   * enforces the schema. Tokens arrive as response.output_text.delta events. Usage arrives
   * in response.completed. Accumulates text, then JSON.parse() + schema.parse() at the end.
   *
   * AbortSignal and stall detection are wired the same as stream().
   */
  async function* streamStructured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    const model = options?.model ?? resolvedConfig.model;
    const input = buildResponsesInput(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;

    // Build text format: strict json_schema when Zod 4, otherwise json_object mode.
    const useStrict = isZodSchema(schema);
    const textFormat: OpenAI.Responses.ResponseCreateParamsStreaming['text'] = useStrict
      ? {
          format: {
            type: 'json_schema',
            name: 'response',
            schema: toProviderSchema(schema, 'openai') as Record<string, unknown>,
            strict: true,
          },
        }
      : {
          format: { type: 'json_object' },
        };

    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model,
      input,
      stream: true,
      text: textFormat,
    };

    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_output_tokens = maxTokens;

    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
    let sdkStream: Awaited<ReturnType<typeof client.responses.create>>;

    try {
      sdkStream = await client.responses.create(params, {
        signal: ctl.signal,
        timeout: effectiveTimeoutMs,
      });
    } catch (err) {
      ctl.dispose();
      throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    let fullText = '';
    let finalUsage: LlmUsage | undefined;

    try {
      for await (const event of withStallTimeout(
        sdkStream as AsyncIterable<OpenAI.Responses.ResponseStreamEvent>,
        stallMs,
        ctl,
        PROVIDER
      )) {
        if (event.type === 'response.output_text.delta') {
          const delta = event.delta;
          if (delta !== undefined && delta.length > 0) {
            fullText += delta;
            yield { type: 'token', token: delta };
          }
        } else if (event.type === 'response.completed') {
          finalUsage = normalizeUsage(event.response.usage);
        }
      }
    } catch (err) {
      throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    } finally {
      ctl.dispose();
    }

    // Parse and validate the accumulated text — throw structured_parse_failed if invalid.
    let parsed: unknown;
    try {
      parsed = JSON.parse(fullText);
    } catch (err) {
      throw new LlmError({
        message: `OpenAI streamStructured: accumulated text is not valid JSON. Raw: ${fullText.slice(0, 200)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `OpenAI streamStructured: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    yield {
      type: 'done',
      data,
      usage: finalUsage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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
    const model = options?.model ?? resolvedConfig.model;
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
      idSource: 'provider' as const,
      usage: normalizeUsage(rawResponse.usage),
      latencyMs: Date.now() - start,
    };
  }

  /**
   * withTools() — native tool calling via the Responses API.
   *
   * Tool shape: flat FunctionTool (Tom §1.2):
   *   { type: 'function', name, description, parameters, strict: null }
   * NOT the Chat Completions nested shape { type:'function', function:{ name,... } }.
   *
   * parallelToolCalls → top-level parallel_tool_calls param on Responses API.
   * toolChoice 'any' → 'required' (Responses API doesn't have 'any'; 'required' is the equivalent).
   * Named tool → { type:'function', name: X } (Responses API ToolChoice).
   */
  async function withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    const model = options?.model ?? resolvedConfig.model;
    const input = buildResponsesInput(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    // Build Responses API FunctionTool array — flat shape (no nested function key)
    // Switch on the LlmToolSchema kind discriminant; 'openai' profile strips incompatible
    // keywords and enforces required[]
    const responseApiTools: OpenAI.Responses.FunctionTool[] = tools.map((t) => {
      let schemaForProvider: Record<string, unknown>;
      switch (t.inputSchema.kind) {
        case 'zod':
          schemaForProvider = toProviderSchema(t.inputSchema.schema, 'openai') as Record<
            string,
            unknown
          >;
          break;
        case 'jsonSchema':
          schemaForProvider = t.inputSchema.schema;
          break;
        default: {
          // Legacy-shape guard: catches old { parse: fn } callers post-v5 upgrade
          throw new LlmError({
            kind: 'tool_schema_invalid',
            message: `LlmTool "${(t as { name: string }).name}": inputSchema must have kind 'zod' or 'jsonSchema' (v5 migration: wrap Zod schemas as { kind: 'zod', schema } and JSON Schema objects as { kind: 'jsonSchema', schema })`,
            provider: PROVIDER,
            retryable: false,
          });
        }
      }
      return {
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: schemaForProvider as { [key: string]: unknown } | null,
        strict: null,
      };
    });

    // Map toolkit toolChoice to Responses API tool_choice.
    // Return type is the concrete union (not the optional param type) so that
    // exactOptionalPropertyTypes accepts the value inside the params object literal.
    function buildToolChoice(
      tc: LlmCallWithToolsOptions['toolChoice']
    ): OpenAI.Responses.ToolChoiceOptions | OpenAI.Responses.ToolChoiceFunction {
      if (tc === undefined || tc === 'auto') return 'auto';
      if (tc === 'none') return 'none';
      // 'any' → 'required' on Responses API (no 'any' equivalent)
      if (tc === 'any') return 'required';
      // Named tool
      return { type: 'function', name: tc.name };
    }

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
            model,
            input,
            stream: false,
            tools: responseApiTools,
            tool_choice: buildToolChoice(options?.toolChoice),
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_output_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // parallelToolCalls: false → parallel_tool_calls: false
          // undefined / true → omit (default is parallel-enabled)
          if (options?.parallelToolCalls === false) {
            params.parallel_tool_calls = false;
          }

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

    // Extract text content and tool calls from the response output
    const textParts: string[] = [];
    const toolCalls: LlmToolCall[] = [];

    for (const item of rawResponse.output) {
      if (item.type === 'message') {
        for (const contentItem of item.content) {
          if (contentItem.type === 'output_text') {
            textParts.push(contentItem.text);
          }
        }
      } else if (item.type === 'function_call') {
        // Responses API function_call output item: { type:'function_call', call_id, name, arguments }
        const rawArgs = item.arguments ?? '';
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch {
          parsedArgs = rawArgs; // leave as string if not valid JSON
        }

        // Validate against the tool's inputSchema
        const tool = tools.find((t) => t.name === item.name);
        if (tool !== undefined) {
          try {
            parsedArgs =
              tool.inputSchema.kind === 'zod'
                ? tool.inputSchema.schema.parse(parsedArgs)
                : tool.inputSchema.validate
                  ? tool.inputSchema.validate(parsedArgs)
                  : parsedArgs;
          } catch (err) {
            throw new LlmError({
              message: `OpenAI withTools: arguments for tool '${item.name}' failed schema validation. ${String(err)}`,
              provider: PROVIDER,
              kind: 'tool_arguments_invalid',
              retryable: false,
              cause: err,
            });
          }
        }

        toolCalls.push({
          id: item.call_id ?? `synth-${Date.now()}`,
          toolName: item.name ?? '',
          arguments: parsedArgs,
          rawArguments: rawArgs,
        });
      }
    }

    // Map Responses API status to LlmToolResponse.stopReason
    // Responses API stop reason lives on the response.status field or can be inferred
    // from the output content. If the last output is a function_call, stopReason is 'tool_use'.
    const hasToolCalls = toolCalls.length > 0;
    let stopReason: LlmToolResponse['stopReason'] = hasToolCalls ? 'tool_use' : 'end_turn';

    // Check for refusal in the output items
    for (const item of rawResponse.output) {
      if (item.type === 'message') {
        for (const contentItem of item.content) {
          if (contentItem.type === 'refusal') {
            stopReason = 'refusal';
          }
        }
      }
    }

    return {
      content: textParts.join(''),
      toolCalls,
      model: rawResponse.model,
      id: rawResponse.id,
      idSource: 'provider' as const,
      usage: normalizeUsage(rawResponse.usage),
      latencyMs: Date.now() - start,
      stopReason,
    };
  }

  // ─── Files API (v5.1.0) ──────────────────────────────────────────────────────

  /**
   * OpenAI Files API — upload and delete assets via the Responses API Files endpoint.
   *
   * OpenAI supports PDF uploads via purpose: 'user_data' (Responses API consumers).
   * If 'user_data' is rejected live, the fallback is 'assistants' — both work with
   * Responses API input_file consumption.
   *
   * Refs are immediately active on return (no async processing step).
   * waitForActive() and refresh() are no-ops.
   *
   * Video and image uploads are not supported — OpenAI Responses API does not expose
   * video input or Files API image references as of v5.1.0.
   */
  const files: LlmFilesApi = {
    async upload({
      data,
      mediaType,
      displayName,
    }: {
      data: Buffer | Uint8Array;
      mediaType: import('../types.js').LlmFileMediaType;
      displayName?: string;
    }): Promise<LlmFileRef> {
      // OpenAI Files API only supports PDF via the Responses API consumer path.
      // Video and image refs are not surfaced via Responses API input items.
      if (mediaType !== 'application/pdf') {
        throw new LlmError({
          message:
            `[llm-client] Provider 'openai' does not support media type '${mediaType}' via Files API.` +
            ` Only 'application/pdf' is accepted by the Responses API input_file item.`,
          provider: PROVIDER,
          kind: 'bad_request',
          retryable: false,
        });
      }

      const filename = displayName ?? 'upload.pdf';
      // Convert Buffer | Uint8Array to a typed Uint8Array to satisfy File constructor types.
      const fileBlob = new File([new Uint8Array(data)], filename, { type: mediaType });

      try {
        // purpose: 'user_data' is the correct value for Responses API consumers (late 2025).
        // Fast-follow fallback: if the live API rejects 'user_data', retry with 'assistants'.
        let response: OpenAI.FileObject;
        try {
          response = await client.files.create({
            file: fileBlob,
            purpose: 'user_data' as OpenAI.FilePurpose,
          });
        } catch (purposeErr) {
          // 'user_data' may not be accepted by older API versions — fall back to 'assistants'.
          if (
            purposeErr instanceof OpenAI.APIError &&
            purposeErr.status === 400 &&
            String(purposeErr.message).includes('purpose')
          ) {
            response = await client.files.create({
              file: fileBlob,
              purpose: 'assistants',
            });
          } else {
            throw purposeErr;
          }
        }

        return {
          id: response.id,
          // OpenAI references files by ID, not by URL — uri === id.
          uri: response.id,
          provider: 'openai' as const,
          mediaType,
          sizeBytes: response.bytes ?? (data as Buffer).length,
          state: 'active' as const,
          // OpenAI does not return an expiry for Files API objects
        };
      } catch (err) {
        if (err instanceof LlmError) throw err;
        throw normalizeOpenAIFilesError(err, 'upload');
      }
    },

    /**
     * OpenAI refs are always active on return — no async processing.
     * Resolves immediately with the same ref.
     */
    async refresh(ref: LlmFileRef): Promise<LlmFileRef> {
      if (ref.provider !== PROVIDER) {
        throw new LlmError({
          message: `[llm-client] LlmFileRef provider mismatch: ref is '${ref.provider}', client is '${PROVIDER}'.`,
          provider: PROVIDER,
          kind: 'bad_request',
          retryable: false,
        });
      }
      return ref;
    },

    /**
     * No-op for OpenAI — refs are always active on upload return.
     */
    async waitForActive(ref: LlmFileRef): Promise<LlmFileRef> {
      if (ref.provider !== PROVIDER) {
        throw new LlmError({
          message: `[llm-client] LlmFileRef provider mismatch: ref is '${ref.provider}', client is '${PROVIDER}'.`,
          provider: PROVIDER,
          kind: 'bad_request',
          retryable: false,
        });
      }
      return ref;
    },

    /**
     * Delete a file from OpenAI's file store. Swallows 404.
     */
    async delete(ref: LlmFileRef): Promise<void> {
      if (ref.provider !== PROVIDER) {
        throw new LlmError({
          message: `[llm-client] LlmFileRef provider mismatch: ref is '${ref.provider}', client is '${PROVIDER}'.`,
          provider: PROVIDER,
          kind: 'bad_request',
          retryable: false,
        });
      }
      /* v8 ignore start -- 404 swallow and error rethrow require SDK-level mock not available outside openai.test.ts */
      try {
        await client.files.delete(ref.id);
      } catch (err) {
        if (err instanceof OpenAI.NotFoundError) return;
        throw normalizeOpenAIFilesError(err, 'delete');
      }
      /* v8 ignore stop */
    },
  };

  return {
    config: resolvedConfig,
    files,
    complete,
    stream,
    structured,
    streamStructured,
    withTools,
  };
}

/**
 * Normalize Files API errors to LlmError.
 *
 * Same classification logic as the exported normalizeOpenAIError(), which is fully
 * covered by error-normalize.test.ts. This private variant cannot be unit-tested
 * independently (the OpenAI SDK client is constructed inside createOpenAIProvider and
 * is not mockable from outside without a full SDK mock context). The v8 ignore pragmas
 * on the inner branches prevent false coverage alarms on structurally-equivalent code.
 */
/* v8 ignore start */
function normalizeOpenAIFilesError(err: unknown, operation: string): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof OpenAI.APIConnectionError) {
    return new LlmError({
      message: `[llm-client] Files API network error: ${err.message} (${operation})`,
      provider: PROVIDER,
      kind: 'network',
      retryable: true,
      cause: err,
    });
  }

  if (err instanceof OpenAI.APIError && err.status !== undefined) {
    const kind = err.status >= 500 ? ('server_error' as const) : classifyHttpStatus(err.status);
    return new LlmError({
      message: `[llm-client] Files API server error: ${err.message} (${operation})`,
      provider: PROVIDER,
      statusCode: err.status,
      kind,
      retryable: kind === 'server_error',
      cause: err,
    });
  }

  return new LlmError({
    message: `[llm-client] Files API network error: ${String(err)} (${operation})`,
    provider: PROVIDER,
    kind: 'network',
    retryable: true,
    cause: err,
  });
}
/* v8 ignore stop */
