/**
 * Unit tests for @diabolicallabs/slack client factory.
 *
 * Covers:
 *  - createSlackNotifier: throws SlackValidationError when no credentials
 *  - createSlackNotifierFromEnv: reads env vars; throws when absent
 *  - mapSdkError: error-mapping for each SlackError subclass (tested directly)
 *  - extractRetryAfterMs: retryAfter header extraction
 *  - postMessage: routes to WebClient.chat.postMessage via mock
 *  - postWebhook: uses fetch against the webhook URL
 *  - Rate-limiter peer-dep injection: check() called before postMessage
 *  - send() routing: postMessage when botToken set, postWebhook otherwise
 *  - Retry-After header extraction for webhooks
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSlackNotifier,
  createSlackNotifierFromEnv,
  extractRetryAfterMs,
  mapSdkError,
} from './client.js';
import { setSlackLogger } from './logger.js';
import {
  SlackAuthError,
  SlackChannelNotFoundError,
  SlackError,
  SlackRateLimitError,
  SlackUnavailableError,
  SlackValidationError,
} from './types.js';

// ─────────────────────────────────────────────
// Mock @slack/web-api via vi.hoisted + vi.mock
// ─────────────────────────────────────────────

const { mockPostMessage } = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
}));

vi.mock('@slack/web-api', () => {
  class MockWebClient {
    chat: { postMessage: typeof mockPostMessage };
    constructor() {
      this.chat = { postMessage: mockPostMessage };
    }
  }
  return { WebClient: MockWebClient };
});

// ─────────────────────────────────────────────
// Mock fetch for webhook tests
// ─────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeOkResponse(status = 200): Response {
  return {
    ok: true,
    status,
    headers: { get: () => null } as unknown as Headers,
    text: () => Promise.resolve('ok'),
  } as unknown as Response;
}

function makeErrorResponse(status: number, headers?: Record<string, string>): Response {
  return {
    ok: false,
    status,
    headers: {
      get: (key: string) => headers?.[key] ?? null,
    } as unknown as Headers,
    text: () => Promise.resolve('error'),
  } as unknown as Response;
}

/** Create a Slack API error object matching the @slack/web-api shape */
function makeSlackApiError(
  errorCode: string,
  statusCode?: number,
  extra?: Record<string, unknown>
): Error & { data: { error: string }; code: string; statusCode?: number } {
  return Object.assign(new Error(errorCode), {
    data: { error: errorCode },
    code: errorCode,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...extra,
  }) as Error & { data: { error: string }; code: string; statusCode?: number };
}

// ─────────────────────────────────────────────
// mapSdkError — tested directly
// ─────────────────────────────────────────────

