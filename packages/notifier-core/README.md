# `@diabolicallabs/notifier-core`

Shared interface, error taxonomy, Logger, and retry helper for the Diabolical Labs notifier package family.

Zero runtime dependencies — types, error classes, and a pure retry function only.

## Install

```bash
pnpm add @diabolicallabs/notifier-core
```

## Usage

### Portable notifier interface

```ts
import type { Notifier, NotifyMessage, NotifyResult } from '@diabolicallabs/notifier-core';

// Accept any platform notifier via the portable interface
function sendAlert(notifier: Notifier, channel: string, text: string): Promise<NotifyResult> {
  return notifier.send({ to: channel, text });
}
```

### Error handling

```ts
import {
  PlatformError,
  PlatformAuthError,
  PlatformRateLimitError,
  PlatformNotFoundError,
  PlatformValidationError,
  PlatformUnavailableError,
} from '@diabolicallabs/notifier-core';

try {
  await notifier.send({ to: 'my-channel', text: 'hello' });
} catch (err) {
  if (err instanceof PlatformRateLimitError) {
    console.log(`Rate limited. Kind: ${err.kind}, retry after: ${err.retryAfterMs}ms`);
  } else if (err instanceof PlatformAuthError) {
    console.error('Authentication failed — check your token');
  } else if (err instanceof PlatformError) {
    console.error(`Platform error on ${err.platform}: [${err.code}] ${err.message}`);
  }
}
```

### retryWithJitter helper

```ts
import { retryWithJitter, PlatformRateLimitError } from '@diabolicallabs/notifier-core';

const result = await retryWithJitter(
  () => fetch('https://api.example.com/send', { method: 'POST', body: '...' }),
  {
    maxRetries: 3,
    baseDelayMs: 250,
    capDelayMs: 2000,
    isRetryable: (err) => !(err instanceof PlatformAuthError),
    onRetry: (err, attempt, delayMs) =>
      logger.warn('SEND_RETRY', { attempt, delayMs }),
  },
);
```

### Pluggable logger

```ts
import type { Logger } from '@diabolicallabs/notifier-core';

const myLogger: Logger = {
  warn: (event, data) => pino.warn({ event, ...data }),
};
```

## Configuration

`notifier-core` has no configuration. It is a types + pure-function package.

## Error taxonomy

| Class | When thrown | Retryable |
|---|---|---|
| `PlatformError` | Base class — generic fallback | Depends on subclass |
| `PlatformAuthError` | Invalid or revoked credentials | No |
| `PlatformNotFoundError` | Channel/chat not found, bot blocked | No |
| `PlatformRateLimitError` | 429 after retries exhausted | No (retried internally; thrown when done) |
| `PlatformValidationError` | Bad payload, missing field | No |
| `PlatformUnavailableError` | 5xx after retries exhausted | Potentially (external) |

`PlatformRateLimitError` has two additional fields:
- `kind: 'exceeded' | 'unavailable'` — `'exceeded'` = real rate limit; `'unavailable'` = infrastructure broken
- `retryAfterMs: number | null` — milliseconds to wait before retrying

## Retry formula

Full-jitter exponential backoff (AWS recommendation):

```
delay = min(capDelayMs, baseDelayMs * 2^n) * random(0, 1)
```

Prevents thundering herd on concurrent failures.

## License

MIT — © Diabolical Labs
