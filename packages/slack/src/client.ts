/**
 * Factory functions for SlackNotifier.
 *
 * createSlackNotifier(config) — builds from explicit config.
 * createSlackNotifierFromEnv(overrides?) — reads SLACK_BOT_TOKEN, SLACK_WEBHOOK_URL,
 *   SLACK_DEFAULT_CHANNEL; throws SlackValidationError synchronously when both
 *   token and webhook URL are absent.
 *
 * Implementation wraps @slack/web-api (v7.x). The SDK handles:
 *   - Authorization headers
 *   - TLS / keep-alive
 *
 * This wrapper adds:
 *   - Named error taxonomy (SlackAuthError, SlackChannelNotFoundError, etc.)
 *   - Retry with full-jitter exponential backoff (via retryWithJitter from notifier-core)
 *   - Optional @diabolicallabs/rate-limiter peer-dep integration (proactive gating)
 *   - Secrets safety: token and webhook URL never logged
 *   - Pluggable logger
 *
 * Secrets handling (§5.6 of brief-week6.md):
 *   - Authorization header stripped from all error context before logging
 *   - config.botToken and config.webhookUrl never appear in error messages or logs
 */

import type { NotifyResult } from '@diabolicallabs/notifier-core';
import { retryWithJitter } from '@diabolicallabs/notifier-core';
import type { ChatPostMessageArguments } from '@slack/web-api';
import { WebClient } from '@slack/web-api';
import { getLogger } from './logger.js';
import type {
  PostMessageArgs,
  PostWebhookArgs,
  SlackNotifier,
  SlackNotifierConfig,
} from './types.js';
import {
  SlackAuthError,
  SlackChannelNotFoundError,
  SlackError,
  SlackRateLimitError,
  SlackUnavailableError,
  SlackValidationError,
} from './types.js';

// ─────────────────────────────────────────────
// Error-mapping helpers
// ─────────────────────────────────────────────

/**
 * Slack auth-related error codes — map to SlackAuthError.
 */
const AUTH_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'account_inactive',
  'token_expired',
  'no_permission',
  'missing_scope',
]);

/**
 * Slack validation-related error codes — map to SlackValidationError.
 */
const VALIDATION_CODES = new Set([
  'invalid_arguments',
  'missing_text_or_fallback_or_attachments',
  'invalid_payload',
  'no_text',
  'too_many_attachments',
]);

/**
 * Map a @slack/web-api error (or any other thrown value) to the named error taxonomy.
 * Never includes the bot token or webhook URL in the resulting error message.
 * Exported for unit testing without requiring WebClient mock.
 */
export function mapSdkError(err: unknown): SlackError {
  // @slack/web-api WebAPICallError shape
  if (err !== null && typeof err === 'object' && 'data' in err) {
    const sdkErr = err as {
      data?: { error?: string };
      code?: string;
      statusCode?: number;
    };
    const slackCode = sdkErr.data?.error ?? sdkErr.code ?? 'unknown';
    const statusCode = sdkErr.statusCode ?? 0;

    if (AUTH_CODES.has(slackCode) || statusCode === 401 || statusCode === 403) {
      return new SlackAuthError(`Slack authentication failed: ${slackCode}`, slackCode, err);
    }

    if (slackCode === 'channel_not_found') {
      return new SlackChannelNotFoundError(`Slack channel not found: ${slackCode}`, slackCode, err);
    }

    if (VALIDATION_CODES.has(slackCode)) {
      return new SlackValidationError(`Slack validation error: ${slackCode}`, slackCode, err);
    }

    if (statusCode === 429 || slackCode === 'ratelimited') {
      // retryAfterMs will be set by the caller after SDK retry exhaustion
      return new SlackRateLimitError(
        `Slack rate limit exceeded: ${slackCode}`,
        slackCode,
        'exceeded',
        null,
        err
      );
    }

    if (statusCode >= 500 || slackCode === 'service_unavailable' || slackCode === 'fatal_error') {
      return new SlackUnavailableError(`Slack service unavailable: ${slackCode}`, slackCode, err);
    }

    return new SlackError(`Slack API error: ${slackCode}`, slackCode, err);
  }

  // Network errors or unknown shapes
  const message = err instanceof Error ? err.message : String(err);
  return new SlackError(`Slack request failed: ${message}`, 'unknown', err);
}

/**
 * Extract retry-after seconds from a Slack 429 error.
 * The @slack/web-api SDK exposes retryAfter (seconds) on the error object
 * when Retry-After header is present.
 * Exported for unit testing.
 */