describe('mapSdkError — error mapping', () => {
  it('maps invalid_auth to SlackAuthError', () => {
    const err = makeSlackApiError('invalid_auth', 401);
    expect(mapSdkError(err)).toBeInstanceOf(SlackAuthError);
  });

  it('maps not_authed to SlackAuthError', () => {
    const err = makeSlackApiError('not_authed');
    expect(mapSdkError(err)).toBeInstanceOf(SlackAuthError);
  });

  it('maps token_revoked to SlackAuthError', () => {
    const err = makeSlackApiError('token_revoked');
    expect(mapSdkError(err)).toBeInstanceOf(SlackAuthError);
  });

  it('maps account_inactive to SlackAuthError', () => {
    const err = makeSlackApiError('account_inactive');
    expect(mapSdkError(err)).toBeInstanceOf(SlackAuthError);
  });

  it('maps statusCode 401 to SlackAuthError', () => {
    const err = makeSlackApiError('some_error', 401);
    expect(mapSdkError(err)).toBeInstanceOf(SlackAuthError);
  });

  it('maps statusCode 403 to SlackAuthError', () => {
    const err = makeSlackApiError('no_permission', 403);
    expect(mapSdkError(err)).toBeInstanceOf(SlackAuthError);
  });

  it('maps channel_not_found to SlackChannelNotFoundError', () => {
    const err = makeSlackApiError('channel_not_found');
    expect(mapSdkError(err)).toBeInstanceOf(SlackChannelNotFoundError);
  });

  it('maps invalid_arguments to SlackValidationError', () => {
    const err = makeSlackApiError('invalid_arguments');
    expect(mapSdkError(err)).toBeInstanceOf(SlackValidationError);
  });

  it('maps missing_text_or_fallback_or_attachments to SlackValidationError', () => {
    const err = makeSlackApiError('missing_text_or_fallback_or_attachments');
    expect(mapSdkError(err)).toBeInstanceOf(SlackValidationError);
  });

  it('maps 429/ratelimited to SlackRateLimitError with kind=exceeded', () => {
    const err = makeSlackApiError('ratelimited', 429, { retryAfter: 30 });
    const mapped = mapSdkError(err);
    expect(mapped).toBeInstanceOf(SlackRateLimitError);
    expect((mapped as SlackRateLimitError).kind).toBe('exceeded');
  });

  it('maps service_unavailable (5xx) to SlackUnavailableError', () => {
    const err = makeSlackApiError('service_unavailable', 503);
    expect(mapSdkError(err)).toBeInstanceOf(SlackUnavailableError);
  });

  it('maps fatal_error to SlackUnavailableError', () => {
    const err = makeSlackApiError('fatal_error');
    expect(mapSdkError(err)).toBeInstanceOf(SlackUnavailableError);
  });

  it('maps unknown SDK error to SlackError (generic)', () => {
    const err = makeSlackApiError('unknown_code', 400);
    expect(mapSdkError(err)).toBeInstanceOf(SlackError);
  });

  it('maps plain Error (network) to SlackError (generic)', () => {
    expect(mapSdkError(new Error('network timeout'))).toBeInstanceOf(SlackError);
  });

  it('maps unknown non-Error value to SlackError (generic)', () => {
    expect(mapSdkError('string error')).toBeInstanceOf(SlackError);
  });
});

// ─────────────────────────────────────────────
// extractRetryAfterMs — tested directly
// ─────────────────────────────────────────────

describe('extractRetryAfterMs', () => {
  it('returns retryAfter * 1000 when present', () => {
    const err = makeSlackApiError('ratelimited', 429, { retryAfter: 30 });
    expect(extractRetryAfterMs(err)).toBe(30_000);
  });

  it('returns null when retryAfter is absent', () => {
    expect(extractRetryAfterMs(new Error('nope'))).toBeNull();
  });

  it('returns null when retryAfter is 0', () => {
    const err = makeSlackApiError('ratelimited', 429, { retryAfter: 0 });
    expect(extractRetryAfterMs(err)).toBeNull();
  });
});

// ─────────────────────────────────────────────
// createSlackNotifier — validation
// ─────────────────────────────────────────────

