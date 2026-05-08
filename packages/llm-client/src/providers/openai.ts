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
 * Structured output uses OpenAI's response_format: { type: 'json_object' }.
 * For strict schema enforcement, the schema is described in the system prompt.
 */

import OpenAI from 'openai';
import { normalizeThrownError, withRetry } from '../retry.js';
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
  // APIConnectionError is a subclass of APIError with status: undefined — check it first
  // so network failures are always retryable regardless of the missing status code.
  if (typeof OpenAI.APIConnectionError === 'function' && err instanceof OpenAI.APIConnectionError) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      retryable: true,
      cause: err,
    });
  }

  // Catch all other APIError subclasses: RateLimitError (429), AuthenticationError (401),
  // InternalServerError (500), etc. Retryability is determined by HTTP status code.
  if (typeof OpenAI.APIError === 'function' && err instanceof OpenAI.APIError) {
    const status: number | undefined = err.status;
    if (status !== undefined) {
      const retryable = [429, 502, 503, 504].includes(status) || status >= 500;
      return new LlmError({
        message: err.message,
        provider: PROVIDER,
        statusCode: status,
        retryable,
        cause: err,
      });
    }
    return new LlmError({ message: err.message, provider: PROVIDER, retryable: false, cause: err });
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
    const start = Date.now();

    return withRetry(async () => {
      try {
        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
          model,
          messages: openAIMessages,
          stream: false,
        };

        const maxTokens = options?.maxTokens ?? config.maxTokens;
        if (maxTokens !== undefined) params.max_tokens = maxTokens;

        const temperature = options?.temperature ?? config.temperature;
        if (temperature !== undefined) params.temperature = temperature;

        const response = await client.chat.completions.create(params);

        const content = response.choices.map((c) => c.message.content ?? '').join('');

        return {
          content,
          model: response.model,
          usage: normalizeUsage(response.usage),
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        throw normalizeOpenAIError(err);
      }
    }, retryOpts);
  }

  async function* stream(
    messages: LlmMessage[],
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? config.model;
    const openAIMessages = buildOpenAIMessages(messages);

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model,
      messages: openAIMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_tokens = maxTokens;

    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    let sdkStream: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      sdkStream = await client.chat.completions.create(params);
    } catch (err) {
      throw normalizeOpenAIError(err);
    }

    let finalUsage: LlmUsage | undefined;

    try {
      for await (const chunk of sdkStream) {
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
      throw normalizeOpenAIError(err);
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
    // OpenAI JSON mode: response_format: { type: 'json_object' }
    // The system prompt must instruct the model to output JSON — OpenAI requires this.
    const jsonSystemInstruction: LlmMessage = {
      role: 'system',
      content:
        'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
    };

    const augmentedMessages = [jsonSystemInstruction, ...messages];
    const model = options?.model ?? config.model;
    const openAIMessages = buildOpenAIMessages(augmentedMessages);
    const start = Date.now();

    const rawResponse = await withRetry(async () => {
      try {
        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
          model,
          messages: openAIMessages,
          stream: false,
          response_format: { type: 'json_object' },
        };

        const maxTokens = options?.maxTokens ?? config.maxTokens;
        if (maxTokens !== undefined) params.max_tokens = maxTokens;

        const temperature = options?.temperature ?? config.temperature;
        if (temperature !== undefined) params.temperature = temperature;

        return await client.chat.completions.create(params);
      } catch (err) {
        throw normalizeOpenAIError(err);
      }
    }, retryOpts);

    const rawContent = rawResponse.choices[0]?.message.content ?? '';

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new LlmError({
        message: `OpenAI structured output: response is not valid JSON. Raw: ${rawContent.slice(0, 200)}`,
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
        message: `OpenAI structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
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
