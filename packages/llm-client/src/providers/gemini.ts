/**
 * Google Gemini provider for @diabolicallabs/llm-client.
 *
 * Uses the @google/genai SDK (v2.x — not the deprecated @google/generative-ai).
 *
 * Implements: complete(), stream(), structured()
 *
 * Token normalization:
 *   Gemini: usageMetadata.promptTokenCount / candidatesTokenCount / totalTokenCount
 *   → LlmUsage: inputTokens / outputTokens / totalTokens
 *
 * Error mapping:
 *   ApiError (public SDK class, status: number always defined):
 *     retryable for 429 / 5xx
 *     non-retryable for 4xx (except 429)
 *   Other errors → normalizeThrownError (handles ECONNRESET / ETIMEDOUT as retryable)
 *
 * API notes:
 *   - System instructions are passed via config.systemInstruction (not mixed into contents)
 *   - Role mapping: 'user' → 'user', 'assistant' → 'model'
 *   - Streaming via ai.models.generateContentStream() returns AsyncGenerator<GenerateContentResponse>
 *   - Text is accessed via response.text getter on GenerateContentResponse
 *   - Structured output (v0.4.0): Zod 4 schema → responseSchema (OpenAPI 3.0) + responseMimeType.
 *     Non-Zod → prompt-only fallback with responseMimeType only.
 *
 * SDK error class note:
 *   The @google/genai public API exports only ApiError (lowercase 'a'), which has status: number.
 *   Internal APIError / APIConnectionError classes (uppercase) are NOT exported from the package
 *   root and must not be imported from internal dist paths.
 *   Network errors (ECONNRESET, ETIMEDOUT) arrive as plain Error objects caught by normalizeThrownError.
 *
 * ⚠ Cancellation caveat (v0.3.0 — owner-accepted, 2026-05-10):
 *   @google/genai SDK does not accept a per-call AbortSignal. Cancellation is implemented
 *   via Promise.race: when the internal controller aborts, a rejection promise wins the race
 *   and we stop awaiting the SDK call. However, the SDK's underlying HTTP request is NOT
 *   cancelled — it continues in the background until it completes or the SDK-level timeout fires.
 *
 *   Mitigation: GoogleGenAI is constructed with httpOptions.timeout = effectiveTimeoutMs * 2
 *   as a backstop. This bounds the leaked request to at most 2× the per-call timeout.
 *
 *   Tracking issue: migrate to native signal support when @google/genai adds it.
 */

import {
  ApiError,
  type Content,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type GenerateContentResponseUsageMetadata,
  GoogleGenAI,
  type ToolConfig,
} from '@google/genai';
import { classifyAbort, createAttemptController, withStallTimeout } from '../abort.js';
import { parseJsonOrThrow } from '../extract-json.js';
import {
  isZodSchema,
  type JsonNode,
  stripGeminiSentinel,
  toProviderSchema,
} from '../json-schema.js';
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

const PROVIDER = 'gemini';

/** Normalize Gemini's usageMetadata to LlmUsage. */
function normalizeUsage(meta: GenerateContentResponseUsageMetadata | undefined): LlmUsage {
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
 * Normalize any Gemini SDK error into LlmError.
 * Exported for direct unit testing of the normalization logic.
 *
 * ApiError (public SDK class) always has status: number, so there is no undefined-status branch.
 * Network errors (no HTTP status) arrive as plain Error objects; normalizeThrownError
 * handles retryable error codes (ECONNRESET, ETIMEDOUT, etc.).
 */
export function normalizeGeminiError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // ApiError is the only publicly-exported SDK error class.
  // status is always number (not undefined) per the ApiError type definition.
  if (err instanceof ApiError) {
    const kind = classifyHttpStatus(err.status);
    const retryable = kind === 'rate_limit' || kind === 'server_error';
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      statusCode: err.status,
      kind,
      retryable,
      cause: err,
    });
  }

  // Network errors (ECONNRESET, ETIMEDOUT, etc.) arrive as plain Error objects.
  // normalizeThrownError classifies retryable codes and handles the unknown-error case.
  return normalizeThrownError(err, PROVIDER);
}

/**
 * Build an "abort-rejection" promise that rejects with an AbortError-shaped error
 * when the controller's signal fires. Used in Promise.race to simulate cancellation
 * for SDK calls that don't accept a signal directly.
 *
 * NOTE: This does NOT cancel the SDK's underlying HTTP request. See the module-level
 * caveat comment for the documented socket-leak behavior and the 2× backstop mitigation.
 */
function makeAbortRacePromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      const e = new Error('AbortError');
      e.name = 'AbortError';
      reject(e);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Create the Gemini provider implementation. */
