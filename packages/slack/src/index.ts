/**
 * @diabolicallabs/slack
 *
 * Send-only Slack notifier built on @slack/web-api (v7.x).
 * Supports chat.postMessage (bot-token path) and incoming webhooks.
 *
 * Features:
 *   - Named error taxonomy (SlackAuthError, SlackChannelNotFoundError, etc.)
 *   - Retry with full-jitter exponential backoff (via retryWithJitter from notifier-core)
 *   - Optional @diabolicallabs/rate-limiter peer-dep for proactive tier-1 gating
 *   - Secrets safety: token and webhook URL never logged
 *   - Pluggable logger (setSlackLogger)
 *   - Block Kit type re-exports (KnownBlock, SectionBlock, etc.)
 *
 * @example
 * import { createSlackNotifierFromEnv } from '@diabolicallabs/slack';
 * const slack = createSlackNotifierFromEnv();
 * await slack.postMessage({ channel: '#alerts', text: 'Deploy complete' });
 */

// Factory functions
export { createSlackNotifier, createSlackNotifierFromEnv } from './client.js';

// Logger
export { setSlackLogger } from './logger.js';

// Types
export type {
  Block,
  KnownBlock,
  PostMessageArgs,
  PostWebhookArgs,
  RichTextBlock,
  SectionBlock,
  SlackNotifier,
  SlackNotifierConfig,
} from './types.js';

// Error classes — exported as values for instanceof checks
export {
  SlackAuthError,
  SlackChannelNotFoundError,
  SlackError,
  SlackRateLimitError,
  SlackUnavailableError,
  SlackValidationError,
} from './types.js';
