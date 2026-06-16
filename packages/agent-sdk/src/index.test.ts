/**
 * Full unit test suite for @diabolicallabs/agent-sdk instrumentClient().
 *
 * Coverage target: ≥80% across lines, functions, branches, statements.
 *
 * Test areas:
 *   - disabled mode: passthrough, no fetch calls
 *   - complete(): happy path, LlmError propagation, CallRecord shape
 *   - stream(): token passthrough, CallRecord after final chunk, stream error
 *   - structured(): happy path, CallRecord dispatched
 *   - Ingestion: success, retry on failure, exhaustion drops record
 *   - CallRecord: required fields, correct values
 *   - ingestionKey used as Bearer token
 */

import type {
  LlmClient,
  LlmClientConfig,
  LlmStreamStructuredEvent,
  LlmToolCall,
  LlmUsage,
} from '@diabolicallabs/llm-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSdkConfig, AgentSdkLogger } from './index.js';
import { instrumentClient, setAgentSdkLogger } from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockConfig: Readonly<LlmClientConfig> = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  apiKey: 'test-key',
};

const mockUsage: LlmUsage = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
};

// Valid UUID fixtures — required after v3.2.0 UUID validation is active.
// Non-UUID agentId/projectId now cause instrumentClient() to flip to disabled mode.
const VALID_AGENT_UUID = '11111111-1111-4111-8111-111111111111';
const VALID_PROJECT_UUID = '22222222-2222-4222-8222-222222222222';

const sdkConfig: AgentSdkConfig = {
  identity: {
    agentId: VALID_AGENT_UUID,
    taskLabel: 'test-task',
    projectId: VALID_PROJECT_UUID,
  },
  ingestionUrl: 'https://spend.example.com/api/ingest',
  ingestionKey: 'secret-bearer-token',
  maxIngestionRetries: 2,
  ingestionTimeoutMs: 1000,
};

const mockMessages = [{ role: 'user' as const, content: 'Hello' }];

const mockToolCall: LlmToolCall = {
  id: 'call_test_123',
  toolName: 'get_weather',
  arguments: { city: 'London' },
  rawArguments: '{"city":"London"}',
};

function makeMockClient(overrides?: Partial<LlmClient>): LlmClient {
  return {
    config: mockConfig,
    // files: stub that rejects — agent-sdk tests do not exercise Files API
    files: {
      upload: vi.fn().mockRejectedValue(new Error('not implemented in mock')),
      refresh: vi.fn().mockRejectedValue(new Error('not implemented in mock')),
      waitForActive: vi.fn().mockRejectedValue(new Error('not implemented in mock')),
      delete: vi.fn().mockRejectedValue(new Error('not implemented in mock')),
    },
    complete: vi.fn().mockResolvedValue({
      content: 'Hello back',
      model: 'claude-sonnet-4-6',
      usage: mockUsage,
      latencyMs: 200,
    }),
    stream: vi.fn(),
    structured: vi.fn(),
    withTools: vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [mockToolCall],
      model: 'claude-sonnet-4-6',
      usage: mockUsage,
      latencyMs: 120,
      stopReason: 'tool_use',
    }),
    streamStructured: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drains an AsyncGenerator into an array. */
async function drainStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

/**
 * Returns the first call args from a mocked fetch as a typed tuple.
 * Asserts the call exists before returning — fails the test if fetch was never called.
 */
function getFirstFetchCall(mockFetch: ReturnType<typeof vi.fn>): [string, RequestInit] {
  const call = mockFetch.mock.calls[0];
  expect(call).toBeDefined();
  return call as [string, RequestInit];
}

// ---------------------------------------------------------------------------
// Setup: mock fetch globally
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Reset pluggable logger to default between tests
  setAgentSdkLogger(null);
});

// ---------------------------------------------------------------------------
// disabled mode
// ---------------------------------------------------------------------------

describe('disabled mode', () => {
  it('returns a client with sdkConfig but no fetch calls on complete()', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, { ...sdkConfig, disabled: true });

    await instrumented.complete(mockMessages);

    expect(fetch).not.toHaveBeenCalled();
    expect(instrumented.sdkConfig).toBe(instrumented.sdkConfig);
    expect(instrumented.sdkConfig.disabled).toBe(true);
  });

  it('exposes the underlying config unchanged', () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, { ...sdkConfig, disabled: true });

    expect(instrumented.config).toBe(client.config);
  });
});

