/**
 * Type definitions for @diabolicallabs/slack.
 *
 * Imports shared contracts from @diabolicallabs/notifier-core.
 * Slack-specific types defined here.
 */

import type { Logger, Notifier, NotifyMessage, NotifyResult } from '@diabolicallabs/notifier-core';
import type { RateLimiter } from '@diabolicallabs/rate-limiter';
import type { KnownBlock } from '@slack/types';

// Re-export KnownBlock + Block types so consumers don't need @slack/types as a direct dep.
export type { Block, KnownBlock, RichTextBlock, SectionBlock } from '@slack/types';

// ─────────────────────────────────────────────
// Public config / args interfaces
// ─────────────────────────────────────────────

/**
 * Configuration for createSlackNotifier().
 *
 * At least one of `botToken` or `webhookUrl` must be provided.
 * `createSlackNotifierFromEnv()` throws SlackValidationError synchronously
 * when both are absent.
 */
export interface SlackNotifierConfig {
  botToken?: string; // xoxb-… — for chat.postMessage path
  webhookUrl?: string; // for incoming-webhook path
  defaultChannel?: string; // optional default used by postMessage if channel not specified
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 500
  capDelayMs?: number; // default: 2000
  timeoutMs?: number; // default: 10_000
  logger?: Logger; // from @diabolicallabs/notifier-core
  rateLimiter?: RateLimiter; // optional — see §5.5 of brief-week6.md
}

/**
 * Arguments for chat.postMessage (bot-token path).
 */
export interface PostMessageArgs {
  channel: string; // channel ID or name (e.g. '#agent-fleet-health')
  text: string; // plain-text fallback — always required
  blocks?: ReadonlyArray<KnownBlock>; // optional Block Kit rich content
  threadTs?: string; // reply in thread
}

/**
 * Arguments for incoming webhook (webhookUrl path).
 * webhookUrl overrides config.webhookUrl for this specific call.
 */
export interface PostWebhookArgs {
  text: string;
  blocks?: ReadonlyArray<KnownBlock>;
  webhookUrl?: string; // overrides config.webhookUrl for this call
}

// ─────────────────────────────────────────────
// SlackNotifier interface
// ─────────────────────────────────────────────

/**
 * The Slack notifier interface. Extends the portable Notifier interface.
 *
 * `send()` routes automatically: postMessage when botToken is configured,
 * postWebhook when only webhookUrl is configured.
 *
 * Use `postMessage()` and `postWebhook()` directly for explicit routing.
 */
export interface SlackNotifier extends Notifier {
  send(message: NotifyMessage): Promise<NotifyResult>;
  postMessage(args: PostMessageArgs): Promise<NotifyResult>;
  postWebhook(args: PostWebhookArgs): Promise<NotifyResult>;
}

// ─────────────────────────────────────────────
// Error taxonomy
// ─────────────────────────────────────────────

import {
  PlatformAuthError,
  PlatformError,
  PlatformNotFoundError,
  PlatformRateLimitError,
  PlatformUnavailableError,
  PlatformValidationError,
} from '@diabolicallabs/notifier-core';

/**
 * Base Slack error — generic fallback for any Slack API error that doesn't
 * map to a more specific subclass.
 */
export class SlackError extends PlatformError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'slack', code, cause);
  }
}

/**
 * Authentication failure — invalid_auth, not_authed, token_revoked, account_inactive.
 * Never retryable.
 */
export class SlackAuthError extends PlatformAuthError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'slack', code, cause);
  }
}

/**
 * Channel not found — channel_not_found.
 * Non-retryable. Check the channel ID/name in the config.
 */
export class SlackChannelNotFoundError extends PlatformNotFoundError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'slack', code, cause);
  }
}

/**
 * Rate limit error — 429 after retries exhausted.
 *
 * kind: 'exceeded' — Slack returned 429; retryAfterMs from Retry-After header.
 * kind: 'unavailable' — rate-limiter peer-dep reported Redis broken (see §5.5).
 */
export class SlackRateLimitError extends PlatformRateLimitError {
  constructor(
    message: string,
    code: string,
    kind: 'exceeded' | 'unavailable',
    retryAfterMs: number | null,
    cause?: unknown
  ) {
    super(message, 'slack', code, kind, retryAfterMs, cause);
  }
}

/**
 * Validation error — invalid_arguments, missing_text_or_fallback_or_attachments,
 * malformed payload. Also thrown synchronously by createSlackNotifierFromEnv()
 * when both botToken and webhookUrl are absent.
 */
export class SlackValidationError extends PlatformValidationError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'slack', code, cause);
  }
}

/**
 * Slack API unavailable — 5xx after retries exhausted.
 */
export class SlackUnavailableError extends PlatformUnavailableError {
  constructor(message: string, code: string, cause?: unknown) {
    super(message, 'slack', code, cause);
  }
}