export function createGeminiProvider(config: LlmClientConfig): LlmClient {
  // Providers always receive model as a string (client.ts resolves arrays before dispatch).
  const resolvedModel = Array.isArray(config.model) ? config.model[0]! : config.model;
  const resolvedConfig = { ...config, model: resolvedModel } as LlmClientConfig & {
    model: string;
  };

  const configTimeoutMs = config.timeoutMs ?? 30_000;

  // GoogleGenAI instance — httpOptions.timeout is the per-call SDK-level backstop.
  // For per-call overrides, we multiply by 2 as the backstop (see caveat above).
  // Since @google/genai does not support per-call construction, we use the config-level
  // timeout * 2 as a static backstop. Per-call overrides shorter than config timeout
  // will be enforced by the Promise.race; longer overrides are bounded by this backstop.
  const ai = new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: {
      timeout: configTimeoutMs * 2,
    },
  });

  const retryOpts = {
    maxRetries: config.maxRetries ?? 3,
    baseDelayMs: config.baseDelayMs ?? 1_000,
    provider: PROVIDER,
    ...(config.retry !== undefined && { retryConfig: config.retry }),
  };

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model ?? resolvedConfig.model;
    const { system, contents } = buildGeminiContents(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? configTimeoutMs;
    const start = Date.now();

    return withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          // Build config object — always passed (empty object is valid GenerateContentConfig)
          const geminiConfig: GenerateContentConfig = {};

          if (system !== undefined) geminiConfig.systemInstruction = system;
          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) geminiConfig.temperature = temperature;

          // Promise.race: whichever settles first wins. If ctl.signal aborts (timeout or
          // caller cancel), the abortRace rejects; the SDK call continues in the background
          // until the httpOptions.timeout backstop fires. See module-level caveat.
          const response = await Promise.race([
            ai.models.generateContent({ model, contents, config: geminiConfig }),
            makeAbortRacePromise(ctl.signal),
          ]);

          return {
            content: response.text ?? '',
            model,
            usage: normalizeUsage(response.usageMetadata),
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          throw normalizeGeminiError(classifyAbort(err, ctl.abortReason(), PROVIDER));
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
    const { system, contents } = buildGeminiContents(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? configTimeoutMs;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;

    // Build config — always passed (empty object is valid GenerateContentConfig)
    const geminiConfig: GenerateContentConfig = {};
    if (system !== undefined) geminiConfig.systemInstruction = system;
    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) geminiConfig.temperature = temperature;

    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
    let sdkStream: AsyncGenerator<GenerateContentResponse>;

    try {
      // Gemini's generateContentStream() doesn't accept a signal, so we race the
      // initialization promise against an abort promise. See module-level caveat.
      sdkStream = await Promise.race([
        ai.models.generateContentStream({ model, contents, config: geminiConfig }),
        makeAbortRacePromise(ctl.signal),
      ]);
    } catch (err) {
      ctl.dispose();
      throw normalizeGeminiError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    let finalUsage: LlmUsage | undefined;

    try {
      for await (const chunk of withStallTimeout(sdkStream, stallMs, ctl, PROVIDER)) {
        const text = chunk.text;
        if (text !== undefined && text.length > 0) {
          yield { token: text };
        }
        // Capture usage from each chunk — the final chunk has the complete totals
        if (chunk.usageMetadata !== undefined) {
          finalUsage = normalizeUsage(chunk.usageMetadata);
        }
      }
    } catch (err) {
      throw normalizeGeminiError(classifyAbort(err, ctl.abortReason(), PROVIDER));
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
    // Detect Zod 4 schema and check for prompt-mode escape hatch.
    // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown> — noPropertyAccessFromIndexSignature requires bracket notation
    const structuredMode = options?.providerOptions?.['structuredMode'];
    const useStrict = isZodSchema(schema) && structuredMode !== 'prompt';

    if (!useStrict) {
      return structuredPromptFallback(messages, schema, options);
    }

    // ── Strict path: responseSchema populated from Zod 4 schema ─────────────
    const responseSchemaObj = toProviderSchema(schema, 'gemini');
    const model = options?.model ?? resolvedConfig.model;
    const { system, contents } = buildGeminiContents(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? configTimeoutMs;
    const start = Date.now();

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const geminiConfig: GenerateContentConfig = {
            responseMimeType: 'application/json',
            // responseSchema SDK type is permissive; cast through never to avoid SDK type mismatch
            responseSchema: responseSchemaObj as never,
          };

          if (system !== undefined) geminiConfig.systemInstruction = system;
          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) geminiConfig.temperature = temperature;

          return await Promise.race([
            ai.models.generateContent({ model, contents, config: geminiConfig }),
            makeAbortRacePromise(ctl.signal),
          ]);
        } catch (err) {
          throw normalizeGeminiError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    const rawContent = rawResponse.text ?? '';

    let parsed: unknown;
    try {
      // Belt-and-braces fence-strip — Gemini occasionally wraps JSON in fences even
      // when responseMimeType and responseSchema are set.
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      throw new LlmError({
        message: `Gemini structured output: response is not valid JSON. Raw: ${rawContent.slice(0, 200)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    // Strip _placeholder sentinel properties injected by geminiPostprocess to satisfy
    // Gemini's empty-object constraint (Item 1.3 — auto-rewrite in toolkit, not consumer code).
    parsed = stripGeminiSentinel(parsed);

    // Defense-in-depth: validate against Zod schema even after strict-mode call
    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `Gemini structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      // Gemini does not return a request ID; model comes from response.modelVersion if available
      model: rawResponse.modelVersion ?? model,
      usage: normalizeUsage(rawResponse.usageMetadata),
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
    const augmentedMessages: LlmMessage[] = [
      {
        role: 'system',
        content:
          'You must respond with valid JSON only. No explanations, no markdown code fences, no extra text. Your entire response must be valid JSON that can be parsed with JSON.parse().',
      },
      ...messages,
    ];

    const model = options?.model ?? resolvedConfig.model;
    const { system, contents } = buildGeminiContents(augmentedMessages);
    const effectiveTimeoutMs = options?.timeoutMs ?? configTimeoutMs;
    const start = Date.now();

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const geminiConfig: GenerateContentConfig = {
            responseMimeType: 'application/json',
          };

          if (system !== undefined) geminiConfig.systemInstruction = system;
          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) geminiConfig.temperature = temperature;

          return await Promise.race([
            ai.models.generateContent({ model, contents, config: geminiConfig }),
            makeAbortRacePromise(ctl.signal),
          ]);
        } catch (err) {
          throw normalizeGeminiError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    const rawContent = rawResponse.text ?? '';

    // parseJsonOrThrow: tries extractJsonBlock first (handles fences, prose, no closing fence),
    // falls back to legacy strip+parse, then throws a non-retryable LlmError with a
    // ≥500-char raw content slice when no valid JSON can be extracted.
    const parsed = parseJsonOrThrow(rawContent, PROVIDER);

    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `Gemini structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      model,
      usage: normalizeUsage(rawResponse.usageMetadata),
      latencyMs: Date.now() - start,
    };
  }

  /**
   * withTools() — native tool calling via @google/genai SDK v2.x.
   *
   * Tool shape: config.tools[].functionDeclarations[].parametersJsonSchema (Tom §3.2).
   * Uses `parametersJsonSchema` (plain JSON Schema) — NOT `parameters` (Gemini's Schema type).
   * This avoids the conversion layer between JSON Schema and Gemini's proprietary Schema type.
   *
   * Gemini does not issue tool call IDs — UUIDs are synthesized (v7-style: time-based + random).
   * parallelToolCalls: ignored — Gemini has no equivalent flag.
   * toolChoice: 'none' sets tool_config.function_calling_config.mode = 'NONE'.
   *   'any' → mode = 'ANY'. 'auto' → mode = 'AUTO'. Named tool not directly supported
   *   (Gemini doesn't have a single-function forced-call mode); falls back to 'AUTO'.
   *
   * Stop reason mapping: STOP + functionCall parts → 'tool_use'.
   *   SAFETY → 'content_filter'. MAX_TOKENS → 'max_tokens'. Otherwise 'end_turn'.
   */
  async function withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    const model = options?.model ?? resolvedConfig.model;
    const { system, contents } = buildGeminiContents(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? configTimeoutMs;
    const start = Date.now();

    // Build Gemini FunctionDeclaration array using parametersJsonSchema (plain JSON Schema)
    const functionDeclarations: FunctionDeclaration[] = tools.map((t) => {
      const parametersSchema = isZodSchema(t.inputSchema)
        ? toProviderSchema(t.inputSchema as import('zod').ZodType, 'gemini')
        : (t.inputSchema as unknown as JsonNode);
      return {
        name: t.name,
        description: t.description,
        parametersJsonSchema: parametersSchema as unknown,
      };
    });

    // Map toolChoice to Gemini's function_calling_config.mode.
    // Return type is ToolConfig (non-optional) so exactOptionalPropertyTypes accepts the
    // assignment to geminiConfig.toolConfig.
    function buildFunctionCallingConfig(): ToolConfig {
      const tc = options?.toolChoice;
      if (tc === 'none') return { function_calling_config: { mode: 'NONE' } } as ToolConfig;
      if (tc === 'any') return { function_calling_config: { mode: 'ANY' } } as ToolConfig;
      // 'auto', undefined, or named tool → AUTO
      return { function_calling_config: { mode: 'AUTO' } } as ToolConfig;
    }

    const rawResponse = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const geminiConfig: GenerateContentConfig = {
            tools: [{ functionDeclarations }],
            toolConfig: buildFunctionCallingConfig(),
          };

          if (system !== undefined) geminiConfig.systemInstruction = system;
          const maxTokens = options?.maxTokens ?? config.maxTokens;
          if (maxTokens !== undefined) geminiConfig.maxOutputTokens = maxTokens;
          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) geminiConfig.temperature = temperature;

          return await Promise.race([
            ai.models.generateContent({ model, contents, config: geminiConfig }),
            makeAbortRacePromise(ctl.signal),
          ]);
        } catch (err) {
          throw normalizeGeminiError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    // Extract text content and function call parts from the response
    const textParts: string[] = [];
    const toolCalls: LlmToolCall[] = [];

    const candidates = rawResponse.candidates ?? [];
    for (const candidate of candidates) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.text !== undefined && part.text.length > 0) {
          textParts.push(part.text);
        } else if (part.functionCall !== undefined) {
          const fc = part.functionCall;
          const rawArgs = JSON.stringify(fc.args ?? {});
          let parsedArgs: unknown = fc.args ?? {};

          // Validate against the tool's inputSchema
          const tool = tools.find((t) => t.name === fc.name);
          if (tool !== undefined) {
            try {
              parsedArgs = tool.inputSchema.parse(fc.args ?? {});
            } catch (err) {
              throw new LlmError({
                message: `Gemini withTools: arguments for tool '${fc.name ?? ''}' failed schema validation. ${String(err)}`,
                provider: PROVIDER,
                kind: 'tool_arguments_invalid',
                retryable: false,
                cause: err,
              });
            }
          }

          // Gemini does not issue call IDs — synthesize a UUID v7-style ID
          toolCalls.push({
            id: synthesizeId(),
            toolName: fc.name ?? '',
            arguments: parsedArgs,
            rawArguments: rawArgs,
          });
        }
      }
    }

    // Map Gemini finishReason to LlmToolResponse.stopReason.
    // Cast to string before string comparisons — the SDK's FinishReason union may not
    // include all values (e.g. STOP_SEQUENCE) depending on SDK version.
    const firstCandidate = candidates[0];
    const finishReason = String(firstCandidate?.finishReason ?? 'STOP');
    let stopReason: LlmToolResponse['stopReason'] = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    if (finishReason === 'SAFETY') stopReason = 'content_filter';
    if (finishReason === 'MAX_TOKENS') stopReason = 'max_tokens';
    if (finishReason === 'STOP_SEQUENCE') stopReason = 'stop_sequence';

    return {
      content: textParts.join(''),
      toolCalls,
      model: rawResponse.modelVersion ?? model,
      usage: normalizeUsage(rawResponse.usageMetadata),
      latencyMs: Date.now() - start,
      stopReason,
    };
  }

  /**
   * streamStructured() — NOT supported by Gemini (v1.3.0+).
   *
   * Gemini does not reliably support simultaneous structured-output constraints (responseSchema)
   * and streaming — the SDK either ignores the schema in streaming mode or serializes the call
   * internally. Attempting to use both produces undefined behavior across Gemini model versions.
   *
   * Use stream() for incremental tokens or structured() for Zod-validated output.
   * A future wave can attempt streaming + schema after Gemini's API stabilizes.
   */
  // biome-ignore lint/correctness/useYield: this generator throws before any yield — intentional pre-call rejection pattern
  async function* streamStructured<T>(
    _messages: LlmMessage[],
    _schema: { parse: (data: unknown) => T },
    _options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    throw new LlmError({
      message:
        'Gemini streamStructured() not yet supported — Gemini may not reliably stream + validate simultaneously; use stream() for tokens or structured() for validation',
      provider: PROVIDER,
      kind: 'bad_request',
      retryable: false,
    });
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

/**
 * Synthesize a UUID v7-style ID for providers that do not issue tool call IDs.
 * Format: 8-4-4-4-12 hex, first 12 hex chars are time-derived (ms precision).
 * Not cryptographically secure — for tracing/correlation only.
 */
function synthesizeId(): string {
  const now = Date.now();
  const timeHex = now.toString(16).padStart(12, '0');
  const rand = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0');
  // UUID v7-style: time-high-and-version | time-mid | time-low | clock-seq | node
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand().slice(1)}-${rand()}-${rand()}${rand()}${rand()}`;
}
