/**
 * Perplexity provider for @diabolicallabs/llm-client.
 *
 * Perplexity's chat completions API is OpenAI-compatible, so this provider
 * uses the OpenAI SDK pointed at Perplexity's base URL — same pattern as DeepSeek.
 *
 * API base URL: https://api.perplexity.ai
 * Docs: https://docs.perplexity.ai
 *
 * Implements: complete(), stream(), structured()
 *
 * Key Perplexity behaviors:
 *   - Responses include a `citations` field: string[] of source URLs.
 *     We map each URL to { url: string } and deduplicate by URL before returning.
 *   - Citations are only available on non-streaming responses. The streaming API
 *     does not include citations in individual chunks; consumers needing citations
 *     must use complete(), not stream().
 *   - Default model: 'sonar' — the lightweight search model (sonar-reasoning was
 *     deprecated Dec 2025; sonar-reasoning-pro is its replacement).
 *
 * Model notes (confirmed against live API 2026-05-08):
 *   - sonar               — lightweight search, web-grounded
 *   - sonar-pro           — advanced search, more citations
 *   - sonar-reasoning-pro — chain-of-thought reasoning (sonar-reasoning deprecated)
 *   - sonar-deep-research — exhaustive research; supports async jobs. Perplexity's
 *                           docs note this model "supports asynchronous jobs" which
 *                           may mean a different response shape. We treat it as a
 *                           standard synchronous model; if the API returns an
 *                           incompatible shape, complete() will throw a clear LlmError
 *                           directing users to sonar-reasoning-pro or the async API.
 *
 * providerOptions (Wave 2 escape hatch):
 *   The Perplexity API supports search-specific parameters not present on other providers.
 *   Pass them via options.providerOptions:
 *     search_recency_filter: 'month' | 'week' | 'day' | 'hour'
 *     search_domain_filter: string[]   — allowlist of domains to source from
 *   Unknown fields are passed through unchanged to support future Perplexity API additions.
 *
 * structured() strategy:
 *   Perplexity's response_format handling has limitations (especially on reasoning models
 *   where reasoning tokens appear before JSON output). We use system-prompt JSON instruction
 *   (same as DeepSeek) and strip both <think>...</think> reasoning blocks (sonar-reasoning-pro)
 *   and markdown fences before JSON.parse().
 *
 * Token normalization:
 *   Perplexity returns standard OpenAI-format usage: prompt_tokens / completion_tokens / total_tokens
 *   → LlmUsage: inputTokens / outputTokens / totalTokens
 *
 * Error mapping:
 *   APIConnectionError → retryable: true
 *   APIError with status 429 / 5xx → retryable: true
 *   Other APIErrors → non-retryable
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

const PROVIDER = 'perplexity';
const PERPLEXITY_BASE_URL = 'https://api.perplexity.ai';

/**
 * Perplexity-specific fields that may appear on the OpenAI-compatible response object.
 * The SDK types don't include these; we cast and extract them safely.
 */
interface PerplexityResponseExtensions {
  citations?: string[];
}

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

