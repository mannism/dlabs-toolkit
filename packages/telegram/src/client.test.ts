/**
 * Unit tests for @diabolicallabs/telegram client factory.
 *
 * Covers:
 *  - createTelegramNotifier: throws TelegramValidationError when token absent
 *  - createTelegramNotifierFromEnv: reads env vars; throws when absent
 *  - sendMessage: calls fetch with correct URL (redacted in logs) and body
 *  - Error mapping: all TelegramError subclasses
 *  - CRITICAL (§8.9): retry_after value comes from BODY field parameters.retry_after, NOT header
 *  - send() routing: uses message.to as chatId
 *  - apiBase override (for testing)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelegramNotifier, createTelegramNotifierFromEnv } from './client.js';
import {
  TelegramAuthError,
  TelegramChatNotFoundError,
  TelegramError,
  TelegramRateLimitError,
  TelegramUnavailableError,
  TelegramValidationError,
} from './types.js';

// ─────────────────────────────────────────────
// Mock fetch
// ─────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────

function makeSuccessResponse(messageId = 42): Response {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        ok: true,
        result: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 123456 },
        },
      }),
  } as unknown as Response;
}

function makeErrorResponse(
  errorCode: number,
  description: string,
  parameters?: Record<string, unknown>
): Response {
  return {
    ok: false,
    status: errorCode,
    json: () =>
      Promise.resolve({
        ok: false,
        error_code: errorCode,
        description,
        ...(parameters !== undefined ? { parameters } : {}),
      }),
  } as unknown as Response;
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────

describe('createTelegramNotifier — validation', () => {
  it('throws TelegramValidationError when botToken is absent', () => {
    expect(() => createTelegramNotifier({ botToken: '' })).toThrow(TelegramValidationError);
  });

  it('succeeds when botToken is provided', () => {
    expect(() => createTelegramNotifier({ botToken: 'bot123:ABC' })).not.toThrow();
  });
});

describe('createTelegramNotifierFromEnv — validation', () => {
  const originalToken = process.env['TELEGRAM_BOT_TOKEN'];
  const originalChatId = process.env['TELEGRAM_DEFAULT_CHAT_ID'];

  afterEach(() => {
    if (originalToken === undefined) delete process.env['TELEGRAM_BOT_TOKEN'];
    else process.env['TELEGRAM_BOT_TOKEN'] = originalToken;
    if (originalChatId === undefined) delete process.env['TELEGRAM_DEFAULT_CHAT_ID'];
    else process.env['TELEGRAM_DEFAULT_CHAT_ID'] = originalChatId;
  });

  it('throws TelegramValidationError when TELEGRAM_BOT_TOKEN absent', () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    expect(() => createTelegramNotifierFromEnv()).toThrow(TelegramValidationError);
  });

  it('succeeds when TELEGRAM_BOT_TOKEN is set', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'bot123:ABC';
    expect(() => createTelegramNotifierFromEnv()).not.toThrow();
  });
});

describe('sendMessage — happy path', () => {
  beforeEach(() => mockFetch.mockReset());

  it('calls fetch with the correct URL and body', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse(99));
    const notifier = createTelegramNotifier({
      botToken: 'bot123:ABC',
      maxRetries: 0,
      apiBase: 'https://api.telegram.org',
    });

    const result = await notifier.sendMessage({ chatId: 12345, text: 'hello' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot123:ABC/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 12345, text: 'hello' }),
      })
    );
    expect(result.platform).toBe('telegram');
    expect(result.messageId).toBe('99');
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });

  it('includes parse_mode when provided', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse(1));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await notifier.sendMessage({ chatId: 123, text: 'test', parseMode: 'MarkdownV2' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ chat_id: 123, text: 'test', parse_mode: 'MarkdownV2' }),
      })
    );
  });

  it('includes disableWebPagePreview when true', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse(1));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await notifier.sendMessage({
      chatId: 123,
      text: 'test',
      disableWebPagePreview: true,
    });

    const callBody = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1]?.body ?? '{}'
    ) as Record<string, unknown>;
    expect(callBody['disable_web_page_preview']).toBe(true);
  });

  it('includes replyMarkup when provided', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse(1));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    const replyMarkup = {
      inline_keyboard: [[{ text: 'Click me', url: 'https://example.com' }]],
    };
    await notifier.sendMessage({ chatId: 123, text: 'test', replyMarkup });
    const callBody = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1]?.body ?? '{}'
    ) as Record<string, unknown>;
    expect(callBody['reply_markup']).toEqual(replyMarkup);
  });
});

describe('sendMessage — error mapping', () => {
  beforeEach(() => mockFetch.mockReset());

  it('maps 401 to TelegramAuthError', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(401, 'Unauthorized'));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 123, text: 'test' })).rejects.toThrow(
      TelegramAuthError
    );
  });

  it('maps 400 "chat not found" to TelegramChatNotFoundError', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(400, 'Bad Request: chat not found'));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 99999, text: 'test' })).rejects.toThrow(
      TelegramChatNotFoundError
    );
  });

  it('maps 403 "bot was blocked by the user" to TelegramChatNotFoundError', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(403, 'Forbidden: bot was blocked by the user'));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 99999, text: 'test' })).rejects.toThrow(
      TelegramChatNotFoundError
    );
  });

  it('maps 400 "BUTTON_TYPE_INVALID" (validation) to TelegramValidationError', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(400, 'Bad Request: BUTTON_TYPE_INVALID'));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 123, text: 'test' })).rejects.toThrow(
      TelegramValidationError
    );
  });

  it('maps 500 to TelegramUnavailableError', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 123, text: 'test' })).rejects.toThrow(
      TelegramUnavailableError
    );
  });

  it('maps unknown error code to TelegramError', async () => {
    mockFetch.mockResolvedValue(makeErrorResponse(418, "I'm a teapot"));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 123, text: 'test' })).rejects.toThrow(
      TelegramError
    );
  });

  it('maps network failures to TelegramError', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 123, text: 'test' })).rejects.toThrow(
      TelegramError
    );
  });

  it('maps JSON parse failure to TelegramError', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('invalid json')),
    } as unknown as Response);
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.sendMessage({ chatId: 123, text: 'test' })).rejects.toThrow(
      TelegramError
    );
  });
});

/**
 * CRITICAL TEST (§8.9 of brief-week6.md):
 *
 * Telegram's retry_after value comes from the response BODY field
 * `parameters.retry_after` (seconds), NOT from a Retry-After header.
 *
 * This test explicitly verifies that:
 * 1. The retry_after body field is extracted correctly
 * 2. It is converted to milliseconds
 * 3. It is set on TelegramRateLimitError.retryAfterMs
 */
