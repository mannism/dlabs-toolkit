/**
 * DeepSeek provider for @diabolicallabs/llm-client.
 *
 * DeepSeek's chat completions API is fully OpenAI-compatible, so this provider
 * uses the OpenAI SDK pointed at DeepSeek's base URL.
 *
 * API base URL: https://api.deepseek.com
 * Docs: https://platform.deepseek.com/api-docs/
 *
 * Implements: complete(), stream(), structured()
 *
 * Token normalization:
 *   DeepSeek returns standard OpenAI-format usage: prompt_tokens / completion_tokens / total_tokens
 *   → LlmUsage: inputTokens / outputTokens / totalTokens
 *
 * Error mapping:
 *   APIConnectionError → retryable: true
 *   APIError with status 429 / 5xx → retryable: true
 *   Other APIErrors → non-retryable
 *
 * Note: DeepSeek does not support native schema mode. structured() always uses the
 * system-prompt + parse path (v0.3.0 behavior). Return shape gains model and id fields
 * in v0.4.0 for parity with strict-mode providers.
 */

import OpenAI from 'openai';
import { classifyAbort, createAttemptController, withStallTimeout } from '../abort.js';
import { parseJsonOrThrow } from '../extract-json.js';
import { isZodSchema, type JsonNode, toProviderSchema } from '../json-schema.js';
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

const PROVIDER = 'deepseek';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** Normalize OpenAI-format usage object to LlmUsage. */
function normalizeUsage(usage: OpenAI.CompletionUsage | undefined | null): LlmUsage {
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
  };
}

/** Convert LlmMessages to OpenAI-format chat message params (compatible with DeepSeek). */
function buildMessages(messages: LlmMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * Normalize any DeepSeek / OpenAI SDK error into LlmError.
 * Exported for direct unit testing of the normalization logic.
 *
 * Uses the same OpenAI SDK error hierarchy (APIConnectionError before APIError)
 * since the client is an OpenAI instance pointed at DeepSeek's API.
 */
export function normalizeDeepSeekError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // APIConnectionError is a subclass of APIError with status: undefined —
  // check it first so network failures are always retryable.
  if (typeof OpenAI.APIConnectionError === 'function' && err instanceof OpenAI.APIConnectionError) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      kind: 'network',
      retryable: true,
      cause: err,
    });
  }

  // Catch all other APIError subclasses: RateLimitError (429), AuthenticationError (401), etc.
  // Classify to specific LlmErrorKind via HTTP status.
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

