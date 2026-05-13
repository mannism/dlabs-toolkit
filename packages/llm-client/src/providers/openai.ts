/**
 * OpenAI provider for @diabolicallabs/llm-client.
 *
 * Implements: complete(), stream(), structured()
 *
 * Token normalization:
 *   OpenAI: prompt_tokens / completion_tokens
 *   → LlmUsage: inputTokens / outputTokens / totalTokens
 *
 * Error mapping:
 *   APIStatusError.status → LlmError.statusCode + retryable flag
 *   APIConnectionError → retryable: true
 *
 * Structured output (v0.4.0):
 *   Zod 4 schema detected → response_format: { type: 'json_schema', strict: true }
 *   Non-Zod schema or providerOptions.structuredMode === 'prompt' → json_object fallback.
 *   Note: openai SDK v6.36 does not export zodResponseFormat; the literal response_format
 *   shape is used directly (stable since SDK v4.55).
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

/** Normalize OpenAI's usage object to LlmUsage. */
function normalizeUsage(usage: OpenAI.CompletionUsage | undefined | null): LlmUsage {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
  };
}

/** Convert LlmMessages to OpenAI's chat message format. */
function buildOpenAIMessages(messages: LlmMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * Normalize any OpenAI SDK error into LlmError.
 * Exported for direct unit testing of the normalization logic.
 */
export function normalizeOpenAIError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // OpenAI SDK v6+: uses OpenAI.APIError as the base class with a `.status` field.
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

/** Create the OpenAI provider implementation. */
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
    const openAIMessages = buildOpenAIMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    return withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: openAIMessages,
            stream: false,
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_completion_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // timeout: effectiveTimeoutMs overrides the SDK socket deadline for this call,
          // ensuring the per-call budget matches the AbortController budget (Fix A, v0.4.2).
          const response = await client.chat.completions.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
          });

          const content = response.choices.map((c) => c.message.content ?? '').join('');

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
    const openAIMessages = buildOpenAIMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: openAIMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_completion_tokens = maxTokens;

    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
    let sdkStream: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      // timeout: effectiveTimeoutMs overrides the SDK socket deadline for this call (Fix A, v0.4.2).
      sdkStream = await client.chat.completions.create(params, {
        signal: ctl.signal,
        timeout: effectiveTimeoutMs,
      });
    } catch (err) {
      ctl.dispose();
      throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    let finalUsage: LlmUsage | undefined;

    try {
      for await (const chunk of withStallTimeout(sdkStream, stallMs, ctl, PROVIDER)) {
        // Token chunks arrive in choices[0].delta.content
        const delta = chunk.choices[0]?.delta.content;
        if (delta !== undefined && delta !== null && delta.length > 0) {
          yield { token: delta };
        }

        // Usage arrives in the final chunk (stream_options.include_usage must be true)
        if (chunk.usage !== undefined && chunk.usage !== null) {
          finalUsage = normalizeUsage(chunk.usage);
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

    // ── Strict path: response_format: { type: 'json_schema', strict: true } ──
    const jsonSchema = toProviderSchema(schema, 'openai');
    const model = options?.model ?? config.model;
    const openAIMessages = buildOpenAIMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          // Literal json_schema response_format shape, stable since OpenAI SDK v4.55.
          // SDK v6.36 (our pin) does not export zodResponseFormat; we pass the literal directly.
          // Use a type intersection to satisfy exactOptionalPropertyTypes: the property is
          // defined as optional on the SDK params type, but we require it to be present here.
          type StrictParams = Omit<
            OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
            'response_format'
          > & {
            response_format: OpenAI.ResponseFormatJSONSchema;
          };
          const params: StrictParams = {
            model,
            messages: openAIMessages,
            stream: false,
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'response', schema: jsonSchema, strict: true },
            },
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_completion_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // StrictParams is structurally compatible with ChatCompletionCreateParamsNonStreaming
          // (it is a narrowing of that type, not a widening). Cast is safe.
          // timeout: effectiveTimeoutMs overrides the SDK socket deadline (Fix A, v0.4.2).
          return await client.chat.completions.create(
            params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
            { signal: ctl.signal, timeout: effectiveTimeoutMs }
          );
        } catch (err) {
          throw normalizeOpenAIError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    // Check for model refusal — strict mode can return a refusal instead of content
    const choice = rawResponse.choices[0];
    if (choice?.message.refusal !== null && choice?.message.refusal !== undefined) {
      throw new LlmError({
        message: `OpenAI structured output: model refused to generate. Refusal: ${choice.message.refusal.slice(0, 200)}`,
        provider: PROVIDER,
        retryable: false,
        kind: 'unknown',
      });
    }

    const rawContent = choice?.message.content ?? '';

    let parsed: unknown;
    try {
      // Strict mode guarantees valid JSON, but parse defensively
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new LlmError({
        message: `OpenAI structured output: response is not valid JSON. Raw: ${rawContent.slice(0, 200)}`,
        provider: PROVIDER,
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
   * providerOptions.structuredMode === 'prompt'. Preserves v0.3.0 behavior exactly.
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
    const openAIMessages = buildOpenAIMessages(augmentedMessages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: openAIMessages,
            stream: false,
            response_format: { type: 'json_object' },
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_completion_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // timeout: effectiveTimeoutMs overrides the SDK socket deadline (Fix A, v0.4.2).
          return await client.chat.completions.create(params, {
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

    const rawContent = rawResponse.choices[0]?.message.content ?? '';

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
