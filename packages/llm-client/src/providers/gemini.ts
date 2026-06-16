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
  type Part,
  type ToolConfig,
} from '@google/genai';
import { classifyAbort, createAttemptController, withStallTimeout } from '../abort.js';
import { parseJsonOrThrow } from '../extract-json.js';
import { synthesizeId } from '../id-helpers.js';
import { isZodSchema, stripGeminiSentinel, toProviderSchema } from '../json-schema.js';
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
import { assertBlocksSupported, mapGeminiParts } from './content-blocks.js';

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
 *
 * v4.2.0 multimodal support:
 *   - String content is passed through as a text part (unchanged behavior).
 *   - LlmContentBlock[] content is mapped to Gemini Part[] via mapGeminiParts().
 *   - Pre-flight assertBlocksSupported() is called before mapping to guarantee that
 *     unsupported block types (notably image.url) are rejected before any SDK call.
 *
 * Gemini supports: text, image (base64 only), document (base64 PDF via inlineData).
 * Gemini does NOT accept URL images via inlineData — use inline base64 bytes only.
 * image.url is rejected with bad_request before the SDK call.
 *
 * System message: Gemini accepts a plain string for systemInstruction.
 * When a system message carries LlmContentBlock[], extract text blocks only.
 * Image/document blocks in system are silently dropped (same policy as Anthropic).
 */
