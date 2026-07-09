/**
 * Integration tests for @diabolicallabs/prompt-registry — real Postgres connection.
 *
 * Requires DATABASE_URL to be set. Skipped (not failed) when absent — matches
 * the @diabolicallabs/rate-limiter REDIS_URL-gated pattern.
 *
 * Run locally:
 *   docker run -d --rm --name prompt-registry-test-pg -p 5433:5432 \
 *     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=prompt_registry_test postgres:16-alpine
 *   DATABASE_URL=postgres://postgres:test@localhost:5433/prompt_registry_test \
 *     pnpm --filter @diabolicallabs/prompt-registry test:integration
 *   docker stop prompt-registry-test-pg
 *
 * Exercises the full acceptance-criterion round trip: seed -> get -> publish
 * -> rollback, against real transactions and the real UNIQUE constraint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgPoolLike } from '../../postgres-adapter.js';
import { PostgresPromptStorageAdapter } from '../../postgres-adapter.js';
import type { PromptRegistry } from '../../registry.js';
import { createPromptRegistry } from '../../registry.js';

// biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on process.env
const hasDatabase = process.env['DATABASE_URL'] !== undefined && process.env['DATABASE_URL'] !== '';

describe.skipIf(!hasDatabase)('@diabolicallabs/prompt-registry integration — real Postgres', () => {
  let pool: PgPoolLike & { end: () => Promise<void> };
  let registry: PromptRegistry;

  beforeAll(async () => {
    // Dynamic import so `pg` (a peerDependency) is not a hard dependency for
    // consumers who never run the integration suite.
    const { default: pg } = await import('pg');
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on process.env
    const realPool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
    pool = realPool as unknown as PgPoolLike & { end: () => Promise<void> };

    const adapter = new PostgresPromptStorageAdapter(pool);
    await adapter.ensureSchema();
    registry = createPromptRegistry({ adapter });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Isolate each test with a unique name prefix instead of truncating the
    // shared table — avoids cross-test interference without requiring
    // per-test transaction rollback plumbing.
  });

  function uniqueName(label: string): string {
    return `it-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }

  it('seed() -> get() round trip against real Postgres', async () => {
    const name = uniqueName('seed');
    await registry.seed([{ name, content: 'Real Postgres seed content.' }]);

    const record = await registry.get(name);
    expect(record.version).toBe(1);
    expect(record.isActive).toBe(true);
    expect(record.content).toBe('Real Postgres seed content.');
  });

  it('seed() is idempotent against real Postgres — second call is a no-op', async () => {
    const name = uniqueName('idempotent');
    await registry.seed([{ name, content: 'first' }]);
    const second = await registry.seed([{ name, content: 'second — should be ignored' }]);

    expect(second[0]?.status).toBe('skipped_existing');
    const record = await registry.get(name);
    expect(record.content).toBe('first');
  });

  it('publish() creates a new version, deactivates the old one, real UNIQUE constraint intact', async () => {
    const name = uniqueName('publish');
    await registry.seed([{ name, content: 'v1' }]);
    const v2 = await registry.publish(name, 'v2', { createdBy: 'integration-test' });

    expect(v2.version).toBe(2);
    const active = await registry.get(name);
    expect(active.version).toBe(2);
    expect(active.content).toBe('v2');

    const v1 = await registry.get(name, { version: 1 });
    expect(v1.isActive).toBe(false);
    expect(v1.content).toBe('v1'); // never overwritten
  });

  it('full seed -> get -> publish -> rollback round trip', async () => {
    const name = uniqueName('roundtrip');

    await registry.seed([{ name, content: 'seeded' }]);
    expect((await registry.get(name)).content).toBe('seeded');

    await registry.publish(name, 'revised');
    expect((await registry.get(name)).content).toBe('revised');

    const history = await registry.history(name);
    expect(history.map((r) => r.version)).toEqual([2, 1]);
    expect(history.filter((r) => r.isActive)).toHaveLength(1);

    const rolledBack = await registry.rollback(name, 1);
    expect(rolledBack.content).toBe('seeded');
    expect((await registry.get(name)).content).toBe('seeded');

    // Exactly one active row after rollback — the atomicity guarantee that
    // motivates the single-transaction activateVersion() implementation.
    const historyAfterRollback = await registry.history(name);
    expect(historyAfterRollback.filter((r) => r.isActive)).toHaveLength(1);
    expect(historyAfterRollback).toHaveLength(2); // rollback did not create a new row
  });

  it('concurrent publish() calls on the same name: one wins, the other retries cleanly', async () => {
    const name = uniqueName('race');
    await registry.seed([{ name, content: 'v1' }]);

    // Both racers read maxVersion=1 and attempt to insert version=2.
    // One succeeds; the other's insert hits the UNIQUE constraint and
    // surfaces as PromptVersionConflictError (not silent corruption).
    const results = await Promise.allSettled([
      registry.publish(name, 'race-a'),
      registry.publish(name, 'race-b'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // At least one must succeed; the table must never end up with two
    // active rows or a duplicate version number regardless of outcome.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    if (rejected.length > 0) {
      expect((rejected[0] as PromiseRejectedResult).reason?.code).toBe('version_conflict');
    }

    const history = await registry.history(name);
    const versionNumbers = history.map((r) => r.version);
    expect(new Set(versionNumbers).size).toBe(versionNumbers.length); // no duplicate versions
    expect(history.filter((r) => r.isActive).length).toBeLessThanOrEqual(1);
  });
});