describe('createSlackNotifier — validation', () => {
  it('throws SlackValidationError when both botToken and webhookUrl are absent', () => {
    expect(() => createSlackNotifier({})).toThrow(SlackValidationError);
  });

  it('throws SlackValidationError when both are empty strings', () => {
    expect(() => createSlackNotifier({ botToken: '', webhookUrl: '' })).toThrow(
      SlackValidationError
    );
  });

  it('succeeds when only botToken is provided', () => {
    expect(() => createSlackNotifier({ botToken: 'xoxb-test' })).not.toThrow();
  });

  it('succeeds when only webhookUrl is provided', () => {
    expect(() => createSlackNotifier({ webhookUrl: 'https://hooks.slack.com/test' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────
// createSlackNotifierFromEnv — validation
// ─────────────────────────────────────────────

describe('createSlackNotifierFromEnv — validation', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    if (originalEnv['SLACK_BOT_TOKEN'] === undefined) delete process.env['SLACK_BOT_TOKEN'];
    else process.env['SLACK_BOT_TOKEN'] = originalEnv['SLACK_BOT_TOKEN'];
    if (originalEnv['SLACK_WEBHOOK_URL'] === undefined) delete process.env['SLACK_WEBHOOK_URL'];
    else process.env['SLACK_WEBHOOK_URL'] = originalEnv['SLACK_WEBHOOK_URL'];
    if (originalEnv['SLACK_DEFAULT_CHANNEL'] === undefined)
      delete process.env['SLACK_DEFAULT_CHANNEL'];
    else process.env['SLACK_DEFAULT_CHANNEL'] = originalEnv['SLACK_DEFAULT_CHANNEL'];
  });

  it('throws SlackValidationError when both env vars absent', () => {
    delete process.env['SLACK_BOT_TOKEN'];
    delete process.env['SLACK_WEBHOOK_URL'];
    expect(() => createSlackNotifierFromEnv()).toThrow(SlackValidationError);
  });

  it('succeeds when SLACK_BOT_TOKEN is set', () => {
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test';
    delete process.env['SLACK_WEBHOOK_URL'];
    expect(() => createSlackNotifierFromEnv()).not.toThrow();
  });

  it('succeeds when SLACK_WEBHOOK_URL is set', () => {
    delete process.env['SLACK_BOT_TOKEN'];
    process.env['SLACK_WEBHOOK_URL'] = 'https://hooks.slack.com/test';
    expect(() => createSlackNotifierFromEnv()).not.toThrow();
  });
});

// ─────────────────────────────────────────────
// postMessage — happy path (via mock)
// ─────────────────────────────────────────────

describe('postMessage — happy path', () => {
  beforeEach(() => {
    mockPostMessage.mockReset();
    mockPostMessage.mockResolvedValue({ ok: true, ts: '1234567890.123' });
  });

  it('calls WebClient.chat.postMessage with correct args', async () => {
    const notifier = createSlackNotifier({
      botToken: 'xoxb-test',
      maxRetries: 0,
    });
    const result = await notifier.postMessage({ channel: '#alerts', text: 'hello' });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: '#alerts', text: 'hello' })
    );
    expect(result.platform).toBe('slack');
    expect(result.messageId).toBe('1234567890.123');
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });

  it('passes blocks when provided', async () => {
    const notifier = createSlackNotifier({ botToken: 'xoxb-test', maxRetries: 0 });
    const blocks = [{ type: 'section' as const, text: { type: 'mrkdwn' as const, text: 'hi' } }];
    await notifier.postMessage({ channel: '#test', text: 'fallback', blocks });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: expect.any(Array) })
    );
  });

  it('passes threadTs as thread_ts', async () => {
    const notifier = createSlackNotifier({ botToken: 'xoxb-test', maxRetries: 0 });
    await notifier.postMessage({ channel: '#test', text: 'reply', threadTs: '111.222' });
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: '111.222' }));
  });

  it('throws SlackValidationError when calling postMessage without botToken', async () => {
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
    });
    await expect(notifier.postMessage({ channel: '#x', text: 'test' })).rejects.toThrow(
      SlackValidationError
    );
  });
});

// ─────────────────────────────────────────────
// postWebhook — happy path
// ─────────────────────────────────────────────

describe('postWebhook — happy path', () => {
  beforeEach(() => mockFetch.mockReset());

  it('calls fetch with the webhook URL and correct body', async () => {
    mockFetch.mockResolvedValue(makeOkResponse());
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
    });
    const result = await notifier.postWebhook({ text: 'hello' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      })
    );
    expect(result.platform).toBe('slack');
    expect(result.messageId).toMatch(/^webhook-/);
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });

  it('allows per-call webhookUrl override', async () => {
    mockFetch.mockResolvedValue(makeOkResponse());
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/default',
      maxRetries: 0,
    });
    await notifier.postWebhook({
      text: 'hello',
      webhookUrl: 'https://hooks.slack.com/override',
    });
    expect(mockFetch).toHaveBeenCalledWith('https://hooks.slack.com/override', expect.anything());
  });
});

// ─────────────────────────────────────────────
// postWebhook — error mapping
// ─────────────────────────────────────────────

