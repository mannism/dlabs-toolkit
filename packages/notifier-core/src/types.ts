/**
 * Core type definitions for @diabolicallabs/notifier-core.
 *
 * This is the shared contract consumed by every platform notifier package
 * (@diabolicallabs/slack, @diabolicallabs/telegram, and any future additions).
 * Zero runtime dependencies — types and error classes only.
 */

// ─────────────────────────────────────────────
// Notifier interface
// ─────────────────────────────────────────────

/**
 * A message to send. The `to` field is platform-specific:
 *   - Slack: channel ID or name (e.g. '#agent-fleet-health')
 *   - Telegram: chat_id (string for usernames, number for numeric IDs)
 *
 * `text` is always required — it serves as the plain-text fallback when the
 * platform renders rich content. `rich` carries platform-native content
 * (Block Kit for Slack, InlineKeyboardMarkup for Telegram) and is opaque
 * at the core layer to avoid coupling.
 */
export interface NotifyMessage {
  to: string; // platform-specific recipient identifier
  text: string; // plain-text fallback — always required
  rich?: unknown; // platform-native rich content; opaque at core layer
}

/**
 * The result returned by a successful send. Platform packages populate all
 * three fields on every successful call, so callers can log delivery details.
 */
export interface NotifyResult {
  platform: string; // e.g. 'slack', 'telegram'
  messageId: string; // platform-assigned message identifier
  deliveredAt: Date; // when the send resolved
}

/**
 * The portable notifier interface — what platform packages implement.
 * Callers that want portability program against Notifier. Callers that
 * want platform-specific features (Block Kit, InlineKeyboard) import the
 * platform's extended interface.
 */
export interface Notifier {
  send(message: NotifyMessage): Promise<NotifyResult>;
}

// ─────────────────────────────────────────────
// Logger interface
// ─────────────────────────────────────────────

/**
 * Pluggable logger interface — matches the toolkit-wide convention established
 * in @diabolicallabs/llm-pricing, @diabolicallabs/llm-client, @diabolicallabs/notion,
 * and @diabolicallabs/rate-limiter. Notifier packages import from here instead of
 * copy-pasting the interface.
 *
 * Default behavior in each package: structured JSON to stdout (Railway-friendly).
 * Override to route through your application logger (pino, winston, Datadog, etc.).
 */
export interface Logger {
  warn: (event: string, data: Record<string, unknown>) => void;
}

// ─────────────────────────────────────────────
// PlatformError taxonomy
// ─────────────────────────────────────────────

/**
 * Base class for all platform-specific errors. Every named error in the
 * @diabolicallabs/slack and @diabolicallabs/telegram packages extends this.
 *
 * `.platform` — identifies the originating platform ('slack', 'telegram').
 * `.code`     — machine-readable platform-native error code where available
 *               (Slack's `error` field, Telegram's `error_code` stringified).
 *               Use 'unknown' when the platform provides no code.
 */
export class PlatformError extends Error {
  readonly platform: string;
  readonly code: string;

  constructor(message: string, platform: string, code: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.platform = platform;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * 401/403-shaped errors — invalid token, revoked credentials, insufficient
 * permissions. Never retryable.
 *
 * Slack: invalid_auth, not_authed, token_revoked, account_inactive
 * Telegram: 401 Unauthorized
 */
export class PlatformAuthError extends PlatformError {}

/**
 * Channel/chat not found — the target recipient does not exist or the bot
 * has been blocked by the user. Non-retryable.
 *
 * Slack: channel_not_found
 * Telegram: 400 chat not found, 403 Forbidden: bot was blocked by the user
 */
export class PlatformNotFoundError extends PlatformError {}

/**
 * Rate limit error — thrown after retries are exhausted following a 429.
 *
 * `kind` discriminator mirrors RateLimitError.kind from @diabolicallabs/rate-limiter:
 *   'exceeded'    — legitimate platform rate limit. Map to HTTP 429.
 *   'unavailable' — infrastructure broken (Redis down, proactive limiter failed).
 *                   Map to HTTP 503 — the request may not actually be rate-limited.
 *
 * `retryAfterMs` — how long to wait before retrying, in milliseconds.
 *   Sourced from the platform response (Retry-After header for Slack,
 *   parameters.retry_after body field for Telegram). null when unavailable.
 */
export class PlatformRateLimitError extends PlatformError {
  readonly kind: 'exceeded' | 'unavailable';
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    platform: string,
    code: string,
    kind: 'exceeded' | 'unavailable',
    retryAfterMs: number | null,
    cause?: unknown
  ) {
    super(message, platform, code, cause);
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Validation error — bad payload, missing required field, malformed parse_mode.
 * Non-retryable. Also thrown synchronously by factory functions when required
 * config (bot token, webhook URL) is absent.
 *
 * Slack: invalid_arguments, missing_text_or_fallback_or_attachments
 * Telegram: 400 Bad Request family
 */
export class PlatformValidationError extends PlatformError {}

/**
 * Platform unavailable — 5xx after retries exhausted. Likely a transient
 * outage on the platform's side.
 */
export class PlatformUnavailableError extends PlatformError {}
