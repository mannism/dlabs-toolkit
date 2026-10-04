/**
 * xAI (Grok) provider for @diabolicallabs/llm-client.
 *
 * Implements: complete(), stream(), structured(), streamStructured(), withTools()
 *
 * API surface: the OpenAI Responses API served by xAI at https://api.x.ai/v1, driven through the
 * `openai` SDK with a custom baseURL. Server-side tools ONLY work on `POST /v1/responses` —
 * `/v1/chat/completions` rejects `x_search` — so the DeepSeek/Perplexity (Chat Completions)
 * adapters are not templates; this file mirrors providers/openai.ts (Responses API) but is
 * standalone on purpose: openai.ts is a live dependency of GEOAudit and is left untouched.
 *
 * Server-side tools (providerOptions.serverTools, camelCase XaiServerTool → snake_case wire):
 *   xSearch, webSearch, codeInterpreter, fileSearch, mcp, imageGeneration.
 *   Validated pre-flight (LlmError kind 'bad_request', zero network calls).
 *
 * Verified live facts (2026-10-04) this adapter encodes:
 *   - Citations arrive ONLY as `url_citation` annotations on output_text (streaming:
 *     `response.output_text.annotation.added`) and as `web_search_call.action.sources[].url`.
 *     The documented top-level `citations` array is absent, so it is never relied on.
 *   - `usage.input_tokens` INCLUDES `input_tokens_details.cached_tokens` — normalized to the
 *     Anthropic convention (inputTokens = uncached, cacheReadTokens = cached) that computeCost()
 *     assumes.
 *   - `usage.server_side_tool_usage_details` carries tool counts; `usage.cost_in_usd_ticks` is
 *     xAI's billed cost (1 USD = 1e10 ticks).
 *
 * Error mapping mirrors the OpenAI provider:
 *   APIConnectionTimeoutError → kind:'timeout', retryable:true
 *   APIConnectionError → kind:'network', retryable:true
 *   APIError.status → classifyHttpStatus() → LlmError.kind + retryable flag
 */

import OpenAI from 'openai';
import { classifyAbort, createAttemptController } from '../abort.js';
import { getModelCapabilities } from '../capabilities.js';
import { getLogger } from '../logger.js';
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
  LlmFilesApi,
  LlmImage,
  LlmMessage,
  LlmResponse,
  LlmServerToolCall,
  LlmStreamChunk,
  LlmStreamStructuredEvent,
  LlmStructuredResponse,
  LlmTool,
  LlmToolResponse,
  LlmUsage,
  XaiServerTool,
} from '../types.js';
import { LlmError } from '../types.js';
import { assertBlocksSupported, mapOpenAIContent } from './content-blocks.js';
import { resolveReasoningEffort } from './reasoning-effort.js';

const PROVIDER = 'xai';

/** xAI's OpenAI-compatible endpoint root. */
const XAI_BASE_URL = 'https://api.x.ai/v1';

/** xAI limits on tool filter lists. Enforced pre-flight so a bad request costs no network call. */
const MAX_X_HANDLES = 20;
const MAX_DOMAINS = 5;

/** xAI bills in ticks: 1 USD = 1e10 ticks (verified against a live response, 2026-10-04). */
const TICKS_PER_USD = 1e10;

// ─── Small runtime-validation helpers (no `any`, no trust in wire shapes) ─────

/** True for plain JSON objects (not arrays / null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow an unknown value to a typed wire view. Leaves stay `unknown` and are checked per use. */
function asWire<T extends object>(value: unknown): T | undefined {
  return isRecord(value) ? (value as T) : undefined;
}

/** Finite number or undefined. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Non-empty string or undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Throw the standard pre-flight validation error. Never reaches the network. */
function badRequest(message: string): never {
  throw new LlmError({
    message: `[llm-client] xai: ${message}`,
    provider: PROVIDER,
    kind: 'bad_request',
    retryable: false,
  });
}

// ─── Wire shapes (only the fields this adapter reads) ─────────────────────────

/** `usage` as returned by xAI. Leaves are `unknown` — each is validated where used. */
interface XaiWireUsage {
  input_tokens?: unknown;
  input_tokens_details?: unknown;
  output_tokens?: unknown;
  output_tokens_details?: unknown;
  total_tokens?: unknown;
  server_side_tool_usage_details?: unknown;
  cost_in_usd_ticks?: unknown;
}

