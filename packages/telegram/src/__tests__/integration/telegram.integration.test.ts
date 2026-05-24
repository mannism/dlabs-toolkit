/**
 * Integration test for @diabolicallabs/telegram.
 *
 * Runs ONLY when TELEGRAM_BOT_TOKEN + TELEGRAM_TEST_CHAT_ID are set.
 * CI skips this suite automatically when the env vars are absent.
 *
 * Sable runs this locally before merging, against a Sable-created test chat.
 * Test messages are deleted after the run if possible (Telegram allows bot
 * to delete own messages within 48h via deleteMessage API).
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=bot123:ABC TELEGRAM_TEST_CHAT_ID=123456 \
 *     pnpm test:integration --filter @diabolicallabs/telegram
 */

import { describe, expect, it } from 'vitest';
import { createTelegramNotifier } from '../../client.js';

const BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
const TEST_CHAT_ID = process.env['TELEGRAM_TEST_CHAT_ID'];

const RUN =
  BOT_TOKEN !== undefined && BOT_TOKEN !== '' && TEST_CHAT_ID !== undefined && TEST_CHAT_ID !== '';

describe.skipIf(!RUN)('@diabolicallabs/telegram — integration (real Telegram API)', () => {
  it('sendMessage sends a message and returns a NotifyResult', async () => {
    const notifier = createTelegramNotifier({
      botToken: BOT_TOKEN as string,
      maxRetries: 1,
    });

    const result = await notifier.sendMessage({
      chatId: TEST_CHAT_ID as string,
      text: `[dlabs-toolkit Wave 6 integration smoke] ${new Date().toISOString()}`,
    });

    expect(result.platform).toBe('telegram');
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });
});
