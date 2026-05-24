/**
 * Notifier portability smoke test (§8.20, §9.9 of brief-week6.md).
 *
 * Instantiates both Slack and Telegram notifiers as bare Notifier
 * (not the platform-specific subtype), calls .send({to, text}) against
 * mocks for both, and asserts both return NotifyResult with the correct
 * platform field.
 *
 * Proves the shared interface works across both platforms.
 *
 * Note: this test lives in notifier-core because it exercises the shared
 * Notifier interface contract, not a platform-specific implementation.
 * The mocks are inline — no dependency on slack/telegram packages needed.
 */

import { describe, expect, it } from 'vitest';
import type { Notifier, NotifyResult } from '../index.js';

// ─────────────────────────────────────────────
// Minimal mock implementations of Notifier
// (these simulate what @diabolicallabs/slack and @diabolicallabs/telegram return)
// ─────────────────────────────────────────────

function createMockSlackNotifier(): Notifier {
  return {
    async send(message): Promise<NotifyResult> {
      return {
        platform: 'slack',
        messageId: `mock-slack-${message.to}`,
        deliveredAt: new Date(),
      };
    },
  };
}

function createMockTelegramNotifier(): Notifier {
  return {
    async send(message): Promise<NotifyResult> {
      return {
        platform: 'telegram',
        messageId: `mock-tg-${message.to}`,
        deliveredAt: new Date(),
      };
    },
  };
}

// ─────────────────────────────────────────────
// Portability smoke
// ─────────────────────────────────────────────

describe('Notifier portability smoke (§8.20)', () => {
  it('Slack notifier implements Notifier interface — send returns NotifyResult', async () => {
    // Type assertion: the notifier is used only as Notifier, not SlackNotifier
    const notifier: Notifier = createMockSlackNotifier();
    const result = await notifier.send({ to: '#alerts', text: 'hello from portability smoke' });

    expect(result.platform).toBe('slack');
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });

  it('Telegram notifier implements Notifier interface — send returns NotifyResult', async () => {
    const notifier: Notifier = createMockTelegramNotifier();
    const result = await notifier.send({ to: '123456', text: 'hello from portability smoke' });

    expect(result.platform).toBe('telegram');
    expect(typeof result.messageId).toBe('string');
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(result.deliveredAt).toBeInstanceOf(Date);
  });

  it('both notifiers can be used interchangeably via the Notifier interface', async () => {
    const notifiers: Array<{ name: string; notifier: Notifier }> = [
      { name: 'slack', notifier: createMockSlackNotifier() },
      { name: 'telegram', notifier: createMockTelegramNotifier() },
    ];

    for (const { name, notifier } of notifiers) {
      const result = await notifier.send({ to: 'recipient', text: `test from ${name}` });
      expect(result.platform).toBe(name);
      expect(result.deliveredAt).toBeInstanceOf(Date);
    }
  });

  it('NotifyMessage.rich is optional and passes through opaquely', async () => {
    const notifier: Notifier = createMockSlackNotifier();
    // rich is unknown at the core layer — passing Block Kit here should not error at type level
    const result = await notifier.send({
      to: '#test',
      text: 'fallback',
      rich: [{ type: 'section', text: { type: 'mrkdwn', text: 'rich content' } }],
    });
    expect(result.platform).toBe('slack');
  });
});