/** A single output item. `type` discriminates; other fields are read defensively. */
interface XaiWireItem {
  type?: unknown;
  status?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
  call_id?: unknown;
  code?: unknown;
  result?: unknown;
  prompt?: unknown;
  server_label?: unknown;
  queries?: unknown;
  action?: unknown;
  content?: unknown;
}

/** An `output_text` / `refusal` content part on a message item. */
interface XaiWireContentPart {
  type?: unknown;
  text?: unknown;
  refusal?: unknown;
  annotations?: unknown;
}

/** A `url_citation` annotation. */
interface XaiWireAnnotation {
  type?: unknown;
  url?: unknown;
  title?: unknown;
}

/** `web_search_call.action`. */
interface XaiWireSearchAction {
  query?: unknown;
  sources?: unknown;
}

// ─── Server tool mapping + validation ─────────────────────────────────────────

/** Validate an optional string[] field; returns undefined when absent. */
function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0)) {
    badRequest(`${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

/** Validate an optional boolean field. */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') badRequest(`${field} must be a boolean`);
  return value;
}

/** Validate an optional `YYYY-MM-DD` calendar date. */
function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    badRequest(`${field} must be a YYYY-MM-DD date string`);
  }
  // Round-trip catches impossible dates such as 2026-02-31 that the regex alone accepts.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    badRequest(`${field} must be a valid calendar date (YYYY-MM-DD)`);
  }
  return value;
}

/** Validate a required non-empty string. */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    badRequest(`${field} is required and must be a non-empty string`);
  }
  return value;
}

/** Enforce "allow list XOR exclude list" and the per-list size cap. */
function assertListPair(
  allow: string[] | undefined,
  exclude: string[] | undefined,
  max: number,
  names: { allow: string; exclude: string }
): void {
  if (allow !== undefined && exclude !== undefined) {
    badRequest(`${names.allow} and ${names.exclude} are mutually exclusive — set only one`);
  }
  if (allow !== undefined && allow.length > max) {
    badRequest(`${names.allow} accepts at most ${max} entries (got ${allow.length})`);
  }
  if (exclude !== undefined && exclude.length > max) {
    badRequest(`${names.exclude} accepts at most ${max} entries (got ${exclude.length})`);
  }
}

/**
 * Map one in-process camelCase XaiServerTool to xAI's snake_case wire object, validating it first.
 * Unknown tool types and malformed fields throw LlmError({ kind: 'bad_request' }) — no network call.
 * `authorization` / `headers` are forwarded to the MCP server but are never logged anywhere.
 */
function mapServerTool(raw: unknown): Record<string, unknown> {
  const tool = asWire<Record<string, unknown> & { type?: unknown }>(raw);
  if (tool === undefined) badRequest('each serverTools entry must be an object with a type');
  const type = tool['type'];

  switch (type) {
    case 'xSearch': {
      const allowed = optionalStringArray(tool['allowedXHandles'], 'xSearch.allowedXHandles');
      const excluded = optionalStringArray(tool['excludedXHandles'], 'xSearch.excludedXHandles');
      assertListPair(allowed, excluded, MAX_X_HANDLES, {
        allow: 'xSearch.allowedXHandles',
        exclude: 'xSearch.excludedXHandles',
      });
      const fromDate = optionalDate(tool['fromDate'], 'xSearch.fromDate');
      const toDate = optionalDate(tool['toDate'], 'xSearch.toDate');
      const img = optionalBoolean(
        tool['enableImageUnderstanding'],
        'xSearch.enableImageUnderstanding'
      );
      const vid = optionalBoolean(
        tool['enableVideoUnderstanding'],
        'xSearch.enableVideoUnderstanding'
      );
      return {
        type: 'x_search',
        ...(allowed !== undefined && { allowed_x_handles: allowed }),
        ...(excluded !== undefined && { excluded_x_handles: excluded }),
        ...(fromDate !== undefined && { from_date: fromDate }),
        ...(toDate !== undefined && { to_date: toDate }),
        ...(img !== undefined && { enable_image_understanding: img }),
        ...(vid !== undefined && { enable_video_understanding: vid }),
      };
    }
    case 'webSearch': {
      const allowed = optionalStringArray(tool['allowedDomains'], 'webSearch.allowedDomains');
      const excluded = optionalStringArray(tool['excludedDomains'], 'webSearch.excludedDomains');
      assertListPair(allowed, excluded, MAX_DOMAINS, {
        allow: 'webSearch.allowedDomains',
        exclude: 'webSearch.excludedDomains',
      });
      const img = optionalBoolean(
        tool['enableImageUnderstanding'],
        'webSearch.enableImageUnderstanding'
      );
      const imgSearch = optionalBoolean(tool['enableImageSearch'], 'webSearch.enableImageSearch');
      return {
        type: 'web_search',
        ...(allowed !== undefined && { allowed_domains: allowed }),
        ...(excluded !== undefined && { excluded_domains: excluded }),
        ...(img !== undefined && { enable_image_understanding: img }),
        ...(imgSearch !== undefined && { enable_image_search: imgSearch }),
      };
    }
    case 'codeInterpreter':
      return { type: 'code_interpreter' };
    case 'fileSearch': {
      const ids = optionalStringArray(tool['vectorStoreIds'], 'fileSearch.vectorStoreIds');
      if (ids === undefined || ids.length === 0) {
        badRequest('fileSearch.vectorStoreIds is required and must not be empty');
      }
      const max = tool['maxNumResults'];
      if (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1)) {
        badRequest('fileSearch.maxNumResults must be a positive integer');
      }
      return {
        type: 'file_search',
        vector_store_ids: ids,
        ...(typeof max === 'number' && { max_num_results: max }),
      };
    }
    case 'mcp': {
      const serverUrl = requiredString(tool['serverUrl'], 'mcp.serverUrl');
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(serverUrl);
      } catch {
        return badRequest('mcp.serverUrl must be a valid absolute URL');
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        badRequest('mcp.serverUrl must use http or https');
      }
      const serverLabel = requiredString(tool['serverLabel'], 'mcp.serverLabel');
      const description = tool['serverDescription'];
      if (description !== undefined && typeof description !== 'string') {
        badRequest('mcp.serverDescription must be a string');
      }
      const allowedTools = optionalStringArray(tool['allowedTools'], 'mcp.allowedTools');
      const authorization = tool['authorization'];
      if (authorization !== undefined && typeof authorization !== 'string') {
        badRequest('mcp.authorization must be a string');
      }
      const headers = tool['headers'];
      if (headers !== undefined) {
        if (!isRecord(headers) || Object.values(headers).some((v) => typeof v !== 'string')) {
          badRequest('mcp.headers must be an object of string values');
        }
      }
      return {
        type: 'mcp',
        server_url: serverUrl,
        server_label: serverLabel,
        ...(typeof description === 'string' && { server_description: description }),
        ...(allowedTools !== undefined && { allowed_tools: allowedTools }),
        ...(typeof authorization === 'string' && { authorization }),
        ...(headers !== undefined && { headers }),
      };
    }
    case 'imageGeneration':
      return { type: 'image_generation' };
    default:
      return badRequest(
        `unknown serverTools type '${String(type)}'. Supported: xSearch, webSearch, codeInterpreter, fileSearch, mcp, imageGeneration`
      );
  }
}

/**
 * Validate and map `providerOptions.serverTools` to the wire array.
 * Returns undefined when no server tools are requested.
 */
export function buildXaiServerTools(
  providerOptions: Record<string, unknown> | undefined
): Record<string, unknown>[] | undefined {
  // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown> — noPropertyAccessFromIndexSignature requires bracket notation
  const raw = providerOptions?.['serverTools'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) badRequest('providerOptions.serverTools must be an array');
  if (raw.length === 0) return undefined;
  return (raw as XaiServerTool[]).map((t) => mapServerTool(t));
}

/**
 * Resolve reasoning effort for xai: rejects 'none' / 'max' (xAI 400s on them) and any effort on a
 * model whose capability entry says it takes none, all before any network call.
 */
function resolveXaiEffort(
  effort: LlmCallOptions['reasoningEffort'],
  model: string
): string | undefined {
  const resolved = resolveReasoningEffort(effort, PROVIDER);
  if (resolved === undefined) return undefined;
  const caps = getModelCapabilities(PROVIDER, model);
  if (caps !== null && caps.reasoningEffort === null) {
    badRequest(`model '${model}' does not accept reasoningEffort ('${resolved}' was set)`);
  }
  return resolved;
}

/** Streaming and non-streaming request params share every field applyXaiParams() writes. */
type XaiRequestParams =
  | OpenAI.Responses.ResponseCreateParamsNonStreaming
  | OpenAI.Responses.ResponseCreateParamsStreaming;

/**
 * Apply the xai-specific request knobs shared by every call type: server tools,
 * max_tool_calls, inline citations and reasoning effort. Mutates `params`.
 * `extraTools` are caller function tools (withTools) merged after the server tools.
 */
function applyXaiParams(
  params: XaiRequestParams,
  model: string,
  options: LlmCallOptions | undefined,
  extraTools: OpenAI.Responses.FunctionTool[] = []
): void {
  const serverTools = buildXaiServerTools(options?.providerOptions);
  const allTools = [...(serverTools ?? []), ...extraTools];
  if (allTools.length > 0) {
    // xAI server tool objects (x_search, mcp, ...) are not in the SDK's Tool union; the wire
    // shape is validated by mapServerTool() above, so the widening cast is safe.
    params.tools = allTools as unknown as OpenAI.Responses.Tool[];
  }

  // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown>
  const maxToolCalls = options?.providerOptions?.['maxToolCalls'];
  if (maxToolCalls !== undefined) {
    if (typeof maxToolCalls !== 'number' || !Number.isInteger(maxToolCalls) || maxToolCalls < 1) {
      badRequest('providerOptions.maxToolCalls must be a positive integer');
    }
    // max_tool_calls is accepted by xAI but absent from the installed SDK's param types (7.18);
    // the SDK serializes the params object verbatim, so extra keys reach the wire.
    Object.assign(params, { max_tool_calls: maxToolCalls });
  }

  // biome-ignore lint/complexity/useLiteralKeys: providerOptions is Record<string,unknown>
  const inlineCitations = options?.providerOptions?.['inlineCitations'];
  if (inlineCitations !== undefined) {
    if (typeof inlineCitations !== 'boolean') {
      badRequest('providerOptions.inlineCitations must be a boolean');
    }
    if (inlineCitations) {
      // 'inline_citations' is an xAI-specific includable absent from the SDK's union.
      params.include = ['inline_citations'] as unknown as OpenAI.Responses.ResponseIncludable[];
    }
  }

  const effort = resolveXaiEffort(options?.reasoningEffort, model);
  if (effort !== undefined) {
    params.reasoning = {
      ...params.reasoning,
      effort: effort as NonNullable<OpenAI.Reasoning['effort']>,
    };
  }
}

// ─── Response normalization ───────────────────────────────────────────────────

/** xAI `server_side_tool_usage_details` key → in-process ServerToolUsageKey. */
const TOOL_USAGE_KEY_MAP = {
  web_search_calls: 'webSearchCalls',
  x_search_calls: 'xSearchCalls',
  x_posts_fetched: 'xPostsFetched',
  x_users_fetched: 'xUsersFetched',
  code_interpreter_calls: 'codeInterpreterCalls',
  file_search_calls: 'fileSearchCalls',
  mcp_calls: 'mcpCalls',
  image_generation_calls: 'imageGenerationCalls',
} as const;

/**
 * Normalize xAI usage to LlmUsage.
 *
 * input_tokens INCLUDES cached_tokens, so inputTokens = input - cached and cacheReadTokens =
 * cached (the convention computeCost() assumes). serverToolUsage is camelCase with zero counts
 * omitted. providerReportedCostUsd = cost_in_usd_ticks / 1e10. Exported for unit tests.
 */
export function normalizeXaiUsage(usage: unknown): LlmUsage {
  const u = asWire<XaiWireUsage>(usage) ?? {};
  const totalInput = asNumber(u.input_tokens) ?? 0;
  const details = asWire<{ cached_tokens?: unknown }>(u.input_tokens_details);
  const cached = asNumber(details?.cached_tokens);
  const outputTokens = asNumber(u.output_tokens) ?? 0;
  const outDetails = asWire<{ reasoning_tokens?: unknown }>(u.output_tokens_details);
  const reasoningTokens = asNumber(outDetails?.reasoning_tokens);
  const inputTokens = Math.max(0, totalInput - (cached ?? 0));

  const toolDetails = asWire<Record<string, unknown>>(u.server_side_tool_usage_details);
  const serverToolUsage: NonNullable<LlmUsage['serverToolUsage']> = {};
  if (toolDetails !== undefined) {
    for (const [wireKey, key] of Object.entries(TOOL_USAGE_KEY_MAP)) {
      const count = asNumber(toolDetails[wireKey]);
      if (count !== undefined && count > 0) serverToolUsage[key] = count;
    }
  }

  const ticks = asNumber(u.cost_in_usd_ticks);

  return {
    inputTokens,
    outputTokens,
    totalTokens: asNumber(u.total_tokens) ?? totalInput + outputTokens,
    ...(cached !== undefined && { cacheReadTokens: cached }),
    ...(reasoningTokens !== undefined && { reasoningTokens }),
    ...(Object.keys(serverToolUsage).length > 0 && { serverToolUsage }),
    ...(ticks !== undefined && { providerReportedCostUsd: ticks / TICKS_PER_USD }),
  };
}

/** Citation accumulator: deduplicates by URL, keeps first-seen order and first non-trivial title. */
class CitationSet {
  private readonly seen = new Map<string, { url: string; title?: string }>();

  add(url: string | undefined, title?: unknown): void {
    if (url === undefined) return;
    // xAI labels annotations with their ordinal ("1", "2") — noise, not a title.
    const cleanTitle =
      typeof title === 'string' && title.length > 0 && !/^\d+$/.test(title) ? title : undefined;
    const existing = this.seen.get(url);
    if (existing === undefined) {
      this.seen.set(url, cleanTitle !== undefined ? { url, title: cleanTitle } : { url });
    } else if (existing.title === undefined && cleanTitle !== undefined) {
      existing.title = cleanTitle;
    }
  }

  /** Undefined when empty so the response omits the field (matches Perplexity behavior). */
  toArray(): Array<{ url: string; title?: string }> | undefined {
    return this.seen.size > 0 ? [...this.seen.values()] : undefined;
  }
}

/** Everything extracted from one response's output[]. */
interface ParsedXaiOutput {
  text: string;
  refusal: string | undefined;
  citations: Array<{ url: string; title?: string }> | undefined;
  images: LlmImage[] | undefined;
  serverToolCalls: LlmServerToolCall[] | undefined;
  /** Raw function_call items — caller function tools, handled by withTools(). */
  functionCalls: Array<{ callId: string | undefined; name: string; args: string }>;
}

/** Statuses are free-form strings on the wire; default when missing. */
function statusOf(item: XaiWireItem): string {
  return asString(item.status) ?? 'unknown';
}

/**
 * Walk output[] once and extract text, citations, images, the server tool audit trail and
 * function calls. Server tool items never become function calls. Unrecognized item types are
 * logged (not silently dropped) so new xAI tool types surface in operations.
 * Exported for unit tests.
 */
export function parseXaiOutput(output: unknown): ParsedXaiOutput {
  const citations = new CitationSet();
  const images: LlmImage[] = [];
  const serverToolCalls: LlmServerToolCall[] = [];
  const functionCalls: ParsedXaiOutput['functionCalls'] = [];
  let text = '';
  let refusal: string | undefined;

  const items = Array.isArray(output) ? output : [];
  for (const rawItem of items) {
    const item = asWire<XaiWireItem>(rawItem);
    if (item === undefined) continue;
    const type = item.type;

    if (type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const rawPart of parts) {
        const part = asWire<XaiWireContentPart>(rawPart);
        if (part === undefined) continue;
        if (part.type === 'output_text') {
          if (typeof part.text === 'string') text += part.text;
          const annotations = Array.isArray(part.annotations) ? part.annotations : [];
          for (const rawAnn of annotations) {
            const ann = asWire<XaiWireAnnotation>(rawAnn);
            if (ann?.type === 'url_citation') citations.add(asString(ann.url), ann.title);
          }
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          refusal = part.refusal;
        }
      }
    } else if (type === 'function_call') {
      functionCalls.push({
        callId: asString(item.call_id),
        name: asString(item.name) ?? '',
        args: typeof item.arguments === 'string' ? item.arguments : '',
      });
    } else if (type === 'web_search_call') {
      const action = asWire<XaiWireSearchAction>(item.action);
      const sources: string[] = [];
      for (const rawSrc of Array.isArray(action?.sources) ? action.sources : []) {
        const src = asWire<{ url?: unknown }>(rawSrc);
        const url = asString(src?.url);
        if (url !== undefined) {
          sources.push(url);
          citations.add(url);
        }
      }
      const query = asString(action?.query);
      serverToolCalls.push({
        type: 'webSearch',
        status: statusOf(item),
        ...(query !== undefined && { input: query }),
        ...(sources.length > 0 && { sources }),
      });
    } else if (type === 'custom_tool_call') {
      // x_search runs as custom_tool_call items named x_keyword_search / x_semantic_search /
      // x_user_search. Anything else is unrecognized and logged below.
      const name = asString(item.name);
      if (name !== undefined && name.startsWith('x_')) {
        const input = asString(item.input);
        serverToolCalls.push({
          type: 'xSearch',
          name,
          status: statusOf(item),
          ...(input !== undefined && { input }),
        });
      } else {
        getLogger().warn('xai_unrecognized_output_item', { type: 'custom_tool_call', name });
      }
    } else if (type === 'code_interpreter_call') {
      const code = asString(item.code);
      serverToolCalls.push({
        type: 'codeInterpreter',
        status: statusOf(item),
        ...(code !== undefined && { input: code }),
      });
    } else if (type === 'file_search_call') {
      const queries = Array.isArray(item.queries)
        ? item.queries.filter((q): q is string => typeof q === 'string').join('\n')
        : '';
      serverToolCalls.push({
        type: 'fileSearch',
        status: statusOf(item),
        ...(queries.length > 0 && { input: queries }),
      });
    } else if (type === 'mcp_call') {
      const name = asString(item.name);
      const label = asString(item.server_label);
      const input = asString(item.arguments);
      // Deliberately NOT copying authorization/headers: they are request secrets.
      serverToolCalls.push({
        type: 'mcp',
        status: statusOf(item),
        ...(name !== undefined && { name }),
        ...(label !== undefined && { serverLabel: label }),
        ...(input !== undefined && { input }),
      });
    } else if (type === 'image_generation_call') {
      const data = asString(item.result);
      const prompt = asString(item.prompt);
      if (data !== undefined) {
        images.push({ data, mediaType: 'image/jpeg', ...(prompt !== undefined && { prompt }) });
      }
      // The audit entry carries the prompt only — never the base64 payload.
      serverToolCalls.push({
        type: 'imageGeneration',
        status: statusOf(item),
        ...(prompt !== undefined && { input: prompt }),
      });
    } else if (type === 'reasoning') {
      // Reasoning summaries/encrypted content are not surfaced.
    } else {
      getLogger().warn('xai_unrecognized_output_item', { type: String(type) });
    }
  }

  return {
    text,
    refusal,
    citations: citations.toArray(),
    images: images.length > 0 ? images : undefined,
    serverToolCalls: serverToolCalls.length > 0 ? serverToolCalls : undefined,
    functionCalls,
  };
}

/**
 * Convert LlmMessages to Responses API input. Text and image blocks only: PDFs and Files API
 * refs are not wired for xai (out of scope), so they fail fast before any network call.
 */
function buildResponsesInput(messages: LlmMessage[]): OpenAI.Responses.EasyInputMessage[] {
  assertBlocksSupported(messages, PROVIDER, {
    textBlock: true,
    imageBase64: true,
    imageUrl: true,
    documentBase64: false,
    fileRef: false,
  });

  return messages.map((m) => {
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: mapOpenAIContent(m.content),
      } as OpenAI.Responses.EasyInputMessage;
    }
    return { role: m.role, content: m.content } as OpenAI.Responses.EasyInputMessage;
  });
}

/**
 * Normalize any OpenAI SDK error (the SDK is used against api.x.ai) into LlmError.
 * Exported for direct unit testing.
 */
export function normalizeXaiError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  // Timeout subtype first: APIConnectionTimeoutError extends APIConnectionError.
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

  if (typeof OpenAI.APIConnectionError === 'function' && err instanceof OpenAI.APIConnectionError) {
    return new LlmError({
      message: err.message,
      provider: PROVIDER,
      kind: 'network',
      retryable: true,
      cause: err,
    });
  }

  if (typeof OpenAI.APIError === 'function' && err instanceof OpenAI.APIError) {
    const status: number | undefined = err.status;
    if (status !== undefined) {
      const kind = classifyHttpStatus(status);
      return new LlmError({
        message: err.message,
        provider: PROVIDER,
        statusCode: status,
        kind,
        retryable: kind === 'rate_limit' || kind === 'server_error',
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

/** Build the optional-field spread shared by every response type. */
function extrasOf(parsed: ParsedXaiOutput) {
  return {
    ...(parsed.citations !== undefined && { citations: parsed.citations }),
    ...(parsed.images !== undefined && { images: parsed.images }),
    ...(parsed.serverToolCalls !== undefined && { serverToolCalls: parsed.serverToolCalls }),
  };
}

/** Create the xAI provider implementation using the Responses API. */
export function createXaiProvider(config: LlmClientConfig): LlmClient {
  // Providers always receive model as a string (client.ts resolves arrays before dispatch).
  const resolvedModel = Array.isArray(config.model) ? config.model[0]! : config.model;
  const resolvedConfig = { ...config, model: resolvedModel } as LlmClientConfig & {
    model: string;
  };

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: XAI_BASE_URL,
    timeout: config.timeoutMs ?? 30_000,
    maxRetries: 0, // We manage retries ourselves via withRetry
  });

  const retryOpts = {
    maxRetries: config.maxRetries ?? 3,
    baseDelayMs: config.baseDelayMs ?? 1_000,
    provider: PROVIDER,
    ...(config.retry !== undefined && { retryConfig: config.retry }),
  };

  async function complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<LlmResponse> {
    const model = options?.model ?? resolvedConfig.model;
    const input = buildResponsesInput(messages);
    const effectiveTimeoutMs = options?.timeoutMs ?? config.timeoutMs ?? 30_000;
    const start = Date.now();

    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model,
      input,
      stream: false,
    };
    const maxTokens = options?.maxTokens ?? config.maxTokens;
    if (maxTokens !== undefined) params.max_output_tokens = maxTokens;
    const temperature = options?.temperature ?? config.temperature;
    if (temperature !== undefined) params.temperature = temperature;
    // Server tools, max_tool_calls, inline citations and reasoning effort. Validation errors
    // throw here — before withRetry — so a bad request never reaches the network or the retry loop.
    applyXaiParams(params, model, options);

    return withRetry(
      async () => {
        const ctl = createAttemptController(options?.signal, effectiveTimeoutMs);
        try {
          // timeout: effectiveTimeoutMs overrides the SDK socket deadline for this call so the
          // per-call budget matches the AbortController budget (agentic tool calls run long).
          const response = await client.responses.create(params, {
            signal: ctl.signal,
            timeout: effectiveTimeoutMs,
          });

          const parsed = parseXaiOutput(response.output);
          return {
            content: parsed.text,
            model: response.model,
            id: response.id,
            idSource: 'provider' as const,
            usage: normalizeXaiUsage(response.usage),
            latencyMs: Date.now() - start,
            ...extrasOf(parsed),
          };
        } catch (err) {
          throw normalizeXaiError(classifyAbort(err, ctl.abortReason(), PROVIDER));
        } finally {
          ctl.dispose();
        }
      },
      mergeRetryOptsWithSignal(retryOpts, options?.signal)
    );
  }

  /** Placeholder for call types still being built; replaced in the next commit. */
  function notYetImplemented(method: string): never {
    throw new LlmError({
      message: `[llm-client] xai: ${method}() is not implemented yet`,
      provider: PROVIDER,
      kind: 'bad_request',
      retryable: false,
    });
  }

  function stream(
    _messages: LlmMessage[],
    _options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamChunk> {
    return notYetImplemented('stream');
  }

  async function structured<T>(
    _messages: LlmMessage[],
    _schema: { parse: (data: unknown) => T },
    _options?: LlmCallOptions
  ): Promise<LlmStructuredResponse<T>> {
    return notYetImplemented('structured');
  }

  function streamStructured<T>(
    _messages: LlmMessage[],
    _schema: { parse: (data: unknown) => T },
    _options?: LlmCallOptions
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    return notYetImplemented('streamStructured');
  }

  async function withTools(
    _messages: LlmMessage[],
    _tools: LlmTool[],
    _options?: LlmCallWithToolsOptions
  ): Promise<LlmToolResponse> {
    return notYetImplemented('withTools');
  }

  /** xAI Files API is not wired. Mirrors the DeepSeek stub: every method throws bad_request. */
  const unsupported = (): never => {
    throw new LlmError({
      message:
        "[llm-client] Provider 'xai' does not support Files API. Use inline base64 or url image content instead.",
      provider: PROVIDER,
      kind: 'bad_request',
      retryable: false,
    });
  };
  const files: LlmFilesApi = {
    upload: async () => unsupported(),
    refresh: async () => unsupported(),
    waitForActive: async () => unsupported(),
    delete: async () => unsupported(),
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