function buildGeminiContents(messages: LlmMessage[]): {
  system: string | undefined;
  contents: Content[];
} {
  // Pre-flight: Gemini supports text, image.base64, document.base64, and Files API refs.
  // image.url is NOT supported — Gemini inlineData requires inline bytes.
  // fileRef: true — file blocks are supported via Gemini Files API (video, image, PDF).
  assertBlocksSupported(messages, PROVIDER, {
    textBlock: true,
    imageBase64: true,
    imageUrl: false,
    documentBase64: true,
    fileRef: true,
  });

  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  let system: string | undefined;
  if (systemMessages.length > 0) {
    const parts: string[] = [];
    for (const msg of systemMessages) {
      if (Array.isArray(msg.content)) {
        // Extract text only; silently drop image/document blocks in system messages.
        parts.push(
          msg.content
            .filter(
              (
                b
              ): b is Extract<(typeof msg.content)[number] & { type: 'text' }, { type: 'text' }> =>
                b.type === 'text'
            )
            .map((b) => b.text)
            .join('')
        );
      } else {
        parts.push(msg.content);
      }
    }
    system = parts.join('\n') || undefined;
  }

  const contents: Content[] = conversationMessages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: mapGeminiParts(m.content) as Part[],
      };
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    };
  });

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
            // Gemini does not issue native response IDs — synthesize a time-sortable v7-style UUID.
            id: synthesizeId(),
            idSource: 'synthesized' as const,
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
      // Gemini does not return a request ID; model comes from response.modelVersion if available.
      // Synthesize a time-sortable v7-style UUID for trace correlation.
      model: rawResponse.modelVersion ?? model,
      id: synthesizeId(),
      idSource: 'synthesized' as const,
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
      id: synthesizeId(),
      idSource: 'synthesized' as const,
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
    // Gemini uses OpenAPI 3.0 dialect; switch on the LlmToolSchema kind discriminant
    const functionDeclarations: FunctionDeclaration[] = tools.map((t) => {
      let schemaForProvider: unknown;
      switch (t.inputSchema.kind) {
        case 'zod':
          schemaForProvider = toProviderSchema(t.inputSchema.schema, 'gemini');
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
        name: t.name,
        description: t.description,
        parametersJsonSchema: schemaForProvider,
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
              parsedArgs =
                tool.inputSchema.kind === 'zod'
                  ? tool.inputSchema.schema.parse(fc.args ?? {})
                  : tool.inputSchema.validate
                    ? tool.inputSchema.validate(fc.args ?? {})
                    : (fc.args ?? {});
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
      id: synthesizeId(),
      idSource: 'synthesized' as const,
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

  // ─── Files API (v5.1.0) ──────────────────────────────────────────────────────

  /**
   * Gemini Files API — upload, poll state, and delete assets via @google/genai v2.x.
   *
   * Gemini is the only provider that supports video inputs (MP4, QuickTime, WebM).
   * Video uploads go through an async processing pipeline (PROCESSING → ACTIVE).
   * Callers MUST call waitForActive() before referencing a file in a message.
   *
   * State lifecycle:
   *   upload() → ref.state = 'processing' (usually)
   *   waitForActive() polls refresh() until state === 'active' or timeout
   *   active ref can be placed in a { type: 'file', ref } content block
   *   delete() cleans up — optional but recommended for large/sensitive files
   */
  const files: LlmFilesApi = {
    /**
     * Upload a binary asset to Gemini's file store.
     *
     * Maps to ai.files.upload({ file: { data, mimeType }, config: { displayName } }).
     * Returns immediately — state is typically 'processing' for video uploads.
     * All supported Gemini media types are accepted: video/*, image/*, application/pdf.
     */
    async upload({
      data,
      mediaType,
      displayName,
    }: {
      data: Buffer | Uint8Array;
      mediaType: import('../types.js').LlmFileMediaType;
      displayName?: string;
    }): Promise<LlmFileRef> {
      try {
        // Gemini SDK v2.x: ai.files.upload({ file: Blob, config: { mimeType, displayName? } }).
        // We construct a Blob from the raw bytes and pass mimeType via config.
        // Convert Buffer | Uint8Array → typed Uint8Array to satisfy Blob constructor types.
        const blob = new Blob([new Uint8Array(data)], { type: mediaType });
        const uploadConfig: { mimeType: string; displayName?: string } = { mimeType: mediaType };
        if (displayName !== undefined) uploadConfig.displayName = displayName;

        const response = await ai.files.upload({
          file: blob,
          config: uploadConfig,
        });

        // Map Gemini state to LlmFileState. Gemini uses PROCESSING/ACTIVE/FAILED (uppercase).
        const rawState = String(response.state ?? 'ACTIVE');
        const state =
          rawState === 'ACTIVE'
            ? ('active' as const)
            : rawState === 'FAILED'
              ? ('failed' as const)
              : ('processing' as const);

        // response.uri is the full HTTPS URL required by the Gemini message API
        // (e.g. https://generativelanguage.googleapis.com/v1beta/files/abc123).
        // response.name is the bare resource name (e.g. files/abc123) used for management
        // operations (get, delete). The Gemini fileData.fileUri parameter requires the
        // full URI — NOT the bare name.
        const expirationTime = response.expirationTime;
        return {
          id: response.name ?? '',
          uri: response.uri ?? '',
          provider: 'gemini' as const,
          mediaType,
          sizeBytes: Number(response.sizeBytes ?? data.length),
          state,
          ...(expirationTime !== undefined && { expiresAt: expirationTime }),
        };
      } catch (err) {
        throw normalizeGeminiFilesError(err, 'upload');
      }
    },

    /**
     * Re-fetch a file ref's current state from Gemini.
     *
     * Maps to ai.files.get({ name: ref.id }).
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
      try {
        const response = await ai.files.get({ name: ref.id });
        const rawState = String(response.state ?? 'ACTIVE');
        const state =
          rawState === 'ACTIVE'
            ? ('active' as const)
            : rawState === 'FAILED'
              ? ('failed' as const)
              : ('processing' as const);

        const newExpirationTime = response.expirationTime ?? ref.expiresAt;
        // Preserve the authoritative URI from the refreshed response when available;
        // fall back to the existing ref.uri (unchanged between refreshes).
        const refreshedUri = response.uri ?? ref.uri;
        return {
          ...ref,
          uri: refreshedUri,
          state,
          ...(newExpirationTime !== undefined && { expiresAt: newExpirationTime }),
        };
      } catch (err) {
        throw normalizeGeminiFilesError(err, 'refresh');
      }
    },

    /**
     * Poll refresh() until the ref reaches state 'active' or the timeout fires.
     *
     * Default: poll every 2s, timeout after 120s. Sufficient for typical Gemini video
     * processing (observed range: 5–60s for clips under 100 MB).
     */
    async waitForActive(
      ref: LlmFileRef,
      opts?: { timeoutMs?: number; intervalMs?: number }
    ): Promise<LlmFileRef> {
      // Immediately resolve if already active
      if (ref.state === 'active') return ref;

      if (ref.state === 'failed') {
        throw new LlmError({
          message: `[llm-client] File processing failed at provider: ref '${ref.id}' is in 'failed' state.`,
          provider: PROVIDER,
          kind: 'bad_request',
          retryable: false,
        });
      }

      const timeoutMs = opts?.timeoutMs ?? 120_000;
      const intervalMs = opts?.intervalMs ?? 2_000;
      const deadline = Date.now() + timeoutMs;

      let current = ref;
      while (Date.now() < deadline) {
        // Wait for the interval before polling
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));

        current = await files.refresh(current);

        if (current.state === 'active') return current;

        if (current.state === 'failed') {
          throw new LlmError({
            message: `[llm-client] File processing failed at provider: ref '${ref.id}' transitioned to 'failed'.`,
            provider: PROVIDER,
            kind: 'bad_request',
            retryable: false,
          });
        }
      }

      throw new LlmError({
        message: `[llm-client] File ref did not become active within ${timeoutMs}ms.`,
        provider: PROVIDER,
        kind: 'timeout',
        retryable: true,
      });
    },

    /**
     * Delete a file from Gemini's file store. Best-effort: swallows 404.
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
      try {
        await ai.files.delete({ name: ref.id });
      } catch (err) {
        // Swallow 404 — file already deleted or never existed
        if (err instanceof ApiError && err.status === 404) {
          return;
        }
        throw normalizeGeminiFilesError(err, 'delete');
      }
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
 * Network failures → kind:'network'. 5xx → kind:'server_error'. Others → classifyHttpStatus.
 */
function normalizeGeminiFilesError(err: unknown, operation: string): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof ApiError) {
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

  // Network or unknown error
  return new LlmError({
    message: `[llm-client] Files API network error: ${String(err)} (${operation})`,
    provider: PROVIDER,
    kind: 'network',
    retryable: true,
    cause: err,
  });
}