describe('postWebhook — error mapping', () => {
  beforeEach(() => mockFetch.mockReset());

  it('throws SlackRateLimitError on 429 with Retry-After header', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(429, { 'Retry-After': '60' }));
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
    });
    const err = await notifier.postWebhook({ text: 'test' }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackRateLimitError);
    expect(err.retryAfterMs).toBe(60_000);
  });

  it('throws SlackAuthError on 401', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401));
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
    });
    await expect(notifier.postWebhook({ text: 'test' })).rejects.toThrow(SlackAuthError);
  });

  it('throws SlackUnavailableError on 500', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500));
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
    });
    await expect(notifier.postWebhook({ text: 'test' })).rejects.toThrow(SlackUnavailableError);
  });

  it('throws SlackError on unexpected non-ok status', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(400));
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
    });
    await expect(notifier.postWebhook({ text: 'test' })).rejects.toThrow(SlackError);
  });

  it('throws SlackError on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
      timeoutMs: 30_000,
    });
    // postWebhook inner try/catch wraps network errors in SlackError
    await expect(notifier.postWebhook({ text: 'test' })).rejects.toThrow(SlackError);
  });

  it('throws SlackValidationError when webhookUrl absent', async () => {
    const notifier = createSlackNotifier({ botToken: 'xoxb-test', maxRetries: 0 });
    await expect(notifier.postWebhook({ text: 'test' })).rejects.toThrow(SlackValidationError);
  });
});

// ─────────────────────────────────────────────
// rate-limiter peer-dep injection
// ─────────────────────────────────────────────

describe('rate-limiter peer-dep injection', () => {
  beforeEach(() => {
    mockPostMessage.mockReset();
    mockPostMessage.mockResolvedValue({ ok: true, ts: '111.222' });
  });

  it('calls rateLimiter.check() before postMessage', async () => {
    const rateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, resetMs: 0 }),
      enforce: vi.fn(),
    };
    const notifier = createSlackNotifier({
      botToken: 'xoxb-test',
      maxRetries: 0,
      rateLimiter,
    });
    await notifier.postMessage({ channel: '#alerts', text: 'hello' });
    expect(rateLimiter.check).toHaveBeenCalledWith('slack:channel:#alerts');
  });

  it('throws SlackRateLimitError when rateLimiter.check returns allowed: false', async () => {
    const rateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: false, remaining: 0, resetMs: 1000 }),
      enforce: vi.fn(),
    };
    const notifier = createSlackNotifier({
      botToken: 'xoxb-test',
      maxRetries: 0,
      rateLimiter,
    });
    const err = await notifier.postMessage({ channel: '#x', text: 'test' }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackRateLimitError);
    expect(err.kind).toBe('exceeded');
    expect(err.retryAfterMs).toBe(1000);
    // postMessage should NOT have been called
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('logs SLACK_RATELIMITER_UNAVAILABLE and sends anyway when rateLimiter throws', async () => {
    const warnSpy = vi.fn();
    const rateLimiter = {
      check: vi.fn().mockRejectedValue(new Error('Redis down')),
      enforce: vi.fn(),
    };
    const notifier = createSlackNotifier({
      botToken: 'xoxb-test',
      maxRetries: 0,
      rateLimiter,
      logger: { warn: warnSpy },
    });
    // Should not throw — sends anyway
    await expect(notifier.postMessage({ channel: '#x', text: 'test' })).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'SLACK_RATELIMITER_UNAVAILABLE',
      expect.objectContaining({ channel: '#x' })
    );
    expect(mockPostMessage).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
// send() routing
// ─────────────────────────────────────────────

describe('send() routing', () => {
  beforeEach(() => {
    mockPostMessage.mockReset();
    mockFetch.mockReset();
  });

  it('routes to postMessage when botToken is configured', async () => {
    mockPostMessage.mockResolvedValue({ ok: true, ts: '999.000' });
    const notifier = createSlackNotifier({ botToken: 'xoxb-test', maxRetries: 0 });
    const result = await notifier.send({ to: '#alerts', text: 'hello' });
    expect(result.platform).toBe('slack');
    expect(mockPostMessage).toHaveBeenCalled();
  });

  it('routes to postWebhook when only webhookUrl is configured', async () => {
    mockFetch.mockResolvedValue(makeOkResponse());
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 0,
    });
    const result = await notifier.send({ to: '#ignored', text: 'hello' });
    expect(result.platform).toBe('slack');
    expect(mockFetch).toHaveBeenCalled();
  });

  it('uses defaultChannel when send message.to is empty', async () => {
    mockPostMessage.mockResolvedValue({ ok: true, ts: '000.111' });
    const notifier = createSlackNotifier({
      botToken: 'xoxb-test',
      defaultChannel: '#fleet-health',
      maxRetries: 0,
    });
    await notifier.send({ to: '', text: 'hello' });
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: '#fleet-health' })
    );
  });

  it('throws SlackValidationError when no channel and no defaultChannel', async () => {
    const notifier = createSlackNotifier({ botToken: 'xoxb-test', maxRetries: 0 });
    await expect(notifier.send({ to: '', text: 'hello' })).rejects.toThrow(SlackValidationError);
  });
});