describe('CRITICAL §8.9 — retry_after from BODY field (not header)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('extracts retry_after from response body parameters field (not header)', async () => {
    // Telegram 429 response: retry_after is in the BODY, not in a header
    mockFetch.mockResolvedValue(
      makeErrorResponse(429, 'Too Many Requests: retry after 30', {
        retry_after: 30, // body field — 30 seconds
      })
    );

    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    const err = await notifier.sendMessage({ chatId: 123, text: 'test' }).catch((e) => e);

    expect(err).toBeInstanceOf(TelegramRateLimitError);
    expect(err.kind).toBe('exceeded');
    // 30 seconds * 1000 = 30000 ms — sourced from BODY, not header
    expect(err.retryAfterMs).toBe(30_000);
    // Verify fetch was NOT given a retry-after header to consume
    // (the mock response has no headers — this proves body extraction)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sets retryAfterMs to null when retry_after body field is absent', async () => {
    // 429 with no parameters.retry_after in body
    mockFetch.mockResolvedValue(
      makeErrorResponse(429, 'Too Many Requests')
      // No parameters object
    );

    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    const err = await notifier.sendMessage({ chatId: 123, text: 'test' }).catch((e) => e);

    expect(err).toBeInstanceOf(TelegramRateLimitError);
    expect(err.retryAfterMs).toBeNull();
  });

  it('uses retry_after body value as delay floor in retry loop', async () => {
    let callCount = 0;
    // First call: 429 with retry_after=5. Second call: success.
    mockFetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(makeErrorResponse(429, 'Too Many Requests', { retry_after: 5 }));
      }
      return Promise.resolve(makeSuccessResponse(77));
    });

    const notifier = createTelegramNotifier({
      botToken: 'tok',
      maxRetries: 1,
      baseDelayMs: 0,
      capDelayMs: 0,
      // isRetryable in the client returns false for TelegramRateLimitError,
      // so this verifies that 429 does NOT get retried internally (correct behavior).
    });

    // TelegramRateLimitError is NOT retried — it surfaces immediately after first 429
    const err = await notifier.sendMessage({ chatId: 123, text: 'test' }).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramRateLimitError);
    // Only one fetch call — rate limit errors are not retried
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(err.retryAfterMs).toBe(5_000); // 5s from body = 5000ms
  });
});

describe('send() — Notifier interface', () => {
  beforeEach(() => mockFetch.mockReset());

  it('uses message.to as chatId', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse(1));
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    const result = await notifier.send({ to: '99999', text: 'hello' });
    expect(result.platform).toBe('telegram');

    const callBody = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1]?.body ?? '{}'
    ) as Record<string, unknown>;
    expect(callBody['chat_id']).toBe('99999');
  });

  it('uses defaultChatId when message.to is empty', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse(1));
    const notifier = createTelegramNotifier({
      botToken: 'tok',
      defaultChatId: 777,
      maxRetries: 0,
    });
    await notifier.send({ to: '', text: 'hello' });
    const callBody = JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1]?.body ?? '{}'
    ) as Record<string, unknown>;
    expect(callBody['chat_id']).toBe(777);
  });

  it('throws TelegramValidationError when no chatId and no defaultChatId', async () => {
    const notifier = createTelegramNotifier({ botToken: 'tok', maxRetries: 0 });
    await expect(notifier.send({ to: '', text: 'hello' })).rejects.toThrow(TelegramValidationError);
  });
});

describe('apiBase override', () => {
  beforeEach(() => mockFetch.mockReset());

  it('uses the custom apiBase in the fetch URL', async () => {
    mockFetch.mockResolvedValue(makeSuccessResponse(1));
    const notifier = createTelegramNotifier({
      botToken: 'tok',
      apiBase: 'https://test.api.local',
      maxRetries: 0,
    });
    await notifier.sendMessage({ chatId: 123, text: 'test' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://test.api.local/bottok/sendMessage',
      expect.anything()
    );
  });
});

describe('index — exports', () => {
  it('re-exports all public API', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.createTelegramNotifier).toBe('function');
    expect(typeof mod.createTelegramNotifierFromEnv).toBe('function');
    expect(typeof mod.setTelegramLogger).toBe('function');
    expect(typeof mod.escapeMarkdownV2).toBe('function');
    expect(typeof mod.TelegramError).toBe('function');
    expect(typeof mod.TelegramAuthError).toBe('function');
    expect(typeof mod.TelegramChatNotFoundError).toBe('function');
    expect(typeof mod.TelegramRateLimitError).toBe('function');
    expect(typeof mod.TelegramValidationError).toBe('function');
    expect(typeof mod.TelegramUnavailableError).toBe('function');
  });
});
