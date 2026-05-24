---
"@diabolicallabs/telegram": major
---

First release; Wave 6 notifier family v1.0.0 stable interface.

Ships `createTelegramNotifier` + `createTelegramNotifierFromEnv` factory functions, `TelegramNotifier` interface (extends portable `Notifier`), `sendMessage` via native `fetch` against `api.telegram.org` (no SDK dep — no grammY, no telegraf), full named error taxonomy (`TelegramError`, `TelegramAuthError`, `TelegramChatNotFoundError`, `TelegramRateLimitError`, `TelegramValidationError`, `TelegramUnavailableError`), `retry_after` from response body field `parameters.retry_after` (not a header), `escapeMarkdownV2` helper, `InlineKeyboardMarkup` type, and pluggable logger.
