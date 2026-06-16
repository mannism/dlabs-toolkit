/**
 * Anthropic Claude provider for @diabolicallabs/llm-client.
 *
 * Implements: complete(), stream(), structured()
 *
 * Token normalization:
 *   Anthropic: input_tokens / output_tokens / cache_creation_input_tokens / cache_read_input_tokens
 *   → LlmUsage: inputTokens / outputTokens / totalTokens / cacheCreationTokens / cacheReadTokens
 *
 * Error mapping:
 *   APIStatusError.status → LlmError.statusCode + retryable flag
 *   APIConnectionError → retryable: true
 *
 * Structured output (v0.4.0):
 *   Zod 4 schema detected → tool-use with forced tool_choice: { type: 'tool', name: 'extract' }.
 *   Model is forced to call the 'extract' tool; response is in content[].tool_use.input (parsed JSON).
 *   Non-Zod schema or providerOptions.structuredMode === 'prompt' → prompt-only fallback.
 *
 * Prompt caching (v0.4.3):
 *   Pass providerOptions.promptCache: 'ephemeral' to inject cache_control: { type: 'ephemeral' }
 *   on the system message block. Anthropic's API enforces its own minimum block size (1024 tokens
 *   for Sonnet/Opus, 2048 for Haiku) — the toolkit always sends the marker and lets the API decide
 *   eligibility. Callers pay no surcharge when the API ignores the marker on too-small blocks.
 *   Cost model: cache write = 1.25× normal input; cache read = 0.10× normal input.
 *   Break-even: 3 cache reads within the 5-minute TTL window.
 *
 * Files API beta (v5.1.0):
 *   When any message contains a { type: 'file', ref } content block, the Anthropic API requires
 *   the beta header 'files-api-2025-04-14'. The provider auto-injects this header per-call via
 *   RequestOptions.headers — callers do not need to opt in. hasFileBlocks() detects presence and
 *   filesBetaHeaders() returns the header object (or undefined) for conditional spreading.
 */

import Anthropic from '@anthropic-ai/sdk';
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
import {
  assertBlocksSupported,
  extractTextFromBlocks,
  mapAnthropicContent,
} from './content-blocks.js';

const PROVIDER = 'anthropic';

/** Normalize Anthropic's usage object to LlmUsage. */
function normalizeUsage(usage: Anthropic.Usage | undefined): LlmUsage {
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

/**
 * Convert LlmMessages to Anthropic's message format. Extracts system prompt.
 *
 * v4.2.0 multimodal support:
 *   - System messages: Anthropic's `system` parameter accepts `string | TextBlockParam[]`
 *     but NOT image or document blocks. When a system message carries LlmContentBlock[]
 *     content, only text blocks are extracted and joined into a plain string.
 *     Image and document blocks in system messages are silently dropped.
 *     This behavior is intentional: the primary multimodal intake use case always sends
 *     visual content in user messages, not system. A future feature can emit TextBlockParam[]
 *     to enable per-block cache_control on system content.
 *
 *   - User/assistant messages: LlmContentBlock[] is mapped to Anthropic's native block array
 *     via mapAnthropicContent(). String content is passed through unchanged.
 *
 * Pre-flight guard (assertBlocksSupported) is called before building messages to ensure
 * no unsupported block type reaches the SDK. The Anthropic provider supports all block
 * types that exist in v4.2.0 (text, image.base64, image.url, document.base64).
 */
function buildAnthropicMessages(messages: LlmMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  // Pre-flight: assert all blocks in this message set are supported by Anthropic.
  // fileRef: true — file blocks are supported for PDF + image refs (media type validation is in mapAnthropicContent).
  assertBlocksSupported(messages, PROVIDER, {
    textBlock: true,
    imageBase64: true,
    imageUrl: true,
    documentBase64: true,
    fileRef: true,
  });

  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter((m) => m.role !== 'system');

  // System parameter: Anthropic accepts string | TextBlockParam[], but NOT image/document blocks.
  // When a system message carries LlmContentBlock[], extract only text blocks and join as a string.
  // Image and document blocks in system are silently dropped (intentional — see JSDoc above).
  let system: string | undefined;
  if (systemMessages.length > 0) {
    const parts: string[] = [];
    for (const msg of systemMessages) {
      if (Array.isArray(msg.content)) {
        // Extract text-only; silently drop image/document blocks in system messages.
        parts.push(extractTextFromBlocks(msg.content));
      } else {
        parts.push(msg.content);
      }
    }
    system = parts.join('\n') || undefined;
  }

  const anthropicMessages: Anthropic.MessageParam[] = conversationMessages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        role: m.role as 'user' | 'assistant',
        content: mapAnthropicContent(m.content),
      };
    }
    return {
      role: m.role as 'user' | 'assistant',
      content: m.content,
    };
  });

  return { system, messages: anthropicMessages };
}

