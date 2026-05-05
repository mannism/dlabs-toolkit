/**
 * Google Gemini provider for @diabolicallabs/llm-client.
 *
 * Uses the @google/genai SDK (v1.x — not the deprecated @google/generative-ai).
 *
 * Implements: complete(), stream(), structured()
 *
 * Token normalisation:
 *   Gemini: usageMetadata.promptTokenCount / candidatesTokenCount / totalTokenCount
 *   → LlmUsage: inputTokens / outputTokens / totalTokens
 *
 * Error mapping:
 *   ApiError (public SDK class, status: number always defined):
 *     retryable for 429 / 5xx
 *     non-retryable for 4xx (except 429)
 *   Other errors → normaliseThrownError (handles ECONNRESET / ETIMEDOUT as retryable)
 *
 * API notes:
 *   - System instructions are passed via config.systemInstruction (not mixed into contents)
 *   - Role mapping: 'user' → 'user', 'assistant' → 'model'
 *   - Streaming via ai.models.generateContentStream() returns AsyncGenerator<GenerateContentResponse>
 *   - Text is accessed via response.text getter on GenerateContentResponse
 *   - Structured output: responseMimeType: 'application/json' in GenerateContentConfig
 *
 * SDK error class note:
 *   The @google/genai public API exports only ApiError (lowercase 'a'), which has status: number.
 *   Internal APIError / APIConnectionError classes (uppercase) are NOT exported from the package
 *   root and must not be imported from internal dist paths.
 *   Network errors (ECONNRESET, ETIMEDOUT) arrive as plain Error objects caught by normaliseThrownError.
 */

import {
  ApiError,
  type Content,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  GoogleGenAI,
} from '@google/genai';
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

const PROVIDER = 'gemini';

/** Normalise Gemini's usageMetadata to LlmUsage. */
function normaliseUsage(meta: GenerateContentResponseUsageMetadata | undefined): LlmUsage {
  const inputTokens = meta?.promptTokenCount ?? 0;
  const outputTokens = meta?.candidatesTokenCount ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: meta?.totalTokenCount ?? inputTokens + outputTokens,
  };
}

/**
 * Convert LlmMessages to Gemini's Content array format.
 * Extracts system message — Gemini treats system instructions separately from contents.
 * Role mapping: 'user' → 'user', 'assistant' → 'model' (Gemini API requires 'model').
 */
function buildGeminiContents(messages: LlmMessage[]): {
  system: string | undefined;
  contents: Content[];
} {
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  const system =
    systemMessages.length > 0 ? systemMessages.map((m) => m.content).join('\n') : undefined;

  const contents: Content[] = conversationMessages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  return { system, contents };
}

/**
 * Normalise any Gemini SDK error into LlmError.
 * Exported for direct unit testing of the normalisation logic.
 *
 * ApiError (public SDK class) always has status: number, so there is no undefined-status branch.
 * Network errors (no HTTP status) arrive as plain Error objects; normaliseThrownError
 * handles retryable error codes (ECONNRESET, ETIMEDOUT, etc.).
 */
export function normaliseGeminiError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // ApiError is the only publicly-exported SDK error class.
  // status is always number (not undefined) per the ApiError type definition.
  if (err instanceof ApiError) {
    const retryable = err.status === 429 || err.status >= 500;
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      statusCode: err.status,
      retryable,
      cause: err,
    });
  }

  // Network errors (ECONNRESET, ETIMEDOUT, etc.) arrive as plain Error objects.
  // normaliseThrownError classifies retryable codes and handles the unknown-error case.
  return normaliseThrownError(err, PROVIDER);
}

/** Create the Gemini provider implementation. */
export function createGeminiProvider(config: LlmClientConfig): LlmClient {
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      timeout: config.timeoutMs ?? 30_000,
    },
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
    const { system, contents } = buildGeminiContents(messages);
    const start = Date.now();

    return withRetry(async () => {
      try {
        // Build config object — always passed (empty object is valid GenerateContentConfig)
        const geminiConfig: GenerateContentConfig = {};

        if (system !== undefined) geminiConfig.systemInstruction = system;
        const maxTokens = options?.maxTokens ?? config.maxTokens;
        if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
        const temperature = options?.temperature ?? config.temperature;
        if (temperature !== undefined) geminiConfig.temperature = temperature;

        const response = await ai.models.generateContent({
          model,
          contents,
          config: geminiConfig,
        });

        return {
          content: response.text ?? '',
          model,
          usage: normaliseUsage(response.usageMetadata),
          latencyMs: Date.now() - start,
        };
      } catch (err) {
        throw normaliseGeminiError(err);
      }
    }, retryOpts);
  }

  async function* stream(
    messages: LlmMessage[],
    options?: Partial<Pick<LlmClientConfig, 'model' | 'maxTokens' | 'temperature'>>
  ): AsyncGenerator<LlmStreamChunk> {
    const model = options?.model ?? config.model;
    const { system, contents } = buildGeminiContents(messages);

    // Build config — always passed (empty object is valid GenerateContentConfig)
    const geminiConfig: GenerateContentConfig = {};
    if (system !== undefined) geminiConfig.systemInstruction = system;
    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) geminiConfig.temperature = temperature;

    let sdkStream: AsyncGenerator<GenerateContentResponse>;

    try {
      sdkStream = await ai.models.generateContentStream({
        model,
        contents,
        config: geminiConfig,
      });
    } catch (err) {
      throw normaliseGeminiError(err);
    }

    let finalUsage: LlmUsage | undefined;

    try {
      for await (const chunk of sdkStream) {
        const text = chunk.text;
        if (text !== undefined && text.length > 0) {
          yield { token: text };
        }
        // Capture usage from each chunk — the final chunk has the complete totals
        if (chunk.usageMetadata !== undefined) {
          finalUsage = normaliseUsage(chunk.usageMetadata);
        }
      }
    } catch (err) {
      throw normaliseGeminiError(err);
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
    const augmentedMessages: LlmMessage[] = [
      {
        role: 'system',
        content:
          'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
      },
      ...messages,
    ];

    const model = options?.model ?? config.model;
    const { system, contents } = buildGeminiContents(augmentedMessages);
    const start = Date.now();

    const rawResponse = await withRetry(async () => {
      try {
        const geminiConfig: GenerateContentConfig = {
          // Instruct Gemini to return JSON directly
          responseMimeType: 'application/json',
        };

        if (system !== undefined) geminiConfig.systemInstruction = system;
        const maxTokens = options?.maxTokens ?? config.maxTokens;
        if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
        const temperature = options?.temperature ?? config.temperature;
        if (temperature !== undefined) geminiConfig.temperature = temperature;

        return await ai.models.generateContent({
          model,
          contents,
          config: geminiConfig,
        });
      } catch (err) {
        throw normaliseGeminiError(err);
      }
    }, retryOpts);

    const rawContent = rawResponse.text ?? '';

    let parsed: unknown;
    try {
      // Strip markdown code fences if the model included them despite the instruction
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new LlmError({
        message: `Gemini structured output: response is not valid JSON. Raw: ${rawContent.slice(0, 200)}`,
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
        message: `Gemini structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      usage: normaliseUsage(rawResponse.usageMetadata),
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
