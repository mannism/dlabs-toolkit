/**
 * Anthropic Claude provider for @diabolicallabs/llm-client.
 *
 * Implements: complete(), stream(), structured()
 *
 * Token normalisation:
 *   Anthropic: input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens
 *   → LlmUsage: inputTokens / outputTokens / totalTokens / cacheCreationTokens / cacheReadTokens
 *
 * Error mapping:
 *   APIStatusError.status → LlmError.statusCode + retryable flag
 *   APIConnectionError → retryable: true
 */

import Anthropic from '@anthropic-ai/sdk';
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

const PROVIDER = 'anthropic';

/** Normalise Anthropic's usage object to LlmUsage. */
function normaliseUsage(usage: Anthropic.Usage | undefined): LlmUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    // cache_creation_input_tokens and cache_read_input_tokens are present on
    // extended usage objects from prompt caching — cast to access them safely.
    cacheCreationTokens: (usage as Anthropic.Usage & { cache_creation_input_tokens?: number })
      ?.cache_creation_input_tokens,
    cacheReadTokens: (usage as Anthropic.Usage & { cache_read_input_tokens?: number })
      ?.cache_read_input_tokens,
  };
}

/** Convert LlmMessages to Anthropic's message format. Extracts system prompt. */
function buildAnthropicMessages(messages: LlmMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  const system =
    systemMessages.length > 0 ? systemMessages.map((m) => m.content).join('\n') : undefined;

  const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  return { system, messages: anthropicMessages };
}

/**
 * Normalise any Anthropic SDK error into LlmError.
 * Exported for direct unit testing of the normalisation logic.
 */
export function normaliseAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // Anthropic SDK v0.94+: uses Anthropic.APIError as the base class with a `.status` field.
  // APIConnectionError is a subclass of APIError with status: undefined — check it first
  // so network failures are always retryable regardless of the missing status code.
  if (
    typeof Anthropic.APIConnectionError === 'function' &&
    err instanceof Anthropic.APIConnectionError
  ) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      retryable: true,
      cause: err,
    });
  }

  // Catch all other APIError subclasses: RateLimitError (429), AuthenticationError (401),
  // InternalServerError (500), etc. Retryability is determined by HTTP status code.
  if (typeof Anthropic.APIError === 'function' && err instanceof Anthropic.APIError) {
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

/** Create the Anthropic provider implementation. */
export function createAnthropicProvider(config: LlmClientConfig): LlmClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // We manage retries ourselves via withRetry
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
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);

    const start = Date.now();

    return withRetry(async () => {
      try {
        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model,
          messages: anthropicMessages,
          max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
        };

        if (system !== undefined) params.system = system;
        const temperature = options?.temperature ?? config.temperature;
        if (temperature !== undefined) {
          params.temperature = temperature;
        }

        const response = await client.messages.create(params);

        const content = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');

        return {
          content,
          model: response.model,
          usage: normaliseUsage(response.usage),
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        throw normaliseAnthropicError(err);
      }
    }, retryOpts);
  }

  async function* stream(
    messages: LlmMessage[],
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? config.model;
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);

    const params: Anthropic.MessageStreamParams = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
    };

    if (system !== undefined) params.system = system;
    const streamTemperature = options?.temperature ?? config.temperature;
    if (streamTemperature !== undefined) {
      params.temperature = streamTemperature;
    }

    let sdkStream: Awaited<ReturnType<typeof client.messages.stream>>;

    try {
      sdkStream = client.messages.stream(params);
    } catch (err) {
      throw normaliseAnthropicError(err);
    }

    // Accumulate usage — Anthropic sends it in the message_delta event at stream end
    let finalUsage: LlmUsage | undefined;

    try {
      for await (const event of sdkStream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { token: event.delta.text };
        } else if (event.type === 'message_delta' && 'usage' in event) {
          // Merge input tokens from message_start with output tokens from message_delta
          const accum = await sdkStream.finalMessage();
          finalUsage = normaliseUsage(accum.usage);
        }
      }
    } catch (err) {
      // Propagate as a normalised LlmError regardless of whether streaming had started.
      // Partial stream errors cannot be recovered from — the consumer must handle them.
      throw normaliseAnthropicError(err);
    }

    // Yield usage on the final empty chunk
    if (finalUsage !== undefined) {
      yield { token: '', usage: finalUsage };
    }
  }

  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): Promise<LlmStructuredResponse<T>> {
    // Anthropic JSON mode: append a system instruction to return only JSON.
    // We inject this into the messages so the provider returns parseable output.
    const jsonSystemInstruction: LlmMessage = {
      role: 'system',
      content:
        'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
    };

    const augmentedMessages = [jsonSystemInstruction, ...messages];
    const start = Date.now();

    const response = await complete(augmentedMessages, options);

    let parsed: unknown;
    try {
      // Strip markdown code fences if the model included them despite the instruction
      const cleaned = response.content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new LlmError({
        message: `Anthropic structured output: response is not valid JSON. Raw: ${response.content.slice(0, 200)}`,
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
        message: `Anthropic structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      usage: response.usage,
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