/** Convert LlmMessages to OpenAI-format chat message params. */
function buildMessages(messages: LlmMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

/**
 * Extract and deduplicate citations from a Perplexity response.
 *
 * Perplexity returns citations as string[] of URLs on the response object
 * (not in the OpenAI SDK types — accessed via cast). Deduplication is by URL.
 * Returns undefined if no citations are present or the array is empty.
 */
function extractCitations(
  response: OpenAI.Chat.ChatCompletion & PerplexityResponseExtensions
): LlmResponse['citations'] {
  const rawCitations = response.citations;
  if (rawCitations === undefined || rawCitations.length === 0) return undefined;

  const seen = new Set<string>();
  const deduped: Array<{ url: string; title?: string }> = [];

  for (const url of rawCitations) {
    if (!seen.has(url)) {
      seen.add(url);
      deduped.push({ url });
    }
  }

  return deduped.length > 0 ? deduped : undefined;
}

/**
 * Extract known Perplexity search filter fields from providerOptions.
 * Unknown fields are passed through to the API params unchanged.
 *
 * Known fields at time of implementation (2026-05-08):
 *   search_recency_filter: 'month' | 'week' | 'day' | 'hour'
 *   search_domain_filter: string[]
 */
function extractProviderOptions(
  providerOptions: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (providerOptions === undefined) return {};
  // Pass all fields through — Perplexity may add new filters; unknown fields
  // are forwarded unchanged so consumers don't need a toolkit update to use them.
  return { ...providerOptions };
}

/**
 * Normalize any Perplexity / OpenAI SDK error into LlmError.
 * Exported for direct unit testing of the normalization logic.
 *
 * Uses the same OpenAI SDK error hierarchy since the client is an OpenAI
 * instance pointed at Perplexity's API.
 */
export function normalizePerplexityError(err: unknown): LlmError {
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

  return normalizeThrownError(err, PROVIDER);
}

/** Create the Perplexity provider implementation. */
export function createPerplexityProvider(config: LlmClientConfig): LlmClient {
  // OpenAI SDK pointed at Perplexity's OpenAI-compatible endpoint
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: PERPLEXITY_BASE_URL,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // Retries managed by withRetry
  });

  const retryOpts = {
    maxRetries: config.maxRetries ?? 3,
    baseDelayMs: config.baseDelayMs ?? 1_000,
    provider: PROVIDER,
  };

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model ?? config.model;
    const chatMessages = buildMessages(messages);
    const start = Date.now();
    const extraParams = extractProviderOptions(options?.providerOptions);

    return withRetry(async () => {
      try {
        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, unknown> =
          {
            model,
            messages: chatMessages,
            stream: false,
            ...extraParams,
          };

        const maxTokens = options?.maxTokens ?? config.maxTokens;
        if (maxTokens !== undefined) params.max_tokens = maxTokens;

        const temperature = options?.temperature ?? config.temperature;
        if (temperature !== undefined) params.temperature = temperature;

        const rawResponse = await client.chat.completions.create(
          params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
        );

        // Cast to access Perplexity-specific extensions not present in OpenAI SDK types
        const response = rawResponse as OpenAI.Chat.ChatCompletion & PerplexityResponseExtensions;

        const content = response.choices.map((c) => c.message.content ?? '').join('');

        const result: LlmResponse = {
          content,
          model: response.model,
          usage: normalizeUsage(response.usage),
          latencyMs: Date.now() - start,
        };

        const citations = extractCitations(response);
        if (citations !== undefined) result.citations = citations;

        return result;
      } catch (err) {
        throw normalizePerplexityError(err);
      }
    }, retryOpts);
  }

  async function* stream(
    messages: LlmMessage[],
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? config.model;
    const chatMessages = buildMessages(messages);
    const extraParams = extractProviderOptions(options?.providerOptions);

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming & Record<string, unknown> = {
      model,
      messages: chatMessages,
      stream: true,
      stream_options: { include_usage: true },
      ...extraParams,
    };

    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_tokens = maxTokens;

    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    let sdkStream: Awaited<ReturnType<typeof client.chat.completions.create>>;

    try {
      sdkStream = await client.chat.completions.create(
        params as OpenAI.Chat.ChatCompletionCreateParamsStreaming
      );
    } catch (err) {
      throw normalizePerplexityError(err);
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
          finalUsage = normalizeUsage(chunk.usage);
        }
      }
    } catch (err) {
      throw normalizePerplexityError(err);
    }

    // Note: citations are NOT available in streaming mode. Perplexity's streaming
    // API does not include citations in the chunk stream. Use complete() if citations
    // are required for your use case.
    if (finalUsage !== undefined) {
      yield { token: '', usage: finalUsage };
    }
  }

  async function structured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    // Perplexity's response_format has limitations with reasoning models (reasoning tokens
    // appear before JSON output). Use system-prompt JSON instruction + fence stripping,
    // same as DeepSeek.
    const jsonSystemInstruction: LlmMessage = {
      role: 'system',
      content:
        'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
    };

    const augmentedMessages = [jsonSystemInstruction, ...messages];
    const model = options?.model ?? config.model;
    const chatMessages = buildMessages(augmentedMessages);
    const start = Date.now();
    const extraParams = extractProviderOptions(options?.providerOptions);

    const rawResponse = await withRetry(async () => {
      try {
        const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & Record<string, unknown> =
          {
            model,
            messages: chatMessages,
            stream: false,
            ...extraParams,
          };

        const maxTokens = options?.maxTokens ?? config.maxTokens;
        if (maxTokens !== undefined) params.max_tokens = maxTokens;

        const temperature = options?.temperature ?? config.temperature;
        if (temperature !== undefined) params.temperature = temperature;

        return await client.chat.completions.create(
          params as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
        );
      } catch (err) {
        throw normalizePerplexityError(err);
      }
    }, retryOpts);

    const rawContent = rawResponse.choices[0]?.message.content ?? '';

    let parsed: unknown;
    try {
      // sonar-reasoning-pro emits reasoning tokens inside <think>...</think> before the JSON.
      // Strip them first, then strip any markdown fences.
      const cleaned = rawContent
        .replace(/<think>[\s\S]*?<\/think>/i, '') // strip reasoning block (sonar-reasoning-pro)
        .replace(/^```(?:json)?\s*/i, '') // strip opening fence
        .replace(/\s*```$/, '') // strip closing fence
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new LlmError({
        message: `Perplexity structured output: response is not valid JSON. Raw: ${rawContent.slice(0, 200)}`,
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
        message: `Perplexity structured output: response failed schema validation. ${String(err)}`,
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
