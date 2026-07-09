import { beforeEach, describe, expect, it } from 'vitest';
import { PromptNotFoundError, PromptValidationError } from '../../errors.js';
import type { PromptRegistry } from '../../registry.js';
import { createPromptRegistry } from '../../registry.js';
import { InMemoryPromptStorageAdapter } from '../fixtures/in-memory-adapter.js';

describe('createPromptRegistry — lifecycle', () => {
  let registry: PromptRegistry;

  beforeEach(() => {
    registry = createPromptRegistry({ adapter: new InMemoryPromptStorageAdapter() });
  });

  describe('seed()', () => {
    it('inserts v1 active for a new name/type', async () => {
      const results = await registry.seed([
        { name: 'onboarding', type: 'system', content: 'Hello.' },
      ]);
      expect(results).toEqual([
        { name: 'onboarding', type: 'system', status: 'seeded', version: 1 },
      ]);

      const record = await registry.get('onboarding', { type: 'system' });
      expect(record.version).toBe(1);
      expect(record.isActive).toBe(true);
      expect(record.content).toBe('Hello.');
    });

    it('is idempotent — re-running seed() on an already-seeded name skips it', async () => {
      await registry.seed([{ name: 'onboarding', content: 'v1 text' }]);
      const second = await registry.seed([
        { name: 'onboarding', content: 'DIFFERENT TEXT — should be ignored' },
      ]);

      expect(second).toEqual([
        { name: 'onboarding', type: 'system', status: 'skipped_existing', version: 1 },
      ]);
      const record = await registry.get('onboarding');
      expect(record.content).toBe('v1 text'); // untouched
    });

    it('defaults type to "system" when omitted', async () => {
      await registry.seed([{ name: 'x', content: 'text' }]);
      const record = await registry.get('x');
      expect(record.type).toBe('system');
    });

    it('rejects an empty content body', async () => {
      await expect(registry.seed([{ name: 'x', content: '' }])).rejects.toBeInstanceOf(
        PromptValidationError
      );
    });

    it('rejects an invalid name (disallowed characters)', async () => {
      await expect(registry.seed([{ name: 'has spaces', content: 'text' }])).rejects.toBeInstanceOf(
        PromptValidationError
      );
    });
  });

  describe('get()', () => {
    it('throws PromptNotFoundError for an unknown name', async () => {
      await expect(registry.get('does-not-exist')).rejects.toBeInstanceOf(PromptNotFoundError);
    });

    it('version: "latest" and omitted both return the active version', async () => {
      await registry.seed([{ name: 'p', content: 'v1' }]);
      await registry.publish('p', 'v2', {});

      const omitted = await registry.get('p');
      const latest = await registry.get('p', { version: 'latest' });
      expect(omitted.version).toBe(2);
      expect(latest.version).toBe(2);
    });

    it('a specific version number returns that version regardless of active state', async () => {
      await registry.seed([{ name: 'p', content: 'v1' }]);
      await registry.publish('p', 'v2 text');

      const v1 = await registry.get('p', { version: 1 });
      expect(v1.content).toBe('v1');
      expect(v1.isActive).toBe(false);
    });
  });

  describe('publish()', () => {
    it('creates a new version and never overwrites the previous one', async () => {
      await registry.seed([{ name: 'p', content: 'v1 text' }]);
      const v2 = await registry.publish('p', 'v2 text', {
        createdBy: 'diana',
        changeNotes: 'tone pass',
      });

      expect(v2.version).toBe(2);
      expect(v2.isActive).toBe(true);
      expect(v2.createdBy).toBe('diana');

      const v1 = await registry.get('p', { version: 1 });
      expect(v1.content).toBe('v1 text'); // untouched
      expect(v1.isActive).toBe(false); // deactivated in favor of v2
    });

    it('works on a name with no prior seed — publish can originate a prompt', async () => {
      const v1 = await registry.publish('brand-new', 'first content ever');
      expect(v1.version).toBe(1);
      expect(v1.isActive).toBe(true);
    });

    it('rejects oversized content', async () => {
      const huge = 'x'.repeat(200_001);
      await expect(registry.publish('p', huge)).rejects.toBeInstanceOf(PromptValidationError);
    });
  });

  describe('history()', () => {
    it('returns all versions newest-first', async () => {
      await registry.seed([{ name: 'p', content: 'v1' }]);
      await registry.publish('p', 'v2');
      await registry.publish('p', 'v3');

      const history = await registry.history('p');
      expect(history.map((r) => r.version)).toEqual([3, 2, 1]);
    });

    it('returns an empty array for a name that was never seeded or published', async () => {
      const history = await registry.history('never-existed');
      expect(history).toEqual([]);
    });
  });

  describe('rollback()', () => {
    it('re-activates a prior version without creating a new row', async () => {
      await registry.seed([{ name: 'p', content: 'v1 text' }]);
      await registry.publish('p', 'v2 text');
      await registry.publish('p', 'v3 text');

      const rolledBack = await registry.rollback('p', 1);
      expect(rolledBack.version).toBe(1);
      expect(rolledBack.content).toBe('v1 text');
      expect(rolledBack.isActive).toBe(true);

      const history = await registry.history('p');
      expect(history).toHaveLength(3); // no new row created
      expect(history.filter((r) => r.isActive)).toHaveLength(1); // exactly one active

      const active = await registry.get('p');
      expect(active.version).toBe(1);
    });

    it('throws PromptNotFoundError for a version that does not exist', async () => {
      await registry.seed([{ name: 'p', content: 'v1' }]);
      await expect(registry.rollback('p', 99)).rejects.toBeInstanceOf(PromptNotFoundError);
    });
  });

  describe('full round-trip: seed -> get -> publish -> rollback', () => {
    it('exercises the complete admin-standard lifecycle', async () => {
      await registry.seed([{ name: 'rt', content: 'seeded text' }]);
      expect((await registry.get('rt')).content).toBe('seeded text');

      await registry.publish('rt', 'revised text', { createdBy: 'diana' });
      expect((await registry.get('rt')).content).toBe('revised text');

      const history = await registry.history('rt');
      expect(history.map((r) => r.version)).toEqual([2, 1]);

      const rolledBack = await registry.rollback('rt', 1);
      expect(rolledBack.content).toBe('seeded text');
      expect((await registry.get('rt')).content).toBe('seeded text');
    });
  });
});
