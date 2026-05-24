/**
 * Integration test for @diabolicallabs/slack.
 *
 * Runs ONLY when SLACK_BOT_TOKEN + SLACK_TEST_CHANNEL are set.
 * CI skips this suite automatically when the env vars are absent.
 *
 * Sable runs this locally before merging, against a test channel created
 * for the Wave 6 integration smoke gate.
 *
 * Usage:
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_TEST_CHANNEL=#wave6-test \
 *     pnpm test:integration --filter @diabolicallabs/slack
 */

import { describe, expect, it } from 'vitest';
import { createSlackNotifier } from '../../client.js';

const BOT_TOKEN = process.env['SLACK_BOT_TOKEN'];
const TEST_CHANNEL = process.env['SLACK_TEST_CHANNEL'];

const RUN =
  BOT_TOKEN !== undefined && BOT_TOKEN !== '' && TEST_CHANNEL !== undefined && TEST_CHANNEL !== '';

describe.skipIf(!RUN)('@diabolicallabs/slack — integration (real Slack API)', () => {
  it('postMessage sends a message and returns a NotifyResult', async () => {
    const notifier = createSlackNotifier({
      botToken: BOT_TOKEN as string,
      maxRetries: 1,
    });

    const result = await notifier.postMessage({
      channel: TEST_CHANNEL as string,
      text: `[dlabs-toolkit Wave 6 integration smoke] ${new Date().toISOString()}`,
    });

    expect(result.platform).toBe('slack');
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });
});
