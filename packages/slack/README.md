# `@diabolicallabs/slack`

Send-only Slack notifier built on `@slack/web-api` v7. Supports `chat.postMessage` (bot-token path) and incoming webhooks.

## Install

```bash
pnpm add @diabolicallabs/slack
```

For proactive rate-limit gating (optional):

```bash
pnpm add @diabolicallabs/rate-limiter
```

## Usage

### From environment variables

```ts
import { createSlackNotifierFromEnv } from '@diabolicallabs/slack';

// Reads SLACK_BOT_TOKEN, SLACK_WEBHOOK_URL, SLACK_DEFAULT_CHANNEL
const slack = createSlackNotifierFromEnv();
await slack.postMessage({ channel: '#alerts', text: 'Deploy complete' });
```

### Explicit config

```ts
import { createSlackNotifier } from '@diabolicallabs/slack';

const slack = createSlackNotifier({
  botToken: process.env.SLACK_BOT_TOKEN,
  defaultChannel: '#agent-fleet-health',
  maxRetries: 3,
  timeoutMs: 10_000,
});

await slack.postMessage({
  channel: '#alerts',
  text: 'Fallback text for notifications',
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Deploy complete* — GEOAudit v2.1.0 is live.' },
    },
  ],
});
```

### Incoming webhook

```ts
const slack = createSlackNotifier({
  webhookUrl: process.env.SLACK_WEBHOOK_URL,
});

await slack.postWebhook({ text: 'Fleet health check passed' });
```

### Portable interface

```ts
import type { Notifier } from '@diabolicallabs/notifier-core';
import { createSlackNotifierFromEnv } from '@diabolicallabs/slack';

const notifier: Notifier = createSlackNotifierFromEnv();
await notifier.send({ to: '#alerts', text: 'hello' });
```

### With rate-limiter (optional peer-dep)

```ts
import { createSlackNotifier } from '@diabolicallabs/slack';
import { createRateLimiter } from '@diabolicallabs/rate-limiter';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const rateLimiter = createRateLimiter({
  redis,
  windowMs: 1_000,
  maxRequests: 1,
});

const slack = createSlackNotifier({
  botToken: process.env.SLACK_BOT_TOKEN,
  rateLimiter,
});
```

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `botToken` | `string` | — | Slack bot token (`xoxb-…`). Required for `postMessage`. |
| `webhookUrl` | `string` | — | Incoming webhook URL. Required for `postWebhook`. |
| `defaultChannel` | `string` | — | Default channel for `postMessage` when none specified. |
| `maxRetries` | `number` | `3` | Max retry attempts on transient failures. |
| `baseDelayMs` | `number` | `500` | Base delay for exponential backoff (ms). |
| `capDelayMs` | `number` | `2000` | Maximum delay cap for backoff (ms). |
| `timeoutMs` | `number` | `10000` | Per-request timeout (ms). |
| `logger` | `Logger` | stdout JSON | Pluggable logger. |
| `rateLimiter` | `RateLimiter` | — | Optional — proactive per-channel rate-limit gating. |

At least one of `botToken` or `webhookUrl` must be provided. `createSlackNotifierFromEnv()` throws `SlackValidationError` synchronously when both are absent.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | If using `postMessage` | Bot token from your Slack app. |
| `SLACK_WEBHOOK_URL` | If using `postWebhook` | Incoming webhook URL. |
| `SLACK_DEFAULT_CHANNEL` | No | Default channel for `postMessage`. |

## Error taxonomy

| Class | When thrown | Retryable |
|---|---|---|
| `SlackError` | Generic fallback | — |
| `SlackAuthError` | `invalid_auth`, `not_authed`, `token_revoked`, `account_inactive` | No |
| `SlackChannelNotFoundError` | `channel_not_found` | No |
| `SlackRateLimitError` | 429 after retries exhausted | No |
| `SlackValidationError` | `invalid_arguments`, missing payload, or missing credentials | No |
| `SlackUnavailableError` | 5xx after retries exhausted | No (already retried) |

All errors extend `PlatformError` from `@diabolicallabs/notifier-core`.

`SlackRateLimitError` has two additional fields:
- `kind: 'exceeded' | 'unavailable'` — `'exceeded'` = real 429; `'unavailable'` = Redis broken in the rate-limiter peer-dep
- `retryAfterMs: number | null` — milliseconds from the `Retry-After` header

## Rate-limit handling

Two layers:

1. **Proactive (optional)**: if `config.rateLimiter` is provided, calls `check('slack:channel:{channel}')` before each `postMessage`. Throws `SlackRateLimitError` immediately if over limit, without hitting Slack.

2. **Reactive**: `Retry-After` header value from Slack 429 responses is respected and propagated to `SlackRateLimitError.retryAfterMs`.

If the rate-limiter peer-dep throws (Redis down), the notifier logs `SLACK_RATELIMITER_UNAVAILABLE` and sends anyway — Slack's own 429 protection is the safety net.

## Integration test (living example)

See `src/__tests__/integration/slack.integration.test.ts`. Run with:

```bash
SLACK_BOT_TOKEN=xoxb-... SLACK_TEST_CHANNEL=#wave6-test pnpm test:integration
```

CI skips this suite when env vars are absent.

## License

MIT — © Diabolical Labs
