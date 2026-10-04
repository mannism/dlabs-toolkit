/**
 * Unit tests for the xAI (Grok) provider — Responses API with server-side tools.
 *
 * All tests stub the openai SDK with vi.mock. No real API calls. Fixtures are trimmed copies of
 * real xAI responses captured 2026-10-04 (usage shape, output item shapes, annotation shape).
 *
 * Covers:
 * - Wire mapping for all six server tools (exact request body per tool), maxToolCalls, include
 * - Pre-flight validation (bad_request, zero network calls)
 * - Per-model reasoning effort (max rejected everywhere, none only on grok-4.3, null-capability models)
 * - Usage normalization: cached-token split, serverToolUsage, providerReportedCostUsd
 * - citations (annotations + web sources, dedupe), images, serverToolCalls (no MCP secrets)
 * - stream(): annotation accumulation, terminal chunk extras, failure events
 * - structured()/streamStructured(): strict json_schema with tools, prompt fallback, parse failures
 * - withTools(): function tools mixed with server tools
 */

import OpenAI from 'openai';
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { z } from 'zod';
import { setLlmClientLogger } from '../logger.js';
import type { LlmClientConfig, LlmTool, XaiServerTool } from '../types.js';
import { LlmError } from '../types.js';
import {
  buildXaiServerTools,
  createXaiProvider,
  normalizeXaiUsage,
  parseXaiOutput,
} from './xai.js';

vi.mock('openai');

const CONFIG: LlmClientConfig = {
  provider: 'xai',
  model: 'grok-4.7',
  apiKey: 'test-key',
  maxRetries: 0,
  baseDelayMs: 0,
};

const USER = [{ role: 'user' as const, content: 'hi' }];

// ─── Fixtures (trimmed from live responses, 2026-10-04) ───────────────────────

/** Real usage block from the grok-4.7 golden probe (input includes cached). */
const GOLDEN_USAGE = {
  input_tokens: 108146,
  input_tokens_details: { cached_tokens: 61568 },
  output_tokens: 2154,
  output_tokens_details: { reasoning_tokens: 1608 },
  total_tokens: 110300,
  num_sources_used: 0,
  num_server_side_tool_usage_details: 16,
  cost_in_usd_ticks: 3418640000,
  server_side_tool_usage_details: {
    web_search_calls: 5,
    x_search_calls: 11,
    x_posts_fetched: 14,
    x_users_fetched: 11,
    code_interpreter_calls: 0,
    file_search_calls: 0,
    mcp_calls: 0,
    document_search_calls: 0,
    image_generation_calls: 0,
  },
};

const MESSAGE_ITEM = (text: string, annotations: unknown[] = []) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, logprobs: [], annotations }],
});

const X_SEARCH_ITEM = {
  type: 'custom_tool_call',
  id: 'ctc_1',
  call_id: 'xs_call-1',
  name: 'x_keyword_search',
  input: '{"query":"from:xai","limit":"10","mode":"Latest"}',
  status: 'completed',
};

const WEB_SEARCH_ITEM = {
  type: 'web_search_call',
  id: 'ws_1',
  status: 'completed',
  action: {
    type: 'search',
    query: 'xAI official account',
    sources: [
      { type: 'url', url: 'https://x.com/Xai' },
      { type: 'url', url: 'https://x.com/SpaceXAI/status/1' },
    ],
  },
};

/** Build a full Responses-shaped response around the given output items. */
function resp(output: unknown[], usage: unknown = GOLDEN_USAGE, id = 'resp-xai-1') {
  return { id, object: 'response', model: 'grok-4.7', status: 'completed', output, usage };
}

/** Make an async-iterable SDK stream from events. */
function streamOf(events: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* events;
    },
  };
}

let mockCreate: MockInstance;
let ctorArgs: unknown[];

function install(response: unknown): void {
  mockCreate = vi.fn().mockResolvedValue(response);
  ctorArgs = [];
  vi.mocked(OpenAI).mockImplementation(function (...args: unknown[]) {
    ctorArgs = args;
    return { responses: { create: mockCreate } };
  });
}

/** The request body most recently sent to responses.create. */
function sentBody(): Record<string, unknown> {
  return mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  install(resp([MESSAGE_ITEM('Hello')]));
});

// ─── Construction + complete() basics ─────────────────────────────────────────

