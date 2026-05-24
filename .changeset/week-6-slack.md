---
"@diabolicallabs/slack": major
---

First release; Wave 6 notifier family v1.0.0 stable interface.

Ships `createSlackNotifier` + `createSlackNotifierFromEnv` factory functions, `SlackNotifier` interface (extends portable `Notifier`), `postMessage` (bot-token path via `@slack/web-api`) + `postWebhook` (incoming webhook via `fetch`), full named error taxonomy (`SlackError`, `SlackAuthError`, `SlackChannelNotFoundError`, `SlackRateLimitError`, `SlackValidationError`, `SlackUnavailableError`), retry with full-jitter exponential backoff, optional `@diabolicallabs/rate-limiter` peer-dep for proactive tier-1 gating, Block Kit type re-exports, and pluggable logger.