/** Create the DeepSeek provider implementation. */
export function createDeepSeekProvider(config: LlmClientConfig): LlmClient {
  // Providers always receive model as a string (client.ts resolves arrays before dispatch).
  const resolvedModel = Array.isArray(config.model) ? config.model[0]! : config.model;
  const resolvedConfig = { ...config, model: resolvedModel } as LlmClientConfig & {
    model: string;
  };

  // OpenAI SDK pointed at DeepSeek's OpenAI-compatible endpoint
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // Retries managed by withRetry
  });

  const retryOpts = {
    maxRetries: config.maxRetries ?? 3,
    baseDelayMs: config.baseDelayMs ?? 1_000,
    provider: PROVIDER,
    ...(config.retry !== undefined && { retryConfig: config.retry }),
  };

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model ?? resolvedConfig.model;
    const chatMessages = buildMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    return withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: chatMessages,
            stream: false,
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          const response = await client.chat.completions.create(params, { signal: ctl.signal });
          const content = response.choices.map((c) => c.message.content ?? '').join('');

          return {
            content,
            model: response.model,
            id: response.id,
            idSource: 'provider' as const,
            usage: normalizeUsage(response.usage),
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          throw normalizeDeepSeekError(classifyAbort(err, ctl.abortReason(), PROVIDER));
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
    const chatMessages = buildMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: chatMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_tokens = maxTokens;

    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
    let sdkStream: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      sdkStream = await client.chat.completions.create(params, { signal: ctl.signal });
    } catch (err) {
      ctl.dispose();
      throw normalizeDeepSeekError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    let finalUsage: LlmUsage | undefined;

    try {
      for await (const chunk of withStallTimeout(sdkStream, stallMs, ctl, PROVIDER)) {
        const delta = chunk.choices[0]?.delta.content;
        if (delta !== undefined && delta !== null && delta.length > 0) {
          yield { token: delta };
        }

        // Usage arrives in the final chunk when stream_options.include_usage is true
        if (chunk.usage !== undefined && chunk.usage !== null) {
          finalUsage = normalizeUsage(chunk.usage);
        }
      }
    } catch (err) {
      throw normalizeDeepSeekError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    } finally {
      ctl.dispose();
    }

    if (finalUsage !== undefined) {
      yield { token: '', usage: finalUsage };
    }
  }

  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    // Inject JSON-only system instruction. DeepSeek does not guarantee json_object
    // response_format support across all models, so we rely on prompt-level enforcement.
    const jsonSystemInstruction: LlmMessage = {
      role: 'system',
      content:
        'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
    };

    const augmentedMessages = [jsonSystemInstruction, ...messages];
    const model = options?.model ?? resolvedConfig.model;
    const chatMessages = buildMessages(augmentedMessages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: chatMessages,
            stream: false,
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          return await client.chat.completions.create(params, { signal: ctl.signal });
        } catch (err) {
          throw normalizeDeepSeekError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    const rawContent = rawResponse.choices[0]?.message.content ?? '';

    let parsed: unknown;
    try {
      // Strip markdown fences if the model included them despite the instruction
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new LlmError({
        message: `DeepSeek structured output: response is not valid JSON. Raw: ${rawContent.slice(0, 200)}`,
        provider: PROVIDER,
        retryable: false,
        cause: err,
      });
    }

    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `DeepSeek structured output: response failed schema validation. ${String(err)}`,
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
   * withTools() — tool calling via Chat Completions (DeepSeek Chat Completions API).
   *
   * Tool shape: Chat Completions nested shape (Tom §4.3):
   *   { type: 'function', function: { name, description, parameters } }
   * NOT the Responses API flat shape — DeepSeek does not support the Responses API.
   *
   * deepseek-chat (V3) supports tool calling.
   * deepseek-reasoner (R1) has limited tool calling support — behavior may differ.
   * Document this limitation in README but do not block the call.
   */
  async function withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    const model = options?.model ?? resolvedConfig.model;
    const chatMessages = buildMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    // Build Chat Completions tool array — nested function key (NOT Responses API flat shape)
    const chatTools: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => {
      const parameters = isZodSchema(t.inputSchema)
        ? (toProviderSchema(t.inputSchema as import('zod').ZodType, 'openai') as JsonNode)
        : (t.inputSchema as unknown as JsonNode);
      return {
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: parameters as Record<string, unknown>,
        },
      };
    });

    // Map toolChoice to Chat Completions format
    function buildToolChoice():
      | 'auto'
      | 'none'
      | 'required'
      | OpenAI.Chat.ChatCompletionNamedToolChoice {
      const tc = options?.toolChoice;
      if (tc === undefined || tc === 'auto') return 'auto';
      if (tc === 'none') return 'none';
      if (tc === 'any') return 'required';
      return { type: 'function', function: { name: tc.name } };
    }

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: chatMessages,
            stream: false,
            tools: chatTools,
            tool_choice: buildToolChoice(),
          };

          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) params.max_tokens = maxTokens;

          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          if (options?.parallelToolCalls === false) {
            params.parallel_tool_calls = false;
          }

          return await client.chat.completions.create(params, { signal: ctl.signal });
        } catch (err) {
          throw normalizeDeepSeekError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    // Extract text content and tool calls from Chat Completions response
    const choice = rawResponse.choices[0];
    const content = choice?.message.content ?? '';
    const toolCalls: LlmToolCall[] = [];

    for (const tc of choice?.message.tool_calls ?? []) {
      // ChatCompletionMessageToolCall union includes ChatCompletionMessageCustomToolCall
      // which has no .function property. Narrow to the standard function call type.
      if (tc.type !== 'function') continue;
      const fn = tc.function;
      const rawArgs = fn.arguments;
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        parsedArgs = rawArgs;
      }

      const tool = tools.find((t) => t.name === fn.name);
      if (tool !== undefined) {
        try {
          parsedArgs = tool.inputSchema.parse(parsedArgs);
        } catch (err) {
          throw new LlmError({
            message: `DeepSeek withTools: arguments for tool '${fn.name}' failed schema validation. ${String(err)}`,
            provider: PROVIDER,
            kind: 'tool_arguments_invalid',
            retryable: false,
            cause: err,
          });
        }
      }

      toolCalls.push({
        id: tc.id,
        toolName: fn.name,
        arguments: parsedArgs,
        rawArguments: rawArgs,
      });
    }

    // Map Chat Completions finish_reason to LlmToolResponse.stopReason
    function mapFinishReason(reason: string | null | undefined): LlmToolResponse['stopReason'] {
      switch (reason) {
        case 'tool_calls':
          return 'tool_use';
        case 'stop':
          return 'end_turn';
        case 'length':
          return 'max_tokens';
        case 'content_filter':
          return 'content_filter';
        default:
          return toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      }
    }

    return {
      content,
      toolCalls,
      model: rawResponse.model,
      id: rawResponse.id,
      idSource: 'provider' as const,
      usage: normalizeUsage(rawResponse.usage),
      latencyMs: Date.now() - start,
      stopReason: mapFinishReason(choice?.finish_reason),
    };
  }

  /**
   * streamStructured() — stream tokens from Chat Completions and validate at end (v1.3.0+).
   *
   * DeepSeek supports json_object response_format on Chat Completions stream.
   * We also inject a system-prompt JSON instruction as a second layer of enforcement,
   * since DeepSeek does not support full json_schema strict mode.
   *
   * Tokens arrive as choices[0].delta.content chunks. We accumulate and parse at end.
   * If JSON.parse fails on the accumulated text, we fall back to parseJsonOrThrow
   * (handles markdown fences and prose wrapping). schema.parse() validates the result.
   *
   * deepseek-reasoner (R1) note: reasoning models may emit chain-of-thought text before
   * the JSON object. The parseJsonOrThrow fallback handles this by extracting the first
   * JSON block from the accumulated text.
   */
  async function* streamStructured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    const jsonSystemInstruction: LlmMessage = {
      role: 'system',
      content:
        'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
    };
    const augmentedMessages = [jsonSystemInstruction, ...messages];

    const model = options?.model ?? resolvedConfig.model;
    const chatMessages = buildMessages(augmentedMessages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: chatMessages,
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
    };

    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_tokens = maxTokens;

    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
    let sdkStream: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      sdkStream = await client.chat.completions.create(params, { signal: ctl.signal });
    } catch (err) {
      ctl.dispose();
      throw normalizeDeepSeekError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    let fullText = '';
    let finalUsage: LlmUsage | undefined;

    try {
      for await (const chunk of withStallTimeout(sdkStream, stallMs, ctl, PROVIDER)) {
        const delta = chunk.choices[0]?.delta.content;
        if (delta !== undefined && delta !== null && delta.length > 0) {
          fullText += delta;
          yield { type: 'token', token: delta };
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          finalUsage = normalizeUsage(chunk.usage);
        }
      }
    } catch (err) {
      throw normalizeDeepSeekError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    } finally {
      ctl.dispose();
    }

    // First try a direct JSON.parse. If that fails (e.g. reasoner chain-of-thought prefix),
    // fall back to parseJsonOrThrow which extracts the first JSON block from prose or fences.
    let parsed: unknown;
    try {
      parsed = JSON.parse(fullText);
    } catch {
      // parseJsonOrThrow throws LlmError(structured_parse_failed) if no JSON block found
      parsed = parseJsonOrThrow(fullText, PROVIDER);
    }

    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `DeepSeek streamStructured: response failed schema validation. ${String(err)}`,
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

  return {
    config: resolvedConfig,
    complete,
    stream,
    structured,
    streamStructured,
    withTools,
  };
}