describe('xai provider — complete() basics', () => {
  it('targets the xAI base URL with retries disabled in the SDK', async () => {
    const client = createXaiProvider(CONFIG);
    await client.complete(USER);
    const opts = ctorArgs[0] as Record<string, unknown>;
    expect(opts['baseURL']).toBe('https://api.x.ai/v1');
    expect(opts['maxRetries']).toBe(0);
    expect(opts['apiKey']).toBe('test-key');
  });

  it('returns normalized content, id, idSource and usage', async () => {
    const client = createXaiProvider(CONFIG);
    const r = await client.complete(USER);
    expect(r.content).toBe('Hello');
    expect(r.id).toBe('resp-xai-1');
    expect(r.idSource).toBe('provider');
    expect(r.model).toBe('grok-4.7');
    expect(r.citations).toBeUndefined();
    expect(r.images).toBeUndefined();
    expect(r.serverToolCalls).toBeUndefined();
  });

  it('forwards maxTokens, temperature, per-call model and timeout', async () => {
    const client = createXaiProvider({ ...CONFIG, maxTokens: 100, temperature: 0.3 });
    await client.complete(USER, { model: 'grok-4.6', timeoutMs: 90_000 });
    expect(sentBody()).toMatchObject({
      model: 'grok-4.6',
      max_output_tokens: 100,
      temperature: 0.3,
      stream: false,
    });
    expect(mockCreate.mock.calls[0]?.[1]).toMatchObject({ timeout: 90_000 });
  });

  it('uses the first model when config.model is an array', async () => {
    const client = createXaiProvider({ ...CONFIG, model: ['grok-4.6', 'grok-4.5'] });
    await client.complete(USER);
    expect(sentBody()['model']).toBe('grok-4.6');
  });

  it('maps image blocks to input_image and rejects PDFs and file refs before any call', async () => {
    const client = createXaiProvider(CONFIG);
    await client.complete([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        ],
      },
    ]);
    const input = sentBody()['input'] as Array<{ content: Array<{ type: string }> }>;
    expect(input[0]?.content.map((c) => c.type)).toEqual(['input_text', 'input_image']);

    mockCreate.mockClear();
    await expect(
      client.complete([
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', mediaType: 'application/pdf', data: 'AA' },
            },
          ],
        },
      ])
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('files API methods all throw bad_request', async () => {
    const client = createXaiProvider(CONFIG);
    await expect(
      client.files.upload({ data: Buffer.from('x'), mediaType: 'application/pdf' })
    ).rejects.toMatchObject({
      kind: 'bad_request',
    });
    const ref = {
      id: 'f',
      uri: 'f',
      provider: 'xai',
      mediaType: 'application/pdf',
      state: 'active',
    } as never;
    await expect(client.files.refresh(ref)).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(client.files.waitForActive(ref)).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(client.files.delete(ref)).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('retries a retryable status then succeeds', async () => {
    const err = new LlmError({
      message: 'boom',
      provider: 'xai',
      kind: 'server_error',
      retryable: true,
    });
    mockCreate = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(resp([MESSAGE_ITEM('ok')]));
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });
    const client = createXaiProvider({ ...CONFIG, maxRetries: 1 });
    const r = await client.complete(USER);
    expect(r.content).toBe('ok');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ─── Server tool wire mapping ─────────────────────────────────────────────────

describe('xai provider — server tool wire mapping (exact bodies)', () => {
  async function toolsSent(serverTools: XaiServerTool[], extra: Record<string, unknown> = {}) {
    install(resp([MESSAGE_ITEM('x')]));
    const client = createXaiProvider(CONFIG);
    await client.complete(USER, { providerOptions: { serverTools, ...extra } });
    return sentBody()['tools'];
  }

  it('xSearch: allowlist, dates and media flags map to snake_case', async () => {
    expect(
      await toolsSent([
        {
          type: 'xSearch',
          allowedXHandles: ['SpaceXAI'],
          fromDate: '2026-09-01',
          toDate: '2026-10-04',
          enableImageUnderstanding: true,
          enableVideoUnderstanding: false,
        },
      ])
    ).toEqual([
      {
        type: 'x_search',
        allowed_x_handles: ['SpaceXAI'],
        from_date: '2026-09-01',
        to_date: '2026-10-04',
        enable_image_understanding: true,
        enable_video_understanding: false,
      },
    ]);
  });

  it('xSearch: excludedXHandles maps to excluded_x_handles; bare tool has only type', async () => {
    expect(await toolsSent([{ type: 'xSearch', excludedXHandles: ['spam'] }])).toEqual([
      { type: 'x_search', excluded_x_handles: ['spam'] },
    ]);
    expect(await toolsSent([{ type: 'xSearch' }])).toEqual([{ type: 'x_search' }]);
  });

  it('webSearch: domain lists and flags', async () => {
    expect(
      await toolsSent([
        {
          type: 'webSearch',
          allowedDomains: ['x.ai'],
          enableImageUnderstanding: true,
          enableImageSearch: true,
        },
      ])
    ).toEqual([
      {
        type: 'web_search',
        allowed_domains: ['x.ai'],
        enable_image_understanding: true,
        enable_image_search: true,
      },
    ]);
    expect(await toolsSent([{ type: 'webSearch', excludedDomains: ['a.com'] }])).toEqual([
      { type: 'web_search', excluded_domains: ['a.com'] },
    ]);
  });

  it('codeInterpreter and imageGeneration', async () => {
    expect(await toolsSent([{ type: 'codeInterpreter' }, { type: 'imageGeneration' }])).toEqual([
      { type: 'code_interpreter' },
      { type: 'image_generation' },
    ]);
  });

  it('fileSearch: vector store ids and max results', async () => {
    expect(
      await toolsSent([{ type: 'fileSearch', vectorStoreIds: ['vs_1'], maxNumResults: 5 }])
    ).toEqual([{ type: 'file_search', vector_store_ids: ['vs_1'], max_num_results: 5 }]);
    expect(await toolsSent([{ type: 'fileSearch', vectorStoreIds: ['vs_1'] }])).toEqual([
      { type: 'file_search', vector_store_ids: ['vs_1'] },
    ]);
  });

  it('mcp: full config incl. authorization and headers reaches the wire', async () => {
    expect(
      await toolsSent([
        {
          type: 'mcp',
          serverUrl: 'https://mcp.deepwiki.com/mcp',
          serverLabel: 'deepwiki',
          serverDescription: 'wiki',
          allowedTools: ['ask_question'],
          authorization: 'Bearer secret',
          headers: { 'x-a': 'b' },
        },
      ])
    ).toEqual([
      {
        type: 'mcp',
        server_url: 'https://mcp.deepwiki.com/mcp',
        server_label: 'deepwiki',
        server_description: 'wiki',
        allowed_tools: ['ask_question'],
        authorization: 'Bearer secret',
        headers: { 'x-a': 'b' },
      },
    ]);
    expect(
      await toolsSent([{ type: 'mcp', serverUrl: 'http://localhost:1/mcp', serverLabel: 'l' }])
    ).toEqual([{ type: 'mcp', server_url: 'http://localhost:1/mcp', server_label: 'l' }]);
  });

  it('sends max_tool_calls and inline_citations include; omits them when unset', async () => {
    install(resp([MESSAGE_ITEM('x')]));
    const client = createXaiProvider(CONFIG);
    await client.complete(USER, {
      providerOptions: {
        serverTools: [{ type: 'webSearch' }],
        maxToolCalls: 4,
        inlineCitations: true,
      },
    });
    expect(sentBody()['max_tool_calls']).toBe(4);
    expect(sentBody()['include']).toEqual(['inline_citations']);

    install(resp([MESSAGE_ITEM('x')]));
    await createXaiProvider(CONFIG).complete(USER, { providerOptions: { inlineCitations: false } });
    expect(sentBody()['include']).toBeUndefined();
    expect(sentBody()['tools']).toBeUndefined();
    expect(sentBody()['max_tool_calls']).toBeUndefined();
  });

  it('buildXaiServerTools returns undefined for absent or empty serverTools', () => {
    expect(buildXaiServerTools(undefined)).toBeUndefined();
    expect(buildXaiServerTools({})).toBeUndefined();
    expect(buildXaiServerTools({ serverTools: [] })).toBeUndefined();
  });
});

// ─── Pre-flight validation ────────────────────────────────────────────────────

describe('xai provider — pre-flight validation (bad_request, no network call)', () => {
  const handles = (n: number) => Array.from({ length: n }, (_, i) => `h${i}`);

  const cases: Array<[string, Record<string, unknown>]> = [
    [
      'allowed + excluded X handles',
      { serverTools: [{ type: 'xSearch', allowedXHandles: ['a'], excludedXHandles: ['b'] }] },
    ],
    [
      'more than 20 X handles (allowed)',
      { serverTools: [{ type: 'xSearch', allowedXHandles: handles(21) }] },
    ],
    [
      'more than 20 X handles (excluded)',
      { serverTools: [{ type: 'xSearch', excludedXHandles: handles(21) }] },
    ],
    [
      'allowed + excluded domains',
      {
        serverTools: [{ type: 'webSearch', allowedDomains: ['a.com'], excludedDomains: ['b.com'] }],
      },
    ],
    [
      'more than 5 domains (allowed)',
      { serverTools: [{ type: 'webSearch', allowedDomains: handles(6) }] },
    ],
    [
      'more than 5 domains (excluded)',
      { serverTools: [{ type: 'webSearch', excludedDomains: handles(6) }] },
    ],
    ['fromDate not YYYY-MM-DD', { serverTools: [{ type: 'xSearch', fromDate: '10/04/2026' }] }],
    ['toDate not a string', { serverTools: [{ type: 'xSearch', toDate: 20261004 }] }],
    ['impossible calendar date', { serverTools: [{ type: 'xSearch', fromDate: '2026-02-31' }] }],
    ['unknown tool type', { serverTools: [{ type: 'teleport' }] }],
    ['non-object tool entry', { serverTools: ['x_search'] }],
    ['serverTools not an array', { serverTools: { type: 'xSearch' } }],
    ['handles not strings', { serverTools: [{ type: 'xSearch', allowedXHandles: [1] }] }],
    [
      'boolean flag not boolean',
      { serverTools: [{ type: 'xSearch', enableImageUnderstanding: 'yes' }] },
    ],
    ['fileSearch without vectorStoreIds', { serverTools: [{ type: 'fileSearch' }] }],
    [
      'fileSearch empty vectorStoreIds',
      { serverTools: [{ type: 'fileSearch', vectorStoreIds: [] }] },
    ],
    [
      'fileSearch bad maxNumResults',
      { serverTools: [{ type: 'fileSearch', vectorStoreIds: ['v'], maxNumResults: 0 }] },
    ],
    ['mcp without serverUrl', { serverTools: [{ type: 'mcp', serverLabel: 'l' }] }],
    [
      'mcp invalid URL',
      { serverTools: [{ type: 'mcp', serverUrl: 'not a url', serverLabel: 'l' }] },
    ],
    [
      'mcp non-http URL',
      { serverTools: [{ type: 'mcp', serverUrl: 'ftp://x.com', serverLabel: 'l' }] },
    ],
    ['mcp without serverLabel', { serverTools: [{ type: 'mcp', serverUrl: 'https://x.com' }] }],
    [
      'mcp serverDescription not a string',
      {
        serverTools: [
          { type: 'mcp', serverUrl: 'https://x.com', serverLabel: 'l', serverDescription: 1 },
        ],
      },
    ],
    [
      'mcp authorization not a string',
      {
        serverTools: [
          { type: 'mcp', serverUrl: 'https://x.com', serverLabel: 'l', authorization: 1 },
        ],
      },
    ],
    [
      'mcp headers not string values',
      {
        serverTools: [
          { type: 'mcp', serverUrl: 'https://x.com', serverLabel: 'l', headers: { a: 1 } },
        ],
      },
    ],
    ['maxToolCalls zero', { maxToolCalls: 0 }],
    ['maxToolCalls fractional', { maxToolCalls: 1.5 }],
    ['maxToolCalls not a number', { maxToolCalls: '3' }],
    ['inlineCitations not boolean', { inlineCitations: 'yes' }],
  ];

  it.each(cases)('%s', async (_name, providerOptions) => {
    const client = createXaiProvider(CONFIG);
    const err = await client.complete(USER, { providerOptions }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'bad_request', retryable: false, provider: 'xai' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('accepts exactly 20 handles and 5 domains', async () => {
    const client = createXaiProvider(CONFIG);
    await client.complete(USER, {
      providerOptions: {
        serverTools: [
          { type: 'xSearch', allowedXHandles: handles(20) },
          { type: 'webSearch', allowedDomains: handles(5) },
        ],
      },
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('validation also fires for stream, structured, streamStructured and withTools', async () => {
    const client = createXaiProvider(CONFIG);
    const bad = { providerOptions: { serverTools: [{ type: 'nope' }] } };
    await expect(client.stream(USER, bad).next()).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(client.structured(USER, z.object({ a: z.string() }), bad)).rejects.toMatchObject({
      kind: 'bad_request',
    });
    await expect(
      client.streamStructured(USER, z.object({ a: z.string() }), bad).next()
    ).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(client.withTools(USER, [], bad)).rejects.toMatchObject({ kind: 'bad_request' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

// ─── Reasoning effort (per model) ─────────────────────────────────────────────

describe('xai provider — reasoningEffort per model', () => {
  async function tryEffort(model: string, effort: string) {
    install(resp([MESSAGE_ITEM('x')]));
    const client = createXaiProvider({ ...CONFIG, model });
    return client
      .complete(USER, { reasoningEffort: effort as never })
      .then(() => 'ok' as const)
      .catch((e: unknown) => e);
  }

  it.each([
    ['grok-4.7', 'minimal'],
    ['grok-4.7', 'low'],
    ['grok-4.7', 'medium'],
    ['grok-4.7', 'high'],
    ['grok-4.7', 'xhigh'],
    ['grok-4.6', 'minimal'],
    ['grok-4.5', 'xhigh'],
    ['grok-4.3', 'none'],
    ['grok-4.3', 'minimal'],
    ['grok-4.3', 'xhigh'],
    ['grok-4.20-multi-agent-0309', 'low'],
    ['grok-4.20-multi-agent-0309', 'xhigh'],
    ['grok-future-9', 'high'],
  ])('%s accepts %s and sends it on the wire', async (model, effort) => {
    expect(await tryEffort(model, effort)).toBe('ok');
    expect(sentBody()['reasoning']).toEqual({ effort });
  });

  it.each([
    ['grok-4.7', 'none'],
    ['grok-4.6', 'none'],
    ['grok-4.5', 'none'],
    ['grok-4.7', 'max'],
    ['grok-4.3', 'max'],
    ['grok-4.20-multi-agent-0309', 'minimal'],
    ['grok-4.20-multi-agent-0309', 'none'],
    ['grok-future-9', 'none'],
    ['grok-future-9', 'max'],
  ])('%s rejects %s with zero network calls', async (model, effort) => {
    const err = await tryEffort(model, effort);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'bad_request', provider: 'xai' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each(['grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning', 'grok-build-0.1'])(
    '%s takes no reasoningEffort at all',
    async (model) => {
      const err = await tryEffort(model, 'low');
      expect(err).toMatchObject({ kind: 'bad_request' });
      expect(mockCreate).not.toHaveBeenCalled();
    }
  );

  it('does not touch reasoning when effort is unset', async () => {
    await createXaiProvider(CONFIG).complete(USER);
    expect(sentBody()['reasoning']).toBeUndefined();
  });
});

// ─── Usage normalization ──────────────────────────────────────────────────────

describe('xai provider — usage normalization', () => {
  it('golden: splits cached tokens, maps tool usage (zeros omitted), converts ticks to USD', () => {
    const u = normalizeXaiUsage(GOLDEN_USAGE);
    expect(u.inputTokens).toBe(46578); // 108146 - 61568
    expect(u.cacheReadTokens).toBe(61568);
    expect(u.outputTokens).toBe(2154);
    expect(u.reasoningTokens).toBe(1608);
    expect(u.totalTokens).toBe(110300);
    expect(u.serverToolUsage).toEqual({
      webSearchCalls: 5,
      xSearchCalls: 11,
      xPostsFetched: 14,
      xUsersFetched: 11,
    });
    expect(u.providerReportedCostUsd).toBeCloseTo(0.341864, 9);
  });

  it('omits optional fields when absent and tolerates garbage input', () => {
    expect(normalizeXaiUsage({ input_tokens: 10, output_tokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(normalizeXaiUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(normalizeXaiUsage('nope')).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    // cached > input must not go negative
    expect(
      normalizeXaiUsage({ input_tokens: 5, input_tokens_details: { cached_tokens: 9 } }).inputTokens
    ).toBe(0);
    // all-zero tool usage collapses to no field
    expect(
      normalizeXaiUsage({ server_side_tool_usage_details: { web_search_calls: 0 } }).serverToolUsage
    ).toBeUndefined();
  });

  it('is present on complete, structured, withTools and the final stream chunk', async () => {
    const schema = z.object({ n: z.number() });
    install(resp([MESSAGE_ITEM('hi')]));
    expect(
      (await createXaiProvider(CONFIG).complete(USER)).usage.providerReportedCostUsd
    ).toBeCloseTo(0.341864, 6);

    install(resp([MESSAGE_ITEM('{"n":1}')]));
    expect(
      (await createXaiProvider(CONFIG).structured(USER, schema)).usage.serverToolUsage
    ).toMatchObject({
      webSearchCalls: 5,
    });

    install(resp([MESSAGE_ITEM('hi')]));
    expect((await createXaiProvider(CONFIG).withTools(USER, [])).usage.cacheReadTokens).toBe(61568);

    install(
      streamOf([
        { type: 'response.output_text.delta', delta: 'a' },
        { type: 'response.completed', response: resp([MESSAGE_ITEM('a')]) },
      ])
    );
    const chunks = [];
    for await (const c of createXaiProvider(CONFIG).stream(USER)) chunks.push(c);
    expect(chunks.at(-1)?.usage?.providerReportedCostUsd).toBeCloseTo(0.341864, 6);
  });
});

// ─── Output parsing: citations, images, serverToolCalls ───────────────────────

describe('xai provider — output parsing', () => {
  it('dedupes citations by URL across annotations and web_search sources; drops numeric titles', () => {
    const parsed = parseXaiOutput([
      WEB_SEARCH_ITEM,
      MESSAGE_ITEM('text', [
        {
          type: 'url_citation',
          url: 'https://x.com/SpaceXAI/status/1',
          start_index: 0,
          end_index: 4,
          title: '1',
        },
        { type: 'url_citation', url: 'https://x.com/SpaceXAI/status/1', title: 'Real title' },
        { type: 'url_citation', url: 'https://x.com/SpaceXAI/status/2', title: '2' },
        { type: 'file_citation', url: 'https://ignored.example' },
        { type: 'url_citation' },
      ]),
    ]);
    expect(parsed.citations).toEqual([
      { url: 'https://x.com/Xai' },
      { url: 'https://x.com/SpaceXAI/status/1', title: 'Real title' },
      { url: 'https://x.com/SpaceXAI/status/2' },
    ]);
  });

  it('builds serverToolCalls for every tool type and never copies MCP secrets or image bytes', () => {
    const parsed = parseXaiOutput([
      { type: 'reasoning', id: 'rs_1', summary: [] },
      X_SEARCH_ITEM,
      WEB_SEARCH_ITEM,
      { type: 'code_interpreter_call', status: 'completed', code: 'print(1)' },
      { type: 'file_search_call', status: 'completed', queries: ['q1', 'q2', 7] },
      {
        type: 'mcp_call',
        status: 'completed',
        name: 'read_wiki_structure',
        server_label: 'deepwiki',
        arguments: '{"repoName":"facebook/react"}',
        authorization: 'Bearer SECRET',
        headers: { 'x-secret': 'SECRET' },
      },
      {
        type: 'image_generation_call',
        status: 'completed',
        result: 'BASE64DATA',
        prompt: 'red circle',
      },
      { type: 'image_generation_call', status: 'failed' },
      MESSAGE_ITEM('done'),
    ]);
    expect(parsed.serverToolCalls?.map((c) => c.type)).toEqual([
      'xSearch',
      'webSearch',
      'codeInterpreter',
      'fileSearch',
      'mcp',
      'imageGeneration',
      'imageGeneration',
    ]);
    expect(parsed.serverToolCalls?.[0]).toEqual({
      type: 'xSearch',
      name: 'x_keyword_search',
      status: 'completed',
      input: X_SEARCH_ITEM.input,
    });
    expect(parsed.serverToolCalls?.[1]).toMatchObject({
      type: 'webSearch',
      input: 'xAI official account',
      sources: ['https://x.com/Xai', 'https://x.com/SpaceXAI/status/1'],
    });
    expect(parsed.serverToolCalls?.[3]).toMatchObject({ input: 'q1\nq2' });
    expect(parsed.serverToolCalls?.[4]).toEqual({
      type: 'mcp',
      status: 'completed',
      name: 'read_wiki_structure',
      serverLabel: 'deepwiki',
      input: '{"repoName":"facebook/react"}',
    });
    const serialized = JSON.stringify(parsed.serverToolCalls);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('BASE64DATA');
    expect(parsed.images).toEqual([
      { data: 'BASE64DATA', mediaType: 'image/jpeg', prompt: 'red circle' },
    ]);
  });

  it('collects function calls and refusals separately from server tool calls', () => {
    const parsed = parseXaiOutput([
      { type: 'function_call', call_id: 'c1', name: 'get_weather', arguments: '{"city":"SG"}' },
      { type: 'function_call' },
      { type: 'message', content: [{ type: 'refusal', refusal: 'no' }, 'junk', null] },
      null,
      'junk',
    ]);
    expect(parsed.functionCalls).toEqual([
      { callId: 'c1', name: 'get_weather', args: '{"city":"SG"}' },
      { callId: undefined, name: '', args: '' },
    ]);
    expect(parsed.refusal).toBe('no');
    expect(parsed.serverToolCalls).toBeUndefined();
    expect(parseXaiOutput(undefined).text).toBe('');
  });

  it('logs unrecognized output items instead of dropping them silently', () => {
    const warn = vi.fn();
    setLlmClientLogger({ warn });
    parseXaiOutput([{ type: 'hologram_call' }, { type: 'custom_tool_call', name: 'mystery_tool' }]);
    setLlmClientLogger(null);
    expect(warn).toHaveBeenCalledWith('xai_unrecognized_output_item', { type: 'hologram_call' });
    expect(warn).toHaveBeenCalledWith('xai_unrecognized_output_item', {
      type: 'custom_tool_call',
      name: 'mystery_tool',
    });
  });

  it('complete() surfaces citations, images and serverToolCalls', async () => {
    install(
      resp([
        X_SEARCH_ITEM,
        { type: 'image_generation_call', status: 'completed', result: 'QUJD', prompt: 'p' },
        MESSAGE_ITEM('answer', [
          { type: 'url_citation', url: 'https://x.com/a/status/1', title: '1' },
        ]),
      ])
    );
    const r = await createXaiProvider(CONFIG).complete(USER);
    expect(r.content).toBe('answer');
    expect(r.citations).toEqual([{ url: 'https://x.com/a/status/1' }]);
    expect(r.images).toHaveLength(1);
    expect(r.serverToolCalls).toHaveLength(2);
  });
});

// ─── stream() ─────────────────────────────────────────────────────────────────

describe('xai provider — stream()', () => {
  const ANN = {
    type: 'response.output_text.annotation.added',
    annotation: { type: 'url_citation', url: 'https://x.com/SpaceXAI/status/9', title: '1' },
  };

  it('yields tokens, accumulates annotation citations and sends tools on the streaming request', async () => {
    install(
      streamOf([
        { type: 'response.output_text.delta', delta: 'Hello' },
        { type: 'response.output_text.delta', delta: '' },
        ANN,
        { type: 'response.output_text.annotation.added', annotation: { type: 'file_citation' } },
        { type: 'response.output_text.delta', delta: ' world' },
        {
          type: 'response.completed',
          response: resp([
            X_SEARCH_ITEM,
            { type: 'image_generation_call', status: 'completed', result: 'QUJD' },
            MESSAGE_ITEM('Hello world', [
              { type: 'url_citation', url: 'https://x.com/SpaceXAI/status/9' },
              { type: 'url_citation', url: 'https://x.com/other' },
            ]),
          ]),
        },
      ])
    );
    const client = createXaiProvider(CONFIG);
    const tokens: string[] = [];
    let last: {
      citations?: unknown;
      images?: unknown;
      serverToolCalls?: unknown;
      usage?: unknown;
    } = {};
    for await (const c of client.stream(USER, {
      providerOptions: { serverTools: [{ type: 'xSearch' }] },
      maxTokens: 50,
      temperature: 0.1,
    })) {
      if (c.usage !== undefined) last = c;
      else if (c.token.length > 0) tokens.push(c.token);
    }
    expect(tokens).toEqual(['Hello', ' world']);
    expect(last.citations).toEqual([
      { url: 'https://x.com/SpaceXAI/status/9' },
      { url: 'https://x.com/other' },
    ]);
    expect(last.images).toHaveLength(1);
    expect(last.serverToolCalls).toHaveLength(2);
    expect(sentBody()).toMatchObject({
      stream: true,
      tools: [{ type: 'x_search' }],
      max_output_tokens: 50,
      temperature: 0.1,
    });
  });

  it('terminal chunk has no extras when the response carried none', async () => {
    install(
      streamOf([
        { type: 'response.output_text.delta', delta: 'a' },
        { type: 'response.completed', response: resp([MESSAGE_ITEM('a')]) },
      ])
    );
    const chunks = [];
    for await (const c of createXaiProvider(CONFIG).stream(USER)) chunks.push(c);
    const final = chunks.at(-1);
    expect(final?.citations).toBeUndefined();
    expect(final?.images).toBeUndefined();
    expect(final?.serverToolCalls).toBeUndefined();
  });

  it('throws server_error on response.failed instead of ending empty', async () => {
    install(
      streamOf([{ type: 'response.failed', response: { error: { message: 'model crashed' } } }])
    );
    const err = await (async () => {
      for await (const _ of createXaiProvider(CONFIG).stream(USER)) {
        /* drain */
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'server_error', provider: 'xai' });
    expect((err as Error).message).toContain('model crashed');
  });

  it('response.failed without detail still throws', async () => {
    install(streamOf([{ type: 'response.failed', response: { error: null } }]));
    await expect(
      (async () => {
        for await (const _ of createXaiProvider(CONFIG).stream(USER)) {
          /* drain */
        }
      })()
    ).rejects.toMatchObject({ kind: 'server_error' });
  });

  it('emits no terminal chunk when the stream ends without response.completed', async () => {
    install(streamOf([{ type: 'response.output_text.delta', delta: 'a' }]));
    const chunks = [];
    for await (const c of createXaiProvider(CONFIG).stream(USER)) chunks.push(c);
    expect(chunks).toEqual([{ token: 'a' }]);
  });

  it('normalizes a stream-creation error', async () => {
    mockCreate = vi
      .fn()
      .mockRejectedValue(
        new LlmError({ message: 'bad key', provider: 'xai', kind: 'auth', retryable: false })
      );
    vi.mocked(OpenAI).mockImplementation(function () {
      return { responses: { create: mockCreate } };
    });
    await expect(createXaiProvider(CONFIG).stream(USER).next()).rejects.toMatchObject({
      kind: 'auth',
      provider: 'xai',
    });
  });

  it('normalizes an error thrown mid-stream', async () => {
    install({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'response.output_text.delta', delta: 'a' };
        throw new Error('socket closed');
      },
    });
    await expect(
      (async () => {
        for await (const _ of createXaiProvider(CONFIG).stream(USER)) {
          /* drain */
        }
      })()
    ).rejects.toBeInstanceOf(LlmError);
  });
});

// ─── structured() / streamStructured() ────────────────────────────────────────

describe('xai provider — structured()', () => {
  const schema = z.object({ n: z.number().int() });

  it('strict path sends text.format json_schema alongside server tools and returns extras', async () => {
    install(
      resp([
        { type: 'code_interpreter_call', status: 'completed', code: 'print(832040)' },
        MESSAGE_ITEM('{"n":832040}'),
      ])
    );
    const r = await createXaiProvider(CONFIG).structured(USER, schema, {
      providerOptions: { serverTools: [{ type: 'codeInterpreter' }] },
    });
    expect(r.data).toEqual({ n: 832040 });
    expect(r.serverToolCalls?.[0]?.type).toBe('codeInterpreter');
    expect(r.usage.providerReportedCostUsd).toBeDefined();
    const body = sentBody();
    expect(body['tools']).toEqual([{ type: 'code_interpreter' }]);
    expect(body['text']).toMatchObject({
      format: { type: 'json_schema', name: 'response', strict: true },
    });
  });

  it('structuredMode "prompt" and non-Zod schemas use the instruction-only fallback', async () => {
    install(resp([MESSAGE_ITEM('```json\n{"n": 3}\n```')]));
    const r = await createXaiProvider(CONFIG).structured(USER, schema, {
      providerOptions: { structuredMode: 'prompt' },
    });
    expect(r.data).toEqual({ n: 3 });
    expect(sentBody()['text']).toBeUndefined();
    const input = sentBody()['input'] as Array<{ role: string }>;
    expect(input[0]?.role).toBe('system');

    install(resp([MESSAGE_ITEM('{"n": 4}')]));
    const r2 = await createXaiProvider(CONFIG).structured(USER, {
      parse: (d: unknown) => d as { n: number },
    });
    expect(r2.data).toEqual({ n: 4 });
    expect(sentBody()['text']).toBeUndefined();
  });

  it('throws content_filter on refusal', async () => {
    install(resp([{ type: 'message', content: [{ type: 'refusal', refusal: 'cannot help' }] }]));
    await expect(createXaiProvider(CONFIG).structured(USER, schema)).rejects.toMatchObject({
      kind: 'content_filter',
    });
  });

  it('throws structured_parse_failed on invalid JSON and on schema mismatch (strict)', async () => {
    install(resp([MESSAGE_ITEM('not json')]));
    await expect(createXaiProvider(CONFIG).structured(USER, schema)).rejects.toMatchObject({
      kind: 'structured_parse_failed',
    });
    install(resp([MESSAGE_ITEM('{"n":"x"}')]));
    await expect(createXaiProvider(CONFIG).structured(USER, schema)).rejects.toMatchObject({
      kind: 'structured_parse_failed',
    });
  });

  it('throws structured_parse_failed when the fallback finds no JSON', async () => {
    install(resp([MESSAGE_ITEM('sorry, no json here')]));
    await expect(
      createXaiProvider(CONFIG).structured(USER, schema, {
        providerOptions: { structuredMode: 'prompt' },
      })
    ).rejects.toBeInstanceOf(LlmError);
  });
});

describe('xai provider — streamStructured()', () => {
  const schema = z.object({ n: z.number() });

  function events(text: string) {
    return streamOf([
      { type: 'response.output_text.delta', delta: text.slice(0, 3) },
      { type: 'response.output_text.delta', delta: text.slice(3) },
      {
        type: 'response.completed',
        response: resp([
          WEB_SEARCH_ITEM,
          MESSAGE_ITEM(text, [{ type: 'url_citation', url: 'https://x.com/z' }]),
        ]),
      },
    ]);
  }

  it('streams tokens then emits done with data, usage and extras', async () => {
    install(events('{"n":7}'));
    const out = [];
    for await (const e of createXaiProvider(CONFIG).streamStructured(USER, schema, {
      providerOptions: { serverTools: [{ type: 'webSearch' }] },
    })) {
      out.push(e);
    }
    expect(out.filter((e) => e.type === 'token')).toHaveLength(2);
    const done = out.at(-1);
    expect(done).toMatchObject({ type: 'done', data: { n: 7 } });
    if (done?.type === 'done') {
      expect(done.usage.providerReportedCostUsd).toBeCloseTo(0.341864, 6);
      expect(done.citations?.map((c) => c.url)).toEqual([
        'https://x.com/Xai',
        'https://x.com/SpaceXAI/status/1',
        'https://x.com/z',
      ]);
      expect(done.serverToolCalls).toHaveLength(1);
    }
    expect(sentBody()['text']).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('non-Zod schema uses the instruction fallback with lenient parsing', async () => {
    install(events('{"n":8}'));
    const out = [];
    for await (const e of createXaiProvider(CONFIG).streamStructured(USER, {
      parse: (d: unknown) => d as { n: number },
    })) {
      out.push(e);
    }
    expect(out.at(-1)).toMatchObject({ type: 'done', data: { n: 8 } });
    expect(sentBody()['text']).toBeUndefined();
  });

  it('throws structured_parse_failed on bad JSON or schema mismatch', async () => {
    install(events('not json'));
    await expect(
      (async () => {
        for await (const _ of createXaiProvider(CONFIG).streamStructured(USER, schema)) {
          /* drain */
        }
      })()
    ).rejects.toMatchObject({ kind: 'structured_parse_failed' });

    install(events('{"n":"x"}'));
    await expect(
      (async () => {
        for await (const _ of createXaiProvider(CONFIG).streamStructured(USER, schema)) {
          /* drain */
        }
      })()
    ).rejects.toMatchObject({ kind: 'structured_parse_failed' });
  });

  it('done carries zero usage when no response.completed arrived', async () => {
    install(streamOf([{ type: 'response.output_text.delta', delta: '{"n":1}' }]));
    const out = [];
    for await (const e of createXaiProvider(CONFIG).streamStructured(USER, schema)) out.push(e);
    expect(out.at(-1)).toMatchObject({ type: 'done', usage: { totalTokens: 0 } });
  });
});

// ─── withTools() ──────────────────────────────────────────────────────────────

describe('xai provider — withTools()', () => {
  const weather: LlmTool = {
    name: 'get_weather',
    description: 'weather',
    inputSchema: { kind: 'zod', schema: z.object({ city: z.string() }) },
  };

  it('mixes function tools with server tools; only function_call becomes an LlmToolCall', async () => {
    install(
      resp([
        WEB_SEARCH_ITEM,
        {
          type: 'function_call',
          call_id: 'call-1',
          name: 'get_weather',
          arguments: '{"city":"Singapore"}',
        },
      ])
    );
    const r = await createXaiProvider(CONFIG).withTools(USER, [weather], {
      providerOptions: { serverTools: [{ type: 'webSearch' }] },
      parallelToolCalls: false,
      toolChoice: 'any',
    });
    expect(r.toolCalls).toEqual([
      {
        id: 'call-1',
        toolName: 'get_weather',
        arguments: { city: 'Singapore' },
        rawArguments: '{"city":"Singapore"}',
      },
    ]);
    expect(r.stopReason).toBe('tool_use');
    expect(r.serverToolCalls?.map((c) => c.type)).toEqual(['webSearch']);
    expect(r.citations?.length).toBe(2);
    const tools = sentBody()['tools'] as Array<Record<string, unknown>>;
    expect(tools.map((t) => t['type'])).toEqual(['web_search', 'function']);
    expect(tools[1]).toMatchObject({ name: 'get_weather', strict: null });
    expect(sentBody()['tool_choice']).toBe('required');
    expect(sentBody()['parallel_tool_calls']).toBe(false);
  });

  it.each([
    [undefined, 'auto'],
    ['auto' as const, 'auto'],
    ['none' as const, 'none'],
    [{ name: 'get_weather' }, { type: 'function', name: 'get_weather' }],
  ])('maps toolChoice %j', async (tc, expected) => {
    install(resp([MESSAGE_ITEM('no tools')]));
    const r = await createXaiProvider(CONFIG).withTools(USER, [weather], {
      ...(tc !== undefined && { toolChoice: tc }),
    });
    expect(sentBody()['tool_choice']).toEqual(expected);
    expect(r.stopReason).toBe('end_turn');
    expect(r.toolCalls).toEqual([]);
  });

  it('supports jsonSchema tools with validate, passes through unknown tools, keeps raw string args', async () => {
    install(
      resp([
        { type: 'function_call', call_id: 'c1', name: 'j', arguments: '{"a":1}' },
        { type: 'function_call', name: 'unknown_tool', arguments: 'not-json' },
      ])
    );
    const validate = vi.fn((v: unknown) => v);
    const r = await createXaiProvider(CONFIG).withTools(
      USER,
      [
        {
          name: 'j',
          description: 'j',
          inputSchema: { kind: 'jsonSchema', schema: { type: 'object' }, validate },
        },
      ],
      {}
    );
    expect(validate).toHaveBeenCalledWith({ a: 1 });
    expect(r.toolCalls[1]?.arguments).toBe('not-json');
    expect(r.toolCalls[1]?.id).toMatch(/^synth-/);
  });

  it('throws tool_arguments_invalid when arguments fail the schema', async () => {
    install(
      resp([{ type: 'function_call', call_id: 'c', name: 'get_weather', arguments: '{"city":1}' }])
    );
    await expect(createXaiProvider(CONFIG).withTools(USER, [weather])).rejects.toMatchObject({
      kind: 'tool_arguments_invalid',
    });
  });

  it('throws tool_schema_invalid for a legacy-shaped tool', async () => {
    await expect(
      createXaiProvider(CONFIG).withTools(USER, [
        { name: 'old', description: 'd', inputSchema: { parse: () => 1 } } as never,
      ])
    ).rejects.toMatchObject({ kind: 'tool_schema_invalid' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('reports a refusal as stopReason refusal', async () => {
    install(resp([{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }]));
    const r = await createXaiProvider(CONFIG).withTools(USER, []);
    expect(r.stopReason).toBe('refusal');
  });
});
