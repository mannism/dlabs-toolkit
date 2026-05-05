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
 * Token normalisation:
 *   DeepSeek returns standard OpenAI-format usage: prompt_tokens / completion_tokens / total_tokens
 *   → LlmUsage: inputTokens / outputTokens / totalTokens
 *
 * Error mapping:
 *   APIConnectionError → retryable: true
 *   APIError with status 429 / 5xx → retryable: true
 *   Other APIErrors → non-retryable
 *
 * Note: DeepSeek does not support the json_object response_format on all models.
 * structured() injects a system prompt and parses the raw response. If the model
 * includes markdown fences, they are stripped before parsing.
 */

import OpenAI from 'openai';
import { normaliseThrownError, withRetry } from '../retry.js';
import type {
  LlmClient,
  LlmClientConfig,
  LlmMessage,
  LlmResponse,
  LlmStreamChunk,
  LlmStructuredResponse,
  LlmUsage,
} from '../types.js';
import { LlmError } from '../types.js';

const PROVIDER = 'deepseek';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

/** Normalise OpenAI-format usage object to LlmUsage. */
function normaliseUsage(usage: OpenAI.CompletionUsage | undefined | null): LlmUsage {
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
 * Normalise any DeepSeek / OpenAI SDK error into LlmError.
 * Exported for direct unit testing of the normalisation logic.
 *
 * Uses the same OpenAI SDK error hierarchy (APIConnectionError before APIError)
 * since the client is an OpenAI instance pointed at DeepSeek's API.
 */
export function normaliseDeepSeekError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // APIConnectionError is a subclass of APIError with status: undefined —
  // check it first so network failures are always retryable.
  if (typeof OpenAI.APIConnectionError === 'function' && err instanceof OpenAI.APIConnectionError) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      retryable: true,
      cause: err,
    });
  }

  // Catch all other APIError subclasses: RateLimitError (429), AuthenticationError (401), etc.
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

  return normaliseThrownError(err, PROVIDER);
}

/** Create the DeepSeek provider implementation. */
export function createDeepSeekProvider(config: LlmClientConfig): LlmClient {
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
  };

  async function complete(
    messages: LlmMessage[],
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): Promise<LlmResponse> {
    const model = options?.model ?? config.model;
    const chatMessages = buildMessages(messages);
    const start = Date.now();

    return withRetry(async () => {
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

        const response = await client.chat.completions.create(params);
        const content = response.choices.map((c) => c.message.content ?? '').join('');

        return {
          content,
          model: response.model,
          usage: normaliseUsage(response.usage),
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        throw normaliseDeepSeekError(err);
      }
    }, retryOpts);
  }

  async function* stream(
    messages: LlmMessage[],
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? config.model;
    const chatMessages = buildMessages(messages);

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

    let sdkStream: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      sdkStream = await client.chat.completions.create(params);
    } catch (err) {
      throw normaliseDeepSeekError(err);
    }

    let finalUsage: LlmUsage | undefined;

    try {
      for await (const chunk of sdkStream) {
        const delta = chunk.choices[0]?.delta.content;
        if (delta !== undefined && delta !== null && delta.length > 0) {
          yield { token: delta };
        }

        // Usage arrives in the final chunk when stream_options.include_usage is true
        if (chunk.usage !== undefined && chunk.usage !== null) {
          finalUsage = normaliseUsage(chunk.usage);
        }
      }
    } catch (err) {
      throw normaliseDeepSeekError(err);
    }

    if (finalUsage !== undefined) {
      yield { token: '', usage: finalUsage };
    }
  }

  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): Promise<LlmStructuredResponse<T>> {
    // Inject JSON-only system instruction. DeepSeek does not guarantee json_object
    // response_format support across all models, so we rely on prompt-level enforcement.
    const jsonSystemInstruction: LlmMessage = {
      role: 'system',
      content:
        'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
    };

    const augmentedMessages = [jsonSystemInstruction, ...messages];
    const model = options?.model ?? config.model;
    const chatMessages = buildMessages(augmentedMessages);
    const start = Date.now();

    const rawResponse = await withRetry(async () => {
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

        return await client.chat.completions.create(params);
      } catch (err) {
        throw normaliseDeepSeekError(err);
      }
    }, retryOpts);

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
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      usage: normaliseUsage(rawResponse.usage),
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
