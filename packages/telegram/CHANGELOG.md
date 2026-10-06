# @diabolicallabs/telegram

## 1.1.0

### Minor Changes

- 136601a: Raise `engines.node` to `>=22.12.0`; Node 20 (end of life April 2026) is no longer supported.

### Patch Changes

- Updated dependencies [136601a]
  - @diabolicallabs/notifier-core@1.1.0

## 1.0.0

### Major Changes

- 2bdcf96: First release; Wave 6 notifier family v1.0.0 stable interface.

  Ships `createTelegramNotifier` + `createTelegramNotifierFromEnv` factory functions, `TelegramNotifier` interface (extends portable `Notifier`), `sendMessage` via native `fetch` against `api.telegram.org` (no SDK dep — no grammY, no telegraf), full named error taxonomy (`TelegramError`, `TelegramAuthError`, `TelegramChatNotFoundError`, `TelegramRateLimitError`, `TelegramValidationError`, `TelegramUnavailableError`), `retry_after` from response body field `parameters.retry_after` (not a header), `escapeMarkdownV2` helper, `InlineKeyboardMarkup` type, and pluggable logger.

### Patch Changes

- Updated dependencies [2bdcf96]
  - @diabolicallabs/notifier-core@1.0.0
