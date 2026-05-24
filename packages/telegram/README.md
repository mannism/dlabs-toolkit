# `@diabolicallabs/telegram`

Send-only Telegram notifier using native `fetch` against `api.telegram.org`. No SDK dependency (no grammY, no telegraf).

## Install

```bash
pnpm add @diabolicallabs/telegram
```

## Usage

### From environment variables

```ts
import { createTelegramNotifierFromEnv } from '@diabolicallabs/telegram';

// Reads TELEGRAM_BOT_TOKEN and optional TELEGRAM_DEFAULT_CHAT_ID
const tg = createTelegramNotifierFromEnv();
await tg.sendMessage({ chatId: process.env.MY_CHAT_ID, text: 'Deploy complete' });
```

### Explicit config

```ts
import { createTelegramNotifier, escapeMarkdownV2 } from '@diabolicallabs/telegram';

const tg = createTelegramNotifier({
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  defaultChatId: process.env.TELEGRAM_CHAT_ID,
  maxRetries: 3,
  timeoutMs: 10_000,
});

// Plain text
await tg.sendMessage({ chatId: 123456, text: 'Fleet health check passed' });

// MarkdownV2 — MUST escape dynamic values
await tg.sendMessage({
  chatId: 123456,
  text: `Deploy *complete* — ${escapeMarkdownV2('v1.0.0')} is live\\.`,
  parseMode: 'MarkdownV2',
});
```

### Portable interface

```ts
import type { Notifier } from '@diabolicallabs/notifier-core';
import { createTelegramNotifierFromEnv } from '@diabolicallabs/telegram';

const notifier: Notifier = createTelegramNotifierFromEnv();
await notifier.send({ to: '123456', text: 'hello' });
```

### Inline keyboard (rich content)

```ts
await tg.sendMessage({
  chatId: 123456,
  text: 'New alert — click to view',
  replyMarkup: {
    inline_keyboard: [
      [{ text: 'View Dashboard', url: 'https://example.com/dashboard' }],
    ],
  },
});
```

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `botToken` | `string` | — | **Required.** Token from @BotFather. Never logged. |
| `defaultChatId` | `string \| number` | — | Default `chat_id` for `sendMessage` and `send()`. |
| `maxRetries` | `number` | `3` | Max retry attempts on transient failures. |
| `baseDelayMs` | `number` | `500` | Base delay for exponential backoff (ms). |
| `capDelayMs` | `number` | `2000` | Maximum delay cap for backoff (ms). |
| `timeoutMs` | `number` | `10000` | Per-request timeout (ms). |
| `logger` | `Logger` | stdout JSON | Pluggable logger. |
| `apiBase` | `string` | `https://api.telegram.org` | Override for self-hosted / testing. |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather. |
| `TELEGRAM_DEFAULT_CHAT_ID` | No | Default `chat_id` for `send()`. |

## MarkdownV2 escaping

> **Important:** MarkdownV2 parsing rules are strict. A parse_mode mismatch is a **silent failure** — Telegram sends the message but renders raw unescaped text instead of formatted output.

Always use `escapeMarkdownV2()` for dynamic values:

```ts
import { escapeMarkdownV2 } from '@diabolicallabs/telegram';

// Escapes: \ _ * [ ] ( ) ~ ` > # + - = | { } . !
const safe = escapeMarkdownV2('Price: $1.99 (v1.0.0!)');
// → 'Price: $1\\.99 \\(v1\\.0\\.0\\!\\)'
```

**Special characters escaped:** `\` `_` `*` `[` `]` `(` `)` `~` `` ` `` `>` `#` `+` `-` `=` `|` `{` `}` `.` `!` (18 characters + backslash = 19 total)

## Cold-DM constraint

> **Important:** Telegram's privacy model **forbids a bot from initiating a DM** to a user who has never messaged the bot first. Channel and group sends are unrestricted.

If you try to send to a user who hasn't messaged your bot:
- The API returns `403 Forbidden: bot was blocked by the user` or `400 Bad Request: chat not found`
- The package surfaces this as `TelegramChatNotFoundError`

**To enable DMs:** have the user start a conversation with your bot by sending it `/start` first.

## Error taxonomy

| Class | When thrown | HTTP code | Retryable |
|---|---|---|---|
| `TelegramError` | Generic fallback | any | — |
| `TelegramAuthError` | Invalid bot token | 401 | No |
| `TelegramChatNotFoundError` | Chat not found, bot blocked by user | 400, 403 | No |
| `TelegramRateLimitError` | Rate limit exceeded (429) | 429 | No |
| `TelegramValidationError` | Bad payload, malformed parse_mode | 400 | No |
| `TelegramUnavailableError` | Server error (5xx) after retries | 5xx | No (already retried) |

All errors extend `PlatformError` from `@diabolicallabs/notifier-core`.

`TelegramRateLimitError` has two additional fields:
- `kind: 'exceeded' | 'unavailable'`
- `retryAfterMs: number | null` — milliseconds from the body field `parameters.retry_after` (**not** a header)

### Rate-limit behavior

Telegram's retry-after value comes from the **response body field** `parameters.retry_after` (in seconds), not from a `Retry-After` header. This is a Telegram-specific behavior. The package handles this correctly and surfaces it via `TelegramRateLimitError.retryAfterMs`.

## Rate limits

- **Global:** 30 messages/second per bot token
- **Per chat:** 1 message/second to the same chat
- **429 response:** `{ok: false, error_code: 429, parameters: {retry_after: N}}`

## Integration test (living example)

See `src/__tests__/integration/telegram.integration.test.ts`. Run with:

```bash
TELEGRAM_BOT_TOKEN=bot123:ABC TELEGRAM_TEST_CHAT_ID=123456 pnpm test:integration
```

CI skips this suite when env vars are absent.

## License

MIT — © Diabolical Labs