/**
 * Build the `system` parameter for an Anthropic API call.
 *
 * When promptCache is 'ephemeral', the system content is wrapped in a block
 * array with cache_control: { type: 'ephemeral' } so Anthropic caches the
 * system prompt between calls. The toolkit always sends the marker and lets
 * Anthropic's API enforce minimum block size (1024 tokens for Sonnet/Opus,
 * 2048 for Haiku). If the block is too small, the API silently ignores the
 * marker — callers pay no surcharge.
 *
 * Without promptCache, returns the plain string form (no behavioral change
 * for existing callers).
 */
function buildSystemParam(
  system: string,
  promptCache: string | undefined
): string | Anthropic.TextBlockParam[] {
  if (promptCache !== 'ephemeral') {
    return system;
  }
  return [
    {
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Returns true if any message in the array contains a { type: 'file', ref } content block.
 *
 * Used to detect whether the Anthropic Files beta header must be injected on the call.
 * Only inspects array content — string messages never contain file blocks.
 */
function hasFileBlocks(messages: LlmMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'file'));
}

/**
 * Returns RequestOptions.headers with the Files API beta header when file blocks are present,
 * or undefined when no file blocks are detected.
 *
 * Spread into per-call RequestOptions alongside signal and timeout:
 *   { signal, timeout, ...filesBetaHeaders(messages) }
 */
function filesBetaHeaders(
  messages: LlmMessage[]
): { headers: { 'anthropic-beta': string } } | undefined {
  if (!hasFileBlocks(messages)) return undefined;
  return { headers: { 'anthropic-beta': 'files-api-2025-04-14' } };
}

/**
 * Normalize any Anthropic SDK error into LlmError.
 * Exported for direct unit testing of the normalization logic.
 */
export function normalizeAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // APIConnectionTimeoutError is a subclass of APIConnectionError — check it first so the
  // timeout subtype maps to kind:'timeout' rather than falling through to the generic
  // connection-error branch (which emits no kind discriminator).
  if (
    typeof Anthropic.APIConnectionTimeoutError === 'function' &&
    err instanceof Anthropic.APIConnectionTimeoutError
  ) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      kind: 'timeout',
      retryable: true,
      cause: err,
    });
  }

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
      kind: 'network',
      retryable: true,
      cause: err,
    });
  }

  // Catch all other APIError subclasses: RateLimitError (429), AuthenticationError (401),
  // InternalServerError (500), etc. Classify to specific LlmErrorKind via HTTP status.
  if (typeof Anthropic.APIError === 'function' && err instanceof Anthropic.APIError) {
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

/** Create the Anthropic provider implementation. */
export function createAnthropicProvider(config: LlmClientConfig): LlmClient {
  // Providers always receive model as a string (client.ts resolves arrays before dispatch).
  // This narrowing handles the type-level string | string[] without changing runtime behavior.
  const resolvedModel = Array.isArray(config.model) ? config.model[0]! : config.model;
  const resolvedConfig = { ...config, model: resolvedModel } as LlmClientConfig & {
    model: string;
  };

  // SDK client uses config-level timeout as the backstop. Per-call overrides are
  // enforced by createAttemptController which aborts the SDK call via signal.
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // We manage retries ourselves via withRetry
  });

  const retryOpts = {
    maxRetries: config.maxRetries ?? 3,
    baseDelayMs: config.baseDelayMs ?? 1_000,
    provider: PROVIDER,
    // Thread config.retry through to withRetry for strategy selection and retryOn filtering.
    ...(config.retry !== undefined && { retryConfig: config.retry }),
  };

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model ?? resolvedConfig.model;
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);
    // Per-call timeout overrides config default; falls back to config then hard default.
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;

    // Extract promptCache from providerOptions — Anthropic-only opt-in for prompt caching.
    // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown> — noPropertyAccessFromIndexSignature requires bracket notation
    const promptCache = options?.providerOptions?.['promptCache'] as string | undefined;

    const start = Date.now();

    return withRetry(
      async () => {
        // Fresh controller per attempt so each retry gets a full deadline.
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: Anthropic.MessageCreateParamsNonStreaming = {
            model,
            messages: anthropicMessages,
            max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
          };

          if (system !== undefined) params.system = buildSystemParam(system, promptCache);
          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) {
            params.temperature = temperature;
          }

          // timeout: effectiveTimeoutMs overrides the SDK socket deadline for this call,
          // ensuring the per-call budget matches the AbortController budget (Fix A, v0.4.2).
          // filesBetaHeaders: auto-inject 'files-api-2025-04-14' when file blocks are present.
          const response = await client.messages.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
            ...filesBetaHeaders(messages),
          });

          const content = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');

          return {
            content,
            model: response.model,
            id: response.id,
            idSource: 'provider' as const,
            usage: normalizeUsage(response.usage),
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          // classifyAbort checks whether this is an AbortError; if so, applies the
          // correct kind (timeout/cancelled/stall) based on ctl.abortReason(). If
          // not an AbortError, returns the original err so normalizeAnthropicError
          // can classify it as an HTTP/network/unknown error.
          throw normalizeAnthropicError(classifyAbort(err, ctl.abortReason(), PROVIDER));
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
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;

    // Extract promptCache from providerOptions — Anthropic-only opt-in for prompt caching.
    // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown> — noPropertyAccessFromIndexSignature requires bracket notation
    const promptCache = options?.providerOptions?.['promptCache'] as string | undefined;

    const params: Anthropic.MessageStreamParams = {
      model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
    };

    if (system !== undefined) params.system = buildSystemParam(system, promptCache);
    const streamTemperature = options?.temperature ?? config.temperature;
    if (streamTemperature !== undefined) {
      params.temperature = streamTemperature;
    }

    // Stream is a single attempt — no retry of partial streams.
    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);

    let sdkStream: Awaited<ReturnType<typeof client.messages.stream>>;

    try {
      // timeout: effectiveTimeoutMs overrides the SDK socket deadline (Fix A, v0.4.2).
      // filesBetaHeaders: auto-inject 'files-api-2025-04-14' when file blocks are present.
      sdkStream = client.messages.stream(params, {
        signal: ctl.signal,
        timeout: effectiveTimeoutMs,
        ...filesBetaHeaders(messages),
      });
    } catch (err) {
      ctl.dispose();
      throw normalizeAnthropicError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    // Accumulate usage — Anthropic sends it in the message_delta event at stream end
    let finalUsage: LlmUsage | undefined;

    try {
      // Wrap the SDK stream with stall detection. Explicitly cast the iterable so
      // TypeScript can infer the generic parameter T = Anthropic.MessageStreamEvent.
      const stallWrapped = withStallTimeout<Anthropic.MessageStreamEvent>(
        sdkStream as AsyncIterable<Anthropic.MessageStreamEvent>,
        stallMs,
        ctl,
        PROVIDER
      );
      for await (const event of stallWrapped) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { token: event.delta.text };
        } else if (event.type === 'message_delta' && 'usage' in event) {
          // Merge input tokens from message_start with output tokens from message_delta
          const accum = await sdkStream.finalMessage();
          finalUsage = normalizeUsage(accum.usage);
        }
      }
    } catch (err) {
      // Propagate as a normalized LlmError regardless of whether streaming had started.
      // Partial stream errors cannot be recovered from — the consumer must handle them.
      throw normalizeAnthropicError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    } finally {
      ctl.dispose();
    }

    // Yield usage on the final empty chunk
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

    // ── Strict path: tool-use with forced tool_choice ────────────────────────
    // Anthropic structured output uses a single tool named 'extract'. Forcing tool_choice
    // guarantees the model calls the tool rather than responding in text.
    const inputSchema = toProviderSchema(schema, 'anthropic');
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;

    // Extract promptCache from providerOptions — Anthropic-only opt-in for prompt caching.
    // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown> — noPropertyAccessFromIndexSignature requires bracket notation
    const promptCache = options?.providerOptions?.['promptCache'] as string | undefined;

    const start = Date.now();

    const response = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          // Build the tool definition. When promptCache is set, attach cache_control
          // to the last (and only) tool definition — Anthropic caches tool definitions
          // as a second cache layer independent of the system block.
          const extractTool: Anthropic.Tool =
            promptCache === 'ephemeral'
              ? {
                  name: 'extract',
                  description: 'Return the structured data.',
                  input_schema: inputSchema as Anthropic.Tool['input_schema'],
                  cache_control: { type: 'ephemeral' },
                }
              : {
                  name: 'extract',
                  description: 'Return the structured data.',
                  input_schema: inputSchema as Anthropic.Tool['input_schema'],
                };

          const params: Anthropic.MessageCreateParamsNonStreaming = {
            model: options?.model ?? resolvedConfig.model,
            messages: anthropicMessages,
            max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
            tools: [extractTool],
            tool_choice: { type: 'tool', name: 'extract' },
          };

          if (system !== undefined) params.system = buildSystemParam(system, promptCache);
          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // timeout: effectiveTimeoutMs overrides the SDK socket deadline (Fix A, v0.4.2).
          // filesBetaHeaders: auto-inject 'files-api-2025-04-14' when file blocks are present.
          return await client.messages.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
            ...filesBetaHeaders(messages),
          });
        } catch (err) {
          throw normalizeAnthropicError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    // Extract the tool_use block from the response content
    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'extract'
    );

    if (toolBlock === undefined) {
      // Model responded in text instead of calling the tool — unexpected, non-retryable
      const textContent = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      throw new LlmError({
        message: `Anthropic structured: model did not call the extract tool (stop_reason=${response.stop_reason}). Text: ${textContent.slice(0, 200)}`,
        provider: PROVIDER,
        retryable: false,
        kind: 'unknown',
      });
    }

    // tool_use.input is already parsed JSON — no JSON.parse() needed
    let data: T;
    try {
      data = schema.parse(toolBlock.input); // defense-in-depth
    } catch (err) {
      throw new LlmError({
        message: `Anthropic structured output: tool response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      model: response.model,
      id: response.id,
      idSource: 'provider' as const,
      usage: normalizeUsage(response.usage),
      latencyMs: Date.now() - start,
    };
  }

  /**
   * streamStructured() — stream tokens from Anthropic messages.stream() and validate at end (v1.3.0+).
   *
   * Uses the same forced tool-use path as structured() (tool named 'extract', tool_choice: tool).
   * Anthropic streams the tool input as `input_json_delta` events — these are raw JSON fragment
   * strings that assemble into the full JSON object. We yield each delta as a 'token' event
   * so callers can show typing progress, then validate the accumulated JSON at stream end.
   *
   * usage: pulled from finalMessage() after the stream ends (same pattern as stream()).
   *
   * AbortSignal and stall detection are wired the same as stream().
   */
  async function* streamStructured<T>(
    messages: LlmMessage[],
    schema: { parse: (data: unknown) => T },
    options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const stallMs = options?.streamStallTimeoutMs ?? config.streamStallTimeoutMs ?? 30_000;
    // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown> — noPropertyAccessFromIndexSignature requires bracket notation
    const promptCache = options?.providerOptions?.['promptCache'] as string | undefined;

    // Build the 'extract' tool — same forced tool-use path as structured().
    const inputSchema = toProviderSchema(schema as import('zod').ZodType, 'anthropic');
    const extractTool: Anthropic.Tool =
      promptCache === 'ephemeral'
        ? {
            name: 'extract',
            description: 'Return the structured data.',
            input_schema: inputSchema as Anthropic.Tool['input_schema'],
            cache_control: { type: 'ephemeral' },
          }
        : {
            name: 'extract',
            description: 'Return the structured data.',
            input_schema: inputSchema as Anthropic.Tool['input_schema'],
          };

    const params: Anthropic.MessageStreamParams = {
      model: options?.model ?? resolvedConfig.model,
      messages: anthropicMessages,
      max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
      tools: [extractTool],
      tool_choice: { type: 'tool', name: 'extract' },
    };

    if (system !== undefined) params.system = buildSystemParam(system, promptCache);
    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;

    const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
    let sdkStream: Awaited<ReturnType<typeof client.messages.stream>>;

    try {
      // filesBetaHeaders: auto-inject 'files-api-2025-04-14' when file blocks are present.
      sdkStream = client.messages.stream(params, {
        signal: ctl.signal,
        timeout: effectiveTimeoutMs,
        ...filesBetaHeaders(messages),
      });
    } catch (err) {
      ctl.dispose();
      throw normalizeAnthropicError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    }

    let fullText = '';
    let finalUsage: LlmUsage | undefined;

    try {
      const stallWrapped = withStallTimeout<Anthropic.MessageStreamEvent>(
        sdkStream as AsyncIterable<Anthropic.MessageStreamEvent>,
        stallMs,
        ctl,
        PROVIDER
      );
      for await (const event of stallWrapped) {
        // input_json_delta events carry the streamed JSON fragments from tool input.
        // We yield each fragment as a 'token' event for typing-progress UIs.
        if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          const delta = event.delta.partial_json;
          if (delta !== undefined && delta.length > 0) {
            fullText += delta;
            yield { type: 'token', token: delta };
          }
        } else if (event.type === 'message_delta' && 'usage' in event) {
          const accum = await sdkStream.finalMessage();
          finalUsage = normalizeUsage(accum.usage);
        }
      }
    } catch (err) {
      throw normalizeAnthropicError(classifyAbort(err, ctl.abortReason(), PROVIDER));
    } finally {
      ctl.dispose();
    }

    // Parse and validate the accumulated JSON — throw structured_parse_failed if invalid.
    let parsed: unknown;
    try {
      parsed = JSON.parse(fullText);
    } catch (err) {
      throw new LlmError({
        message: `Anthropic streamStructured: accumulated text is not valid JSON. Raw: ${fullText.slice(0, 200)}`,
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
        message: `Anthropic streamStructured: response failed schema validation. ${String(err)}`,
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
   * providerOptions.structuredMode === 'prompt'. Preserves v0.3.0 behavior exactly.
   * promptCache flows through via options → complete(), which reads providerOptions.promptCache.
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
    const start = Date.now();

    const response = await complete(augmentedMessages, options);

    // parseJsonOrThrow: tries extractJsonBlock first (handles fences, prose, no closing fence),
    // falls back to legacy strip+parse, then throws a non-retryable LlmError with a
    // ≥500-char raw content slice when no valid JSON can be extracted.
    const parsed = parseJsonOrThrow(response.content, PROVIDER);

    let data: T;
    try {
      data = schema.parse(parsed);
    } catch (err) {
      throw new LlmError({
        message: `Anthropic structured output: response failed schema validation. ${String(err)}`,
        provider: PROVIDER,
        kind: 'structured_parse_failed',
        retryable: false,
        cause: err,
      });
    }

    return {
      data,
      model: response.model,
      id: response.id,
      idSource: 'provider' as const,
      usage: response.usage,
      latencyMs: Date.now() - start,
    };
  }

  /**
   * withTools() — native tool calling via Anthropic messages.create.
   *
   * Tool shape (Tom §2.1): { name, description, input_schema }
   * parallelToolCalls === false → disable_parallel_tool_use: true on tool_choice (inverse semantics,
   * Tom §2.3). Anthropic does not have a parallel_tool_calls top-level param.
   *
   * toolChoice mapping:
   *   'auto'      → { type: 'auto' }
   *   'any'       → { type: 'any' }  (Anthropic: model must call at least one tool)
   *   'none'      → { type: 'none' }
   *   { name: X } → { type: 'tool', name: X }
   * When parallelToolCalls === false, disable_parallel_tool_use: true is added to the
   * toolChoice object (not a top-level param).
   */
  async function withTools(
    messages: LlmMessage[],
    tools: LlmTool[],
    options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    const { system, messages: anthropicMessages } = buildAnthropicMessages(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    // Build Anthropic tool definitions — switch on the LlmToolSchema kind discriminant
    const anthropicTools: Anthropic.Tool[] = tools.map((t) => {
      let schemaForProvider: JsonNode;
      switch (t.inputSchema.kind) {
        case 'zod':
          schemaForProvider = toProviderSchema(t.inputSchema.schema, 'anthropic') as JsonNode;
          break;
        case 'jsonSchema':
          schemaForProvider = t.inputSchema.schema as JsonNode;
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
        input_schema: schemaForProvider as Anthropic.Tool['input_schema'],
      };
    });

    const disableParallel = options?.parallelToolCalls === false;

    // Build typed ToolChoice — use typed interfaces, not bare strings (Tom §2.2)
    function buildToolChoice(tc: LlmCallWithToolsOptions['toolChoice']): Anthropic.ToolChoice {
      if (tc === undefined || tc === 'auto') {
        return disableParallel
          ? { type: 'auto', disable_parallel_tool_use: true }
          : { type: 'auto' };
      }
      if (tc === 'any') {
        return disableParallel ? { type: 'any', disable_parallel_tool_use: true } : { type: 'any' };
      }
      if (tc === 'none') {
        // ToolChoiceNone does not support disable_parallel_tool_use
        return { type: 'none' };
      }
      // Named tool
      return disableParallel
        ? { type: 'tool', name: tc.name, disable_parallel_tool_use: true }
        : { type: 'tool', name: tc.name };
    }

    const response = await withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          const params: Anthropic.MessageCreateParamsNonStreaming = {
            model: options?.model ?? resolvedConfig.model,
            messages: anthropicMessages,
            max_tokens: options?.maxTokens ?? config.maxTokens ?? 1024,
            tools: anthropicTools,
            tool_choice: buildToolChoice(options?.toolChoice),
          };

          if (system !== undefined) params.system = system;
          const temperature = options?.temperature ?? config.temperature;
          if (temperature !== undefined) params.temperature = temperature;

          // filesBetaHeaders: auto-inject 'files-api-2025-04-14' when file blocks are present.
          return await client.messages.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
            ...filesBetaHeaders(messages),
          });
        } catch (err) {
          throw normalizeAnthropicError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );

    // Extract text content and tool_use blocks from response
    const textParts: string[] = [];
    const toolCalls: LlmToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        const rawArgs = JSON.stringify(block.input);
        let parsedArgs: unknown = block.input; // already parsed by Anthropic SDK

        // Validate against the tool's inputSchema
        const tool = tools.find((t) => t.name === block.name);
        if (tool !== undefined) {
          try {
            parsedArgs =
              tool.inputSchema.kind === 'zod'
                ? tool.inputSchema.schema.parse(block.input)
                : tool.inputSchema.validate
                  ? tool.inputSchema.validate(block.input)
                  : block.input;
          } catch (err) {
            throw new LlmError({
              message: `Anthropic withTools: arguments for tool '${block.name}' failed schema validation. ${String(err)}`,
              provider: PROVIDER,
              kind: 'tool_arguments_invalid',
              retryable: false,
              cause: err,
            });
          }
        }

        // Preserve tool_use_id as LlmToolCall.id (Tom §2.4)
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          arguments: parsedArgs,
          rawArguments: rawArgs,
        });
      }
    }

    // Map Anthropic stop_reason to LlmToolResponse.stopReason
    function mapStopReason(reason: string | null): LlmToolResponse['stopReason'] {
      switch (reason) {
        case 'tool_use':
          return 'tool_use';
        case 'end_turn':
          return 'end_turn';
        case 'max_tokens':
          return 'max_tokens';
        case 'stop_sequence':
          return 'stop_sequence';
        case 'pause_turn':
          return 'pause_turn';
        case 'refusal':
          return 'refusal';
        default:
          return 'end_turn';
      }
    }

    return {
      content: textParts.join(''),
      toolCalls,
      model: response.model,
      id: response.id,
      idSource: 'provider' as const,
      usage: normalizeUsage(response.usage),
      latencyMs: Date.now() - start,
      stopReason: mapStopReason(response.stop_reason),
    };
  }

  // ─── Files API (v5.1.0) ──────────────────────────────────────────────────────

  /**
   * Anthropic Files API (beta: 'files-api-2025-04-14').
   *
   * Supports: application/pdf and image/* (JPEG, PNG, GIF, WebP) uploads.
   * Video uploads are rejected with bad_request — Anthropic does not support video.
   *
   * Refs are immediately active on return (no async processing).
   * waitForActive() and refresh() are no-ops.
   *
   * The beta header 'files-api-2025-04-14' is sent with every upload call.
   * Message calls that reference uploaded files also need this beta header —
   * the Anthropic provider passes betas automatically when a file block is present.
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
      // Anthropic Files beta supports PDF and image/*. Video is not supported.
      if (mediaType.startsWith('video/')) {
        throw new LlmError({
          message:
            `[llm-client] Provider 'anthropic' does not support media type '${mediaType}' via Files API.` +
            ` Only 'application/pdf' and image/* are accepted by the Anthropic Files beta.`,
          provider: PROVIDER,
          kind: 'bad_request',
          retryable: false,
        });
      }

      const filename = displayName ?? (mediaType === 'application/pdf' ? 'upload.pdf' : 'upload');
      // Convert Buffer | Uint8Array to typed Uint8Array to satisfy File constructor types.
      const fileBlob = new File([new Uint8Array(data)], filename, { type: mediaType });

      try {
        // Anthropic Files beta — betas param passed in the request body alongside file.
        const response = await client.beta.files.upload({
          file: fileBlob,
          betas: ['files-api-2025-04-14'],
        });

        return {
          id: response.id,
          provider: 'anthropic' as const,
          mediaType,
          sizeBytes: (data as Buffer).length,
          state: 'active' as const,
          // Anthropic does not return an expiry for Files beta objects
        };
      } catch (err) {
        if (err instanceof LlmError) throw err;
        throw normalizeAnthropicFilesError(err, 'upload');
      }
    },

    /**
     * Anthropic refs are always active on return — no async processing.
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
     * No-op for Anthropic — refs are always active on upload return.
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
     * Delete a file from Anthropic's Files beta store. Swallows 404.
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
        // Anthropic Files beta — betas param passed in the request body alongside file_id.
        await client.beta.files.delete(ref.id, {
          betas: ['files-api-2025-04-14'],
        });
      } catch (err) {
        if (err instanceof Anthropic.NotFoundError) return;
        throw normalizeAnthropicFilesError(err, 'delete');
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
 * Normalize Anthropic Files API errors to LlmError.
 */
function normalizeAnthropicFilesError(err: unknown, operation: string): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError({
      message: `[llm-client] Files API network error: ${err.message} (${operation})`,
      provider: PROVIDER,
      kind: 'network',
      retryable: true,
      cause: err,
    });
  }

  if (err instanceof Anthropic.APIError && err.status !== undefined) {
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
