/**
 * Unit tests for PostgresPromptStorageAdapter against a mock PgPoolLike —
 * verifies query shape (parameterized, no interpolation), transaction
 * sequencing, and error-code mapping. The real-Postgres round-trip is
 * covered by src/__tests__/integration/postgres.test.ts (gated by
 * DATABASE_URL, requires docker — see vitest.integration.config.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PromptNotFoundError,
  PromptStorageError,
  PromptVersionConflictError,
} from '../../errors.js';
import type { PgClientLike, PgPoolLike } from '../../postgres-adapter.js';
import { PostgresPromptStorageAdapter } from '../../postgres-adapter.js';

interface FakeRow {
  id: number;
  prompt_name: string;
  prompt_type: string;
  version: number;
  content: string;
  is_active: boolean;
  activated_on: Date | null;
  created_by: string | null;
  change_notes: string | null;
  created_on: Date;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 1,
    prompt_name: 'p',
    prompt_type: 'system',
    version: 1,
    content: 'hello',
    is_active: true,
    activated_on: new Date(),
    created_by: null,
    change_notes: null,
    created_on: new Date(),
    ...overrides,
  };
}

describe('PostgresPromptStorageAdapter', () => {
  let poolQuery: ReturnType<typeof vi.fn>;
  let clientQuery: ReturnType<typeof vi.fn>;
  let clientRelease: ReturnType<typeof vi.fn>;
  let pool: PgPoolLike;

  beforeEach(() => {
    poolQuery = vi.fn();
    clientQuery = vi.fn();
    clientRelease = vi.fn();

    const client: PgClientLike = {
      query: clientQuery as unknown as PgClientLike['query'],
      release: clientRelease as unknown as PgClientLike['release'],
    };

    pool = {
      query: poolQuery as unknown as PgPoolLike['query'],
      connect: vi.fn().mockResolvedValue(client),
    };
  });

  it('ensureSchema issues parameterless DDL statements only', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const adapter = new PostgresPromptStorageAdapter(pool);
    await adapter.ensureSchema();

    expect(poolQuery).toHaveBeenCalledTimes(3);
    for (const call of poolQuery.mock.calls) {
      expect(call[0]).toContain('CREATE');
      // No f-string interpolation markers should ever appear in query text.
      expect(call[0]).not.toMatch(/\$\{/);
    }
  });

  it('getMaxVersion uses a parameterized query and defaults to 0 when no rows exist', async () => {
    poolQuery.mockResolvedValue({ rows: [{ max_version: null }] });
    const adapter = new PostgresPromptStorageAdapter(pool);
    const result = await adapter.getMaxVersion('p', 'system');

    expect(result).toBe(0);
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('$1'), ['p', 'system']);
  });

  it('getVersion returns null when no row matches', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const adapter = new PostgresPromptStorageAdapter(pool);
    const result = await adapter.getVersion('p', 'system', 5);
    expect(result).toBeNull();
  });

  it('insertVersion runs BEGIN, INSERT, (deactivate siblings), COMMIT and releases the client', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [makeRow({ version: 2 })] }) // INSERT ... RETURNING
      .mockResolvedValueOnce({ rows: [] }) // UPDATE deactivate siblings
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const adapter = new PostgresPromptStorageAdapter(pool);
    const result = await adapter.insertVersion({
      name: 'p',
      type: 'system',
      version: 2,
      content: 'v2',
      isActive: true,
      createdBy: null,
      changeNotes: null,
    });

    expect(result.version).toBe(2);
    expect(clientQuery).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(clientQuery.mock.calls[1]?.[0]).toContain('INSERT INTO prompt_versions');
    expect(clientQuery.mock.calls[1]?.[0]).not.toMatch(/\$\{/);
    expect(clientQuery.mock.calls[2]?.[0]).toContain('UPDATE prompt_versions');
    expect(clientQuery).toHaveBeenNthCalledWith(4, 'COMMIT');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('insertVersion maps a unique-violation (23505) to PromptVersionConflictError and rolls back', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' })) // INSERT fails
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const adapter = new PostgresPromptStorageAdapter(pool);
    await expect(
      adapter.insertVersion({
        name: 'p',
        type: 'system',
        version: 2,
        content: 'v2',
        isActive: true,
        createdBy: null,
        changeNotes: null,
      })
    ).rejects.toBeInstanceOf(PromptVersionConflictError);

    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('insertVersion wraps an unexpected DB error as PromptStorageError', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error('connection reset')) // INSERT fails
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const adapter = new PostgresPromptStorageAdapter(pool);
    await expect(
      adapter.insertVersion({
        name: 'p',
        type: 'system',
        version: 1,
        content: 'v1',
        isActive: true,
        createdBy: null,
        changeNotes: null,
      })
    ).rejects.toBeInstanceOf(PromptStorageError);
  });

  it('activateVersion throws PromptNotFoundError and rolls back when the target version is missing', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // SELECT ... FOR UPDATE -> no row
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    const adapter = new PostgresPromptStorageAdapter(pool);
    await expect(adapter.activateVersion('p', 'system', 99)).rejects.toBeInstanceOf(
      PromptNotFoundError
    );
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('activateVersion runs SELECT FOR UPDATE, deactivate, activate, COMMIT in order', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [makeRow({ version: 1, is_active: false })] }) // SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [] }) // deactivate siblings
      .mockResolvedValueOnce({ rows: [makeRow({ version: 1, is_active: true })] }) // activate target
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const adapter = new PostgresPromptStorageAdapter(pool);
    const result = await adapter.activateVersion('p', 'system', 1);

    expect(result.isActive).toBe(true);
    expect(clientQuery.mock.calls[1]?.[0]).toContain('FOR UPDATE');
    expect(clientQuery.mock.calls[3]?.[0]).toContain('RETURNING *');
    expect(clientQuery).toHaveBeenNthCalledWith(5, 'COMMIT');
  });
});