// ─────────────────────────────────────────────
// index — exports
// ─────────────────────────────────────────────

describe('index — exports', () => {
  it('re-exports createSlackNotifier', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.createSlackNotifier).toBe('function');
    expect(typeof mod.createSlackNotifierFromEnv).toBe('function');
    expect(typeof mod.setSlackLogger).toBe('function');
    expect(typeof mod.SlackError).toBe('function');
    expect(typeof mod.SlackAuthError).toBe('function');
    expect(typeof mod.SlackChannelNotFoundError).toBe('function');
    expect(typeof mod.SlackRateLimitError).toBe('function');
    expect(typeof mod.SlackValidationError).toBe('function');
    expect(typeof mod.SlackUnavailableError).toBe('function');
  });
});

// ─────────────────────────────────────────────
// setSlackLogger — pluggable logger
// ─────────────────────────────────────────────

describe('setSlackLogger', () => {
  afterEach(() => {
    // Reset to default logger after each test
    setSlackLogger(null);
  });

  it('routes log output through custom logger', async () => {
    const warnSpy = vi.fn();
    setSlackLogger({ warn: warnSpy });

    mockPostMessage.mockResolvedValue({ ok: true, ts: '999.001' });
    const notifier = createSlackNotifier({ botToken: 'xoxb-test', maxRetries: 0 });
    await notifier.postMessage({ channel: '#test', text: 'hello' });

    // SLACK_POST_MESSAGE_OK is logged on success
    expect(warnSpy).toHaveBeenCalledWith('SLACK_POST_MESSAGE_OK', expect.any(Object));
  });

  it('resets to default logger when called with null', () => {
    const customWarn = vi.fn();
    setSlackLogger({ warn: customWarn });
    // Reset — should not throw
    expect(() => setSlackLogger(null)).not.toThrow();
  });
});

// ─────────────────────────────────────────────
// retry paths — onRetry callback coverage
// ─────────────────────────────────────────────

describe('retry paths', () => {
  beforeEach(() => {
    mockPostMessage.mockReset();
    mockFetch.mockReset();
  });

  it('postMessage: calls onRetry on transient 5xx then succeeds', async () => {
    // First call: service_unavailable (retryable). Second call: success.
    const unavailErr = makeSlackApiError('service_unavailable', 503);
    mockPostMessage
      .mockRejectedValueOnce(unavailErr)
      .mockResolvedValueOnce({ ok: true, ts: '123.456' });

    const warnSpy = vi.fn();
    const notifier = createSlackNotifier({
      botToken: 'xoxb-test',
      maxRetries: 1,
      baseDelayMs: 0, // no actual sleep in tests
      capDelayMs: 0,
      logger: { warn: warnSpy },
    });
    const result = await notifier.postMessage({ channel: '#alerts', text: 'test' });

    expect(result.messageId).toBe('123.456');
    // SLACK_RETRY is logged on the first failed attempt
    expect(warnSpy).toHaveBeenCalledWith('SLACK_RETRY', expect.objectContaining({ attempt: 0 }));
  });

  it('postWebhook: calls onRetry on 500 then succeeds', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(500)).mockResolvedValueOnce(makeOkResponse());

    const warnSpy = vi.fn();
    const notifier = createSlackNotifier({
      webhookUrl: 'https://hooks.slack.com/test',
      maxRetries: 1,
      baseDelayMs: 0,
      capDelayMs: 0,
      logger: { warn: warnSpy },
    });
    const result = await notifier.postWebhook({ text: 'test' });

    expect(result.platform).toBe('slack');
    expect(warnSpy).toHaveBeenCalledWith(
      'SLACK_RETRY',
      expect.objectContaining({ path: 'webhook' })
    );
  });
});