export function extractRetryAfterMs(err: unknown): number | null {
  if (err !== null && typeof err === 'object' && 'retryAfter' in err) {
    const val = (err as { retryAfter?: unknown }).retryAfter;
    if (typeof val === 'number' && val > 0) {
      return val * 1_000;
    }
  }
  return null;
}

/**
 * Determine whether an error from the Slack SDK is retryable.
 * Auth, validation, and not-found errors are not retryable.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof SlackAuthError) return false;
  if (err instanceof SlackChannelNotFoundError) return false;
  if (err instanceof SlackValidationError) return false;
  // Rate limits — the SDK handles initial 429 retries; if it surfaces here, stop.
  if (err instanceof SlackRateLimitError) return false;
  return true;
}

// ─────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────

/**
 * Create a SlackNotifier with explicit config.
 *
 * @param config - SlackNotifierConfig; botToken is never logged.
 */
export function createSlackNotifier(config: SlackNotifierConfig): SlackNotifier {
  const {
    botToken,
    webhookUrl: configWebhookUrl,
    defaultChannel,
    maxRetries = 3,
    baseDelayMs = 500,
    capDelayMs = 2_000,
    timeoutMs = 10_000,
    logger: configLogger,
    rateLimiter,
  } = config;

  // Validate: at least one transport must be configured
  if (
    (botToken === undefined || botToken === '') &&
    (configWebhookUrl === undefined || configWebhookUrl === '')
  ) {
    throw new SlackValidationError(
      'SlackNotifier requires at least one of botToken or webhookUrl. ' +
        'Set SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL.',
      'missing_credentials'
    );
  }

  const log = configLogger ?? getLogger();

  // Only create WebClient if we have a bot token
  const webClient =
    botToken !== undefined && botToken !== ''
      ? new WebClient(botToken, { timeout: timeoutMs })
      : null;

  // ─── postMessage ───────────────────────────────────

  async function postMessage(args: PostMessageArgs): Promise<NotifyResult> {
    const channel = args.channel;

    if (webClient === null) {
      throw new SlackValidationError(
        'postMessage requires a botToken. Configure botToken or use postWebhook instead.',
        'missing_bot_token'
      );
    }

    // Proactive rate-limit check (optional peer-dep)
    if (rateLimiter !== undefined) {
      try {
        const result = await rateLimiter.check(`slack:channel:${channel}`);
        if (!result.allowed) {
          throw new SlackRateLimitError(
            `Proactive rate limit for channel ${channel}`,
            'rate_limited',
            'exceeded',
            result.resetMs
          );
        }
      } catch (err) {
        // If the limiter itself is broken (Redis down), log and proceed — Slack's
        // own 429 protection is the safety net (§5.5 of brief).
        if (err instanceof SlackRateLimitError) throw err;
        log.warn('SLACK_RATELIMITER_UNAVAILABLE', {
          channel,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return retryWithJitter(
      async () => {
        try {
          const callArgs: ChatPostMessageArguments = {
            channel,
            text: args.text,
            ...(args.blocks !== undefined && { blocks: [...args.blocks] }),
            ...(args.threadTs !== undefined && { thread_ts: args.threadTs }),
          };
          const response = await webClient.chat.postMessage(callArgs);

          const messageId = response.ts ?? '';
          log.warn('SLACK_POST_MESSAGE_OK', { channel, messageId });
          return {
            platform: 'slack',
            messageId,
            deliveredAt: new Date(),
          } satisfies NotifyResult;
        } catch (err) {
          const mapped = mapSdkError(err);
          // Enrich rate-limit error with Retry-After if available
          if (mapped instanceof SlackRateLimitError) {
            const retryAfterMs = extractRetryAfterMs(err);
            const msg: string = mapped.message;
            const code: string = mapped.code;
            throw new SlackRateLimitError(msg, code, 'exceeded', retryAfterMs, err);
          }
          throw mapped;
        }
      },
      {
        maxRetries,
        baseDelayMs,
        capDelayMs,
        isRetryable,
        onRetry: (retryErr: unknown, attempt: number, delayMs: number) => {
          log.warn('SLACK_RETRY', {
            channel,
            attempt,
            delayMs: Math.round(delayMs),
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        },
      }
    );
  }

  // ─── postWebhook ───────────────────────────────────

  async function postWebhook(args: PostWebhookArgs): Promise<NotifyResult> {
    const url = args.webhookUrl ?? configWebhookUrl;

    if (url === undefined || url === '') {
      throw new SlackValidationError(
        'postWebhook requires a webhookUrl. Configure webhookUrl or pass it per-call.',
        'missing_webhook_url'
      );
    }

    // Never log the webhook URL (secret-equivalent)
    return retryWithJitter(
      async () => {
        let response: Response;
        try {
          const body: Record<string, unknown> = { text: args.text };
          if (args.blocks !== undefined) body['blocks'] = args.blocks;

          response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new SlackError(`Slack webhook fetch failed: ${message}`, 'network_error', err);
        }

        if (response.status === 429) {
          const retryAfterRaw = response.headers.get('Retry-After');
          const retryAfterMs = retryAfterRaw !== null ? Number(retryAfterRaw) * 1_000 : null;
          throw new SlackRateLimitError(
            'Slack webhook rate limited (429)',
            'ratelimited',
            'exceeded',
            retryAfterMs
          );
        }

        if (response.status === 401 || response.status === 403) {
          throw new SlackAuthError(
            `Slack webhook authentication failed (${response.status})`,
            String(response.status)
          );
        }

        if (response.status >= 500) {
          throw new SlackUnavailableError(
            `Slack webhook unavailable (${response.status})`,
            String(response.status)
          );
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new SlackError(
            `Slack webhook error (${response.status}): ${body}`,
            String(response.status)
          );
        }

        // Slack webhooks return 'ok' as the body on success — no message ID available
        log.warn('SLACK_POST_WEBHOOK_OK', { status: response.status });
        return {
          platform: 'slack',
          messageId: `webhook-${Date.now()}`,
          deliveredAt: new Date(),
        } satisfies NotifyResult;
      },
      {
        maxRetries,
        baseDelayMs,
        capDelayMs,
        isRetryable: (webhookErr: unknown) => {
          if (webhookErr instanceof SlackAuthError) return false;
          if (webhookErr instanceof SlackValidationError) return false;
          if (webhookErr instanceof SlackRateLimitError) return false;
          return true;
        },
        onRetry: (retryErr: unknown, attempt: number, delayMs: number) => {
          log.warn('SLACK_RETRY', {
            path: 'webhook',
            attempt,
            delayMs: Math.round(delayMs),
            error: retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
        },
      }
    );
  }

  // ─── send (Notifier interface) ─────────────────────

  return {
    postMessage,
    postWebhook,

    async send(message) {
      // Route: postMessage when botToken is configured; postWebhook otherwise
      if (webClient !== null) {
        const channel = message.to || defaultChannel;
        if (channel === undefined || channel === '') {
          throw new SlackValidationError(
            'send() requires message.to (channel) or config.defaultChannel to be set.',
            'missing_channel'
          );
        }
        return postMessage({ channel, text: message.text });
      }
      return postWebhook({ text: message.text });
    },
  };
}

/**
 * Create a SlackNotifier from environment variables.
 *
 * Reads:
 *   SLACK_BOT_TOKEN       — bot token for chat.postMessage
 *   SLACK_WEBHOOK_URL     — incoming webhook URL
 *   SLACK_DEFAULT_CHANNEL — optional default channel for postMessage
 *
 * Throws SlackValidationError synchronously when both SLACK_BOT_TOKEN and
 * SLACK_WEBHOOK_URL are absent.
 */
export function createSlackNotifierFromEnv(
  overrides?: Partial<Omit<SlackNotifierConfig, 'botToken' | 'webhookUrl' | 'defaultChannel'>>
): SlackNotifier {
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature in TS strict
  const botToken = process.env['SLACK_BOT_TOKEN'];
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature in TS strict
  const webhookUrl = process.env['SLACK_WEBHOOK_URL'];
  // biome-ignore lint/complexity/useLiteralKeys: noPropertyAccessFromIndexSignature in TS strict
  const defaultChannel = process.env['SLACK_DEFAULT_CHANNEL'];

  if (
    (botToken === undefined || botToken === '') &&
    (webhookUrl === undefined || webhookUrl === '')
  ) {
    throw new SlackValidationError(
      'Neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL is set. ' +
        'Set at least one to use the Slack notifier.',
      'missing_credentials'
    );
  }

  return createSlackNotifier({
    ...(botToken !== undefined && botToken !== '' ? { botToken } : {}),
    ...(webhookUrl !== undefined && webhookUrl !== '' ? { webhookUrl } : {}),
    ...(defaultChannel !== undefined && defaultChannel !== '' ? { defaultChannel } : {}),
    ...overrides,
  });
}