// ---------------------------------------------------------------------------
// complete()
// ---------------------------------------------------------------------------

describe('complete()', () => {
  it('returns the LLM response to the caller', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    const response = await instrumented.complete(mockMessages);

    expect(response.content).toBe('Hello back');
    expect(response.usage).toEqual(mockUsage);
  });

  it('dispatches a CallRecord asynchronously (fetch called once)', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    // Allow microtasks to settle
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fetch).toHaveBeenCalledOnce();
  });

  it('sends CallRecord to the ingestionUrl with correct method and headers', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [url, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    expect(url).toBe(sdkConfig.ingestionUrl);
    expect(init.method).toBe('POST');
    // biome-ignore lint/complexity/useLiteralKeys: init.headers is Record<string, string>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${sdkConfig.ingestionKey}`
    );
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('CallRecord contains all required fields with correct values', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['agent_id']).toBe(sdkConfig.identity.agentId);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['model']).toBe('claude-sonnet-4-6');
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['prompt_tokens']).toBe(mockUsage.inputTokens);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['completion_tokens']).toBe(mockUsage.outputTokens);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['task_label']).toBe(sdkConfig.identity.taskLabel);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['project_id']).toBe(sdkConfig.identity.projectId);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(typeof body['latency_ms']).toBe('number');
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(typeof body['timestamp']).toBe('string');
    // ISO 8601 UTC — ends with Z or +00:00
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['timestamp']).toMatch(/Z$/);
    // UUID v4 format
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['call_id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('includes cache tokens in CallRecord when present', async () => {
    const usageWithCache: LlmUsage = {
      ...mockUsage,
      cacheCreationTokens: 20,
      cacheReadTokens: 10,
    };
    const client = makeMockClient({
      complete: vi.fn().mockResolvedValue({
        content: 'ok',
        model: 'claude-sonnet-4-6',
        usage: usageWithCache,
        latencyMs: 100,
      }),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cache_creation_tokens']).toBe(20);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cache_read_tokens']).toBe(10);
  });

  it('omits optional CallRecord fields when identity fields are absent', async () => {
    const client = makeMockClient();
    const minimalConfig: AgentSdkConfig = {
      identity: { agentId: VALID_AGENT_UUID },
      ingestionUrl: 'https://spend.example.com/api/ingest',
      ingestionKey: 'key',
    };
    const instrumented = instrumentClient(client, minimalConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['task_label']).toBeUndefined();
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['project_id']).toBeUndefined();
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cache_creation_tokens']).toBeUndefined();
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cache_read_tokens']).toBeUndefined();
  });

  it('propagates LlmError to the caller', async () => {
    const error = new Error('Rate limit exceeded');
    const client = makeMockClient({
      complete: vi.fn().mockRejectedValue(error),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await expect(instrumented.complete(mockMessages)).rejects.toThrow('Rate limit exceeded');
    // No dispatch on error
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe('stream()', () => {
  async function* makeStream(chunks: Array<{ token: string; usage?: LlmUsage }>) {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  it('yields all tokens through to the caller', async () => {
    const chunks = [{ token: 'Hello' }, { token: ' world' }, { token: '!', usage: mockUsage }];
    const client = makeMockClient({
      stream: vi.fn().mockReturnValue(makeStream(chunks)),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    const received = await drainStream(instrumented.stream(mockMessages));

    expect(received).toHaveLength(3);
    expect(received[0]?.token).toBe('Hello');
    expect(received[1]?.token).toBe(' world');
    expect(received[2]?.token).toBe('!');
  });

  it('dispatches CallRecord after stream ends (usage from final chunk)', async () => {
    const chunks = [{ token: 'A' }, { token: 'B', usage: mockUsage }];
    const client = makeMockClient({
      stream: vi.fn().mockReturnValue(makeStream(chunks)),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await drainStream(instrumented.stream(mockMessages));
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['prompt_tokens']).toBe(mockUsage.inputTokens);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['completion_tokens']).toBe(mockUsage.outputTokens);
  });

  it('does not dispatch CallRecord when no usage chunk arrives', async () => {
    const chunks = [{ token: 'A' }, { token: 'B' }];
    const client = makeMockClient({
      stream: vi.fn().mockReturnValue(makeStream(chunks)),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await drainStream(instrumented.stream(mockMessages));
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates stream errors to the caller without dispatching', async () => {
    async function* failingStream() {
      yield { token: 'partial' };
      throw new Error('Stream interrupted');
    }
    const client = makeMockClient({
      stream: vi.fn().mockReturnValue(failingStream()),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await expect(drainStream(instrumented.stream(mockMessages))).rejects.toThrow(
      'Stream interrupted'
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// structured()
// ---------------------------------------------------------------------------

describe('structured()', () => {
  it('returns the structured response to the caller', async () => {
    const schema = { parse: (data: unknown) => data as { answer: string } };
    const client = makeMockClient({
      structured: vi.fn().mockResolvedValue({
        data: { answer: '42' },
        usage: mockUsage,
        latencyMs: 300,
      }),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    const result = await instrumented.structured(mockMessages, schema);

    expect(result.data).toEqual({ answer: '42' });
  });

  it('dispatches a CallRecord after structured() completes', async () => {
    const schema = { parse: (data: unknown) => data };
    const client = makeMockClient({
      structured: vi.fn().mockResolvedValue({
        data: null,
        usage: mockUsage,
        latencyMs: 100,
      }),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.structured(mockMessages, schema);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// streamStructured()
// ---------------------------------------------------------------------------

describe('streamStructured()', () => {
  async function* makeStructuredStream<T>(
    tokens: string[],
    doneData: T
  ): AsyncGenerator<LlmStreamStructuredEvent<T>> {
    for (const token of tokens) {
      yield { type: 'token', token };
    }
    yield { type: 'done', data: doneData, usage: mockUsage };
  }

  it('yields all token and done events through to the caller', async () => {
    const schema = { parse: (d: unknown) => d as { value: number } };
    const client = makeMockClient({
      streamStructured: vi
        .fn()
        .mockReturnValue(makeStructuredStream(['{"val', 'ue":1}'], { value: 1 })),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    const events = await drainStream(instrumented.streamStructured(mockMessages, schema));

    expect(events).toHaveLength(3); // 2 token + 1 done
    expect(events[0]).toEqual({ type: 'token', token: '{"val' });
    expect(events[1]).toEqual({ type: 'token', token: 'ue":1}' });
    expect(events[2]).toMatchObject({ type: 'done', data: { value: 1 } });
  });

  it('dispatches exactly one CallRecord per call (not per chunk) using done event usage', async () => {
    const schema = { parse: (d: unknown) => d };
    const client = makeMockClient({
      streamStructured: vi.fn().mockReturnValue(makeStructuredStream(['a', 'b', 'c'], null)),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await drainStream(instrumented.streamStructured(mockMessages, schema));
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['prompt_tokens']).toBe(mockUsage.inputTokens);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['completion_tokens']).toBe(mockUsage.outputTokens);
  });

  it('does not dispatch when stream errors before done event', async () => {
    async function* failingStructuredStream(): AsyncGenerator<LlmStreamStructuredEvent<unknown>> {
      yield { type: 'token', token: 'partial' };
      throw new Error('Stream interrupted mid-JSON');
    }
    const schema = { parse: (d: unknown) => d };
    const client = makeMockClient({
      streamStructured: vi.fn().mockReturnValue(failingStructuredStream()),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await expect(drainStream(instrumented.streamStructured(mockMessages, schema))).rejects.toThrow(
      'Stream interrupted mid-JSON'
    );
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not dispatch in disabled mode', async () => {
    const schema = { parse: (d: unknown) => d };
    const client = makeMockClient({
      streamStructured: vi.fn().mockReturnValue(makeStructuredStream(['token'], { answer: 'yes' })),
    });
    const instrumented = instrumentClient(client, { ...sdkConfig, disabled: true });

    await drainStream(instrumented.streamStructured(mockMessages, schema));
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Ingestion retry and exhaustion
// ---------------------------------------------------------------------------

describe('ingestion retry', () => {
  it('retries failed dispatch and succeeds on second attempt', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    vi.stubGlobal('fetch', mockFetch);

    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      maxIngestionRetries: 2,
      ingestionTimeoutMs: 100,
    });

    await instrumented.complete(mockMessages);
    // Wait for retry (first fail + delay + second attempt)
    await new Promise<void>((r) => setTimeout(r, 700));

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('drops the record and logs a warning after all retries fail — never throws to caller', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    vi.stubGlobal('fetch', mockFetch);

    // Inject a logger spy via the pluggable interface
    const warnedEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    const testLogger: AgentSdkLogger = {
      warn: (event, data) => {
        warnedEvents.push({ event, data });
      },
    };
    setAgentSdkLogger(testLogger);

    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      maxIngestionRetries: 1,
      ingestionTimeoutMs: 100,
    });

    // complete() must not throw even when all ingestion retries fail
    await expect(instrumented.complete(mockMessages)).resolves.toBeDefined();

    // Wait for both attempts (attempt 0 + 500ms delay + attempt 1)
    await new Promise<void>((r) => setTimeout(r, 700));

    // fetch called maxRetries + 1 times (attempts 0 and 1)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warnedEvents).toHaveLength(1);

    const entry = warnedEvents[0];
    expect(entry?.event).toBe('ingestion_exhausted');
    // biome-ignore lint/complexity/useLiteralKeys: entry.data is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(entry?.data['call_id']).toBeDefined();
    // ingestionKey must never appear in logs
    expect(JSON.stringify(entry?.data)).not.toContain(sdkConfig.ingestionKey);
  });

  it('handles fetch network errors (throws) the same as HTTP failures', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    // Inject a logger spy via the pluggable interface
    let warnCallCount = 0;
    setAgentSdkLogger({
      warn: () => {
        warnCallCount++;
      },
    });

    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      maxIngestionRetries: 0,
      ingestionTimeoutMs: 100,
    });

    await expect(instrumented.complete(mockMessages)).resolves.toBeDefined();
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(warnCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Security: ingestionKey must never be logged
// ---------------------------------------------------------------------------

describe('security', () => {
  it('uses ingestionKey as Authorization Bearer header', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    // biome-ignore lint/complexity/useLiteralKeys: init.headers is Record<string, string>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      `Bearer ${sdkConfig.ingestionKey}`
    );
  });

  it('warning log on exhaustion never contains ingestionKey', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
    vi.stubGlobal('fetch', mockFetch);

    // Inject a logger spy via the pluggable interface
    const warnedPayloads: string[] = [];
    setAgentSdkLogger({
      warn: (event, data) => {
        warnedPayloads.push(JSON.stringify({ event, ...data }));
      },
    });

    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      maxIngestionRetries: 0,
    });

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 50));

    for (const payload of warnedPayloads) {
      expect(payload).not.toContain(sdkConfig.ingestionKey);
    }
  });
});

// ---------------------------------------------------------------------------
// UUID validation (v3.2.0) — instrumentClient() startup checks
// ---------------------------------------------------------------------------

describe('UUID validation', () => {
  /**
   * Spy on console.warn before each test in this suite so we can assert exactly
   * how many times it fires and what it says. We restore in afterEach via the
   * top-level vi.restoreAllMocks().
   */

  // AC1: valid agentId + valid projectId → enabled (no warn, fetch called)
  it('AC1: valid agentId + valid projectId → enabled, no console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      identity: { agentId: VALID_AGENT_UUID, projectId: VALID_PROJECT_UUID },
    });

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(instrumented.sdkConfig.disabled).toBeFalsy();
  });

  // AC2 (criterion 1): invalid agentId, valid projectId → disabled + exactly one warn naming agentId
  it('AC2: invalid agentId → disabled, one console.warn naming agentId', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      identity: { agentId: 'fitcheck-llm', projectId: VALID_PROJECT_UUID },
    });

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('agentId');
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain('projectId');
    expect(fetch).not.toHaveBeenCalled();
    expect(instrumented.sdkConfig.disabled).toBe(true);
  });

  // AC3 (criterion 2): valid agentId, invalid projectId → disabled + exactly one warn naming projectId
  it('AC3: valid agentId + invalid projectId → disabled, one console.warn naming projectId', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      identity: { agentId: VALID_AGENT_UUID, projectId: 'fitcheckerapp' },
    });

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[0]).toContain('projectId');
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain('agentId');
    expect(fetch).not.toHaveBeenCalled();
    expect(instrumented.sdkConfig.disabled).toBe(true);
  });

  // AC4 (criterion 4): valid agentId, projectId omitted → enabled (optional field)
  it('AC4: valid agentId + omitted projectId → enabled, no warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      identity: { agentId: VALID_AGENT_UUID },
    });

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(instrumented.sdkConfig.disabled).toBeFalsy();
  });

  // AC5 (criterion 5): both agentId and projectId invalid → disabled + exactly ONE consolidated warn
  it('AC5: both agentId and projectId invalid → disabled, exactly one consolidated console.warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = makeMockClient();
    const instrumented = instrumentClient(client, {
      ...sdkConfig,
      identity: { agentId: 'fitcheck-llm', projectId: 'fitcheckerapp' },
    });

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    // Exactly ONE warn — not two separate ones
    expect(warnSpy).toHaveBeenCalledOnce();
    // The single warn names both fields
    expect(warnSpy.mock.calls[0]?.[0]).toContain('agentId');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('projectId');
    expect(fetch).not.toHaveBeenCalled();
    expect(instrumented.sdkConfig.disabled).toBe(true);
  });

  // AC6 (criterion 6): structured log event emitted via getLogger() on invalid config
  it('AC6: invalid agentId → structured log event ingestion_disabled_invalid_config with field name, not value', async () => {
    vi.spyOn(console, 'warn');
    const loggedEvents: Array<{ event: string; data: Record<string, unknown> }> = [];
    const testLogger: AgentSdkLogger = {
      warn: (event, data) => {
        loggedEvents.push({ event, data });
      },
    };
    setAgentSdkLogger(testLogger);

    const client = makeMockClient();
    instrumentClient(client, {
      ...sdkConfig,
      identity: { agentId: 'not-a-uuid', projectId: VALID_PROJECT_UUID },
    });

    expect(loggedEvents).toHaveLength(1);
    expect(loggedEvents[0]?.event).toBe('ingestion_disabled_invalid_config');
    // biome-ignore lint/complexity/useLiteralKeys: data is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(loggedEvents[0]?.data['invalidFields']).toContain('agentId');
    // Value must never appear — PII safety
    expect(JSON.stringify(loggedEvents[0]?.data)).not.toContain('not-a-uuid');
  });

  // AC7 (criterion 5 — disabled: true explicitly): no validation, no warn
  it('AC7: disabled: true explicitly passed → no UUID validation, no warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const client = makeMockClient();
    instrumentClient(client, {
      ...sdkConfig,
      identity: { agentId: 'definitely-not-a-uuid', projectId: 'also-not-a-uuid' },
      disabled: true,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withTools()
// ---------------------------------------------------------------------------

describe('withTools()', () => {
  const mockTool = {
    name: 'get_weather',
    description: 'Get weather.',
    inputSchema: {
      kind: 'jsonSchema' as const,
      schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  };

  it('returns the LlmToolResponse from the underlying client', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    const result = await instrumented.withTools(
      [{ role: 'user', content: 'What is the weather in London?' }],
      [mockTool]
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('get_weather');
    expect(result.stopReason).toBe('tool_use');
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.usage).toEqual(mockUsage);
  });

  it('dispatches a CallRecord with tool_calls populated', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.withTools([{ role: 'user', content: 'Weather?' }], [mockTool]);

    // Allow the fire-and-forget dispatch to run
    await new Promise<void>((r) => setTimeout(r, 20));

    const mockFetch = vi.mocked(fetch);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [, init] = getFirstFetchCall(mockFetch);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(Array.isArray(body['tool_calls'])).toBe(true);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    const toolCalls = body['tool_calls'] as LlmToolCall[];
    expect(toolCalls[0]?.toolName).toBe('get_weather');
    expect(toolCalls[0]?.id).toBe('call_test_123');
  });

  it('does NOT include tool_calls in CallRecord when toolCalls array is empty', async () => {
    const clientWithNoTools = makeMockClient({
      withTools: vi.fn().mockResolvedValue({
        content: 'No tools needed.',
        toolCalls: [],
        model: 'claude-sonnet-4-6',
        usage: mockUsage,
        latencyMs: 80,
        stopReason: 'end_turn',
      }),
    });
    const instrumented = instrumentClient(clientWithNoTools, sdkConfig);

    await instrumented.withTools([{ role: 'user', content: 'Hi' }], [mockTool]);

    await new Promise<void>((r) => setTimeout(r, 20));

    const [, init] = getFirstFetchCall(vi.mocked(fetch));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    // tool_calls should be absent (not present at all) when no tools were called
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['tool_calls']).toBeUndefined();
  });

  it('propagates LlmError from the underlying client (no swallow)', async () => {
    const err = new Error('Model refused tool call');
    const clientThatFails = makeMockClient({
      withTools: vi.fn().mockRejectedValue(err),
    });
    const instrumented = instrumentClient(clientThatFails, sdkConfig);

    await expect(
      instrumented.withTools([{ role: 'user', content: 'Use a tool' }], [mockTool])
    ).rejects.toThrow('Model refused tool call');
  });

  it('includes model and usage in the CallRecord', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.withTools([{ role: 'user', content: 'Hi' }], [mockTool]);
    await new Promise<void>((r) => setTimeout(r, 20));

    const [, init] = getFirstFetchCall(vi.mocked(fetch));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['model']).toBe('claude-sonnet-4-6');
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['prompt_tokens']).toBe(mockUsage.inputTokens);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['completion_tokens']).toBe(mockUsage.outputTokens);
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['agent_id']).toBe(sdkConfig.identity.agentId);
  });

  it('skips dispatch in disabled mode', async () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, { ...sdkConfig, disabled: true });

    await instrumented.withTools([{ role: 'user', content: 'Hi' }], [mockTool]);
    await new Promise<void>((r) => setTimeout(r, 20));

    expect(fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cost propagation (v1.1.0)
// ---------------------------------------------------------------------------

describe('cost propagation', () => {
  const mockCost = {
    input: 0.001,
    output: 0.002,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0.003,
    currency: 'USD' as const,
    isPartial: false,
  };

  it('includes cost in CallRecord when complete() response carries cost', async () => {
    const client = makeMockClient({
      complete: vi.fn().mockResolvedValue({
        content: 'Hello',
        model: 'claude-sonnet-4-6',
        usage: mockUsage,
        latencyMs: 100,
        cost: mockCost,
      }),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cost']).toEqual(mockCost);
  });

  it('omits cost from CallRecord when complete() response has no cost', async () => {
    // Default makeMockClient() does not include cost on the response
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cost']).toBeUndefined();
  });

  it('includes cost in CallRecord when structured() response carries cost', async () => {
    const schema = { parse: (d: unknown) => d as { answer: string } };
    const client = makeMockClient({
      structured: vi.fn().mockResolvedValue({
        data: { answer: '42' },
        usage: mockUsage,
        latencyMs: 200,
        cost: mockCost,
      }),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.structured(mockMessages, schema);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cost']).toEqual(mockCost);
  });

  it('includes cost in CallRecord when withTools() response carries cost', async () => {
    const mockTool = {
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: {
        kind: 'jsonSchema' as const,
        schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    };
    const client = makeMockClient({
      withTools: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [mockToolCall],
        model: 'claude-sonnet-4-6',
        usage: mockUsage,
        latencyMs: 150,
        stopReason: 'tool_use',
        cost: mockCost,
      }),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.withTools(mockMessages, [mockTool]);
    await new Promise<void>((r) => setTimeout(r, 20));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    expect(body['cost']).toEqual(mockCost);
  });

  it('propagates isPartial: true on the cost object correctly', async () => {
    const partialCost = { ...mockCost, isPartial: true, total: 0.001 };
    const client = makeMockClient({
      complete: vi.fn().mockResolvedValue({
        content: 'Hello',
        model: 'claude-sonnet-4-6',
        usage: mockUsage,
        latencyMs: 100,
        cost: partialCost,
      }),
    });
    const instrumented = instrumentClient(client, sdkConfig);

    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>; dot notation rejected by noPropertyAccessFromIndexSignature
    const recordedCost = body['cost'] as typeof partialCost;

    expect(recordedCost.isPartial).toBe(true);
    expect(recordedCost.total).toBe(0.001);
  });
});

// ---------------------------------------------------------------------------
// requestedModel propagation — v1.2.0 provider failover
// ---------------------------------------------------------------------------

describe('requestedModel propagation from provider failover', () => {
  const failoverSdkConfig: AgentSdkConfig = {
    identity: { agentId: VALID_AGENT_UUID },
    ingestionUrl: 'https://spend.example.com/api/ingest',
    ingestionKey: 'test-key',
    maxIngestionRetries: 0,
  };

  it('complete(): CallRecord includes requestedModel when failover occurred', async () => {
    const client = makeMockClient({
      complete: vi.fn().mockResolvedValue({
        content: 'hello',
        model: 'claude-3-haiku-20240307', // fallback model actually served
        requestedModel: 'claude-opus-4-99', // primary that was originally requested
        usage: mockUsage,
        latencyMs: 80,
      }),
    });

    const instrumented = instrumentClient(client, failoverSdkConfig);
    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>
    expect(body['model']).toBe('claude-3-haiku-20240307');
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>
    expect(body['requestedModel']).toBe('claude-opus-4-99');
  });

  it('complete(): CallRecord omits requestedModel when no failover occurred', async () => {
    const client = makeMockClient({
      complete: vi.fn().mockResolvedValue({
        content: 'hello',
        model: 'claude-sonnet-4-6',
        // requestedModel absent — no failover
        usage: mockUsage,
        latencyMs: 80,
      }),
    });

    const instrumented = instrumentClient(client, failoverSdkConfig);
    await instrumented.complete(mockMessages);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>
    expect(body['requestedModel']).toBeUndefined();
  });

  it('structured(): CallRecord includes requestedModel when failover occurred', async () => {
    const schema = { parse: (d: unknown) => d as { answer: string } };
    const client = makeMockClient({
      structured: vi.fn().mockResolvedValue({
        data: { answer: '42' },
        model: 'claude-3-haiku-20240307',
        requestedModel: 'claude-opus-4-99',
        usage: mockUsage,
        latencyMs: 80,
      }),
    });

    const instrumented = instrumentClient(client, failoverSdkConfig);
    await instrumented.structured(mockMessages, schema);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>
    expect(body['requestedModel']).toBe('claude-opus-4-99');
  });

  it('withTools(): CallRecord includes requestedModel when failover occurred', async () => {
    const client = makeMockClient({
      withTools: vi.fn().mockResolvedValue({
        content: '',
        toolCalls: [],
        model: 'claude-3-haiku-20240307',
        requestedModel: 'claude-opus-4-99',
        usage: mockUsage,
        latencyMs: 90,
        stopReason: 'end_turn' as const,
      }),
    });

    const instrumented = instrumentClient(client, failoverSdkConfig);
    await instrumented.withTools(mockMessages, []);
    await new Promise<void>((r) => setTimeout(r, 0));

    const [, init] = getFirstFetchCall(fetch as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // biome-ignore lint/complexity/useLiteralKeys: body is Record<string, unknown>
    expect(body['requestedModel']).toBe('claude-opus-4-99');
  });
});

// ---------------------------------------------------------------------------
// files passthrough (v5.1.0)
// ---------------------------------------------------------------------------

describe('files passthrough', () => {
  it('instrumented.files is the same reference as client.files', () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, sdkConfig);

    // files is a direct passthrough — not wrapped, not recorded, not instrumented.
    // The same object reference must be exposed so callers can upload/delete
    // without going through the dispatch layer.
    expect(instrumented.files).toBe(client.files);
  });

  it('instrumented.files is accessible in disabled mode', () => {
    const client = makeMockClient();
    const instrumented = instrumentClient(client, { ...sdkConfig, disabled: true });

    expect(instrumented.files).toBe(client.files);
  });

  it('calling instrumented.files.upload() delegates to the underlying client.files.upload()', async () => {
    const mockUpload = vi.fn().mockResolvedValueOnce({
      id: 'files/abc123',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
      provider: 'gemini' as const,
      mediaType: 'video/mp4' as const,
      sizeBytes: 1024,
      state: 'active' as const,
    });
    const client = makeMockClient({
      files: {
        upload: mockUpload,
        refresh: vi.fn().mockRejectedValue(new Error('not implemented')),
        waitForActive: vi.fn().mockRejectedValue(new Error('not implemented')),
        delete: vi.fn().mockRejectedValue(new Error('not implemented')),
      },
    });
    const instrumented = instrumentClient(client, sdkConfig);

    const data = Buffer.alloc(1024);
    await instrumented.files.upload({ data, mediaType: 'video/mp4' });

    expect(mockUpload).toHaveBeenCalledWith({ data, mediaType: 'video/mp4' });
    // files.upload does NOT trigger a dispatch (no fetch call)
    expect(fetch).not.toHaveBeenCalled();
  });
});
