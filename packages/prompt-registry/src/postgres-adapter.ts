/**
 * PostgresPromptStorageAdapter — reference PromptStorageAdapter implementation.
 *
 * Structural interface, not a hard `pg` dependency: PgPoolLike mirrors the
 * subset of `pg.Pool` this adapter needs (query + connect). A real `pg.Pool`
 * instance satisfies it directly — same pattern as RedisExecutor in
 * @diabolicallabs/rate-limiter. `pg` is a peerDependency (optional): consumers
 * who already run Postgres (nearly every fleet product, via Drizzle or raw
 * `pg`) pass their existing pool; the registry never opens its own connection.
 *
 * ALL queries are parameterized ($1, $2, ...) — no string interpolation into
 * SQL anywhere in this file. Greppable invariant: `grep -n '\${' src/postgres-adapter.ts`
 * must return nothing outside of comments/log messages.
 */

import { PromptNotFoundError, PromptStorageError, PromptVersionConflictError } from './errors.js';
import type { InsertPromptVersionInput, PromptRecord, PromptStorageAdapter } from './types.js';

interface PgQueryResult<T> {
  rows: T[];
}

/** Structural subset of a `pg.Client` (or a `pg.PoolClient` checked out via `pool.connect()`). */
export interface PgClientLike {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  release(err?: Error | boolean): void;
}

/** Structural subset of `pg.Pool` — the only surface this adapter calls. */
export interface PgPoolLike {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<PgQueryResult<T>>;
  connect(): Promise<PgClientLike>;
}

interface PromptVersionRow {
  id: string | number;
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

function rowToRecord(row: PromptVersionRow): PromptRecord {
  return {
    id: row.id,
    name: row.prompt_name,
    type: row.prompt_type,
    version: row.version,
    content: row.content,
    isActive: row.is_active,
    activatedOn: row.activated_on,
    createdBy: row.created_by,
    changeNotes: row.change_notes,
    createdOn: row.created_on,
  };
}

/** Postgres error code for a UNIQUE constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

function isPgErrorWithCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

export class PostgresPromptStorageAdapter implements PromptStorageAdapter {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async ensureSchema(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id             BIGSERIAL PRIMARY KEY,
          prompt_name    VARCHAR(100) NOT NULL,
          prompt_type    VARCHAR(50)  NOT NULL,
          version        INTEGER      NOT NULL,
          content        TEXT         NOT NULL,
          is_active      BOOLEAN      NOT NULL DEFAULT FALSE,
          activated_on   TIMESTAMPTZ,
          created_by     VARCHAR(255),
          change_notes   TEXT,
          created_on     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
          CONSTRAINT prompt_versions_name_type_version_key UNIQUE (prompt_name, prompt_type, version)
        )
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_prompt_versions_active
          ON prompt_versions (prompt_name, prompt_type)
          WHERE is_active = TRUE
      `);
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_prompt_versions_name_type_version
          ON prompt_versions (prompt_name, prompt_type, version DESC)
      `);
    } catch (err) {
      throw new PromptStorageError('ensureSchema', err);
    }
  }

  async getMaxVersion(name: string, type: string): Promise<number> {
    try {
      const result = await this.pool.query<{ max_version: number | null }>(
        'SELECT MAX(version) AS max_version FROM prompt_versions WHERE prompt_name = $1 AND prompt_type = $2',
        [name, type]
      );
      return result.rows[0]?.max_version ?? 0;
    } catch (err) {
      throw new PromptStorageError('getMaxVersion', err);
    }
  }

  async getVersion(name: string, type: string, version: number): Promise<PromptRecord | null> {
    try {
      const result = await this.pool.query<PromptVersionRow>(
        'SELECT * FROM prompt_versions WHERE prompt_name = $1 AND prompt_type = $2 AND version = $3',
        [name, type, version]
      );
      const row = result.rows[0];
      return row ? rowToRecord(row) : null;
    } catch (err) {
      throw new PromptStorageError('getVersion', err);
    }
  }

  async getActiveVersion(name: string, type: string): Promise<PromptRecord | null> {
    try {
      const result = await this.pool.query<PromptVersionRow>(
        'SELECT * FROM prompt_versions WHERE prompt_name = $1 AND prompt_type = $2 AND is_active = TRUE',
        [name, type]
      );
      const row = result.rows[0];
      return row ? rowToRecord(row) : null;
    } catch (err) {
      throw new PromptStorageError('getActiveVersion', err);
    }
  }

  async listVersions(name: string, type: string): Promise<PromptRecord[]> {
    try {
      const result = await this.pool.query<PromptVersionRow>(
        'SELECT * FROM prompt_versions WHERE prompt_name = $1 AND prompt_type = $2 ORDER BY version DESC',
        [name, type]
      );
      return result.rows.map(rowToRecord);
    } catch (err) {
      throw new PromptStorageError('listVersions', err);
    }
  }

  /**
   * Inserts a new version row inside a transaction and, when `isActive` is
   * true, atomically deactivates whichever row was previously active for the
   * same (name, type) before activating the new one. A checked-out client +
   * explicit BEGIN/COMMIT/ROLLBACK is used (rather than a single CTE
   * statement) because this spans two logically distinct writes (insert,
   * then deactivate-siblings) and the transaction boundary is the clearest
   * place to reason about atomicity during review.
   *
   * Concurrency: version-number collisions from two racing publish() calls
   * are caught by the UNIQUE (prompt_name, prompt_type, version) constraint
   * and surfaced as PromptVersionConflictError — the caller (registry.ts)
   * computes `version` from getMaxVersion() before calling this, so a race
   * window exists between the two calls; the constraint is the backstop,
   * not best-effort.
   */
  async insertVersion(input: InsertPromptVersionInput): Promise<PromptRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      let inserted: PromptVersionRow;
      try {
        const insertResult = await client.query<PromptVersionRow>(
          `INSERT INTO prompt_versions
             (prompt_name, prompt_type, version, content, is_active, activated_on, created_by, change_notes)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 THEN NOW() ELSE NULL END, $6, $7)
           RETURNING *`,
          [
            input.name,
            input.type,
            input.version,
            input.content,
            input.isActive,
            input.createdBy,
            input.changeNotes,
          ]
        );
        const row = insertResult.rows[0];
        if (!row) throw new Error('INSERT ... RETURNING produced no row');
        inserted = row;
      } catch (err) {
        await client.query('ROLLBACK');
        if (isPgErrorWithCode(err, PG_UNIQUE_VIOLATION)) {
          throw new PromptVersionConflictError(input.name, input.type);
        }
        throw new PromptStorageError('insertVersion', err);
      }

      if (input.isActive) {
        try {
          await client.query(
            `UPDATE prompt_versions
               SET is_active = FALSE
             WHERE prompt_name = $1 AND prompt_type = $2 AND version <> $3 AND is_active = TRUE`,
            [input.name, input.type, input.version]
          );
        } catch (err) {
          await client.query('ROLLBACK');
          throw new PromptStorageError('insertVersion:deactivateSiblings', err);
        }
      }

      await client.query('COMMIT');
      return rowToRecord(inserted);
    } finally {
      client.release();
    }
  }

  /**
   * Atomically deactivates the current active row and activates `version`
   * instead. Single checked-out transaction; throws PromptNotFoundError
   * (after ROLLBACK) if `version` does not exist for (name, type).
   */
  async activateVersion(name: string, type: string, version: number): Promise<PromptRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const targetResult = await client.query<PromptVersionRow>(
        'SELECT * FROM prompt_versions WHERE prompt_name = $1 AND prompt_type = $2 AND version = $3 FOR UPDATE',
        [name, type, version]
      );
      const target = targetResult.rows[0];
      if (!target) {
        await client.query('ROLLBACK');
        throw new PromptNotFoundError(name, type, version);
      }

      await client.query(
        `UPDATE prompt_versions
           SET is_active = FALSE
         WHERE prompt_name = $1 AND prompt_type = $2 AND version <> $3 AND is_active = TRUE`,
        [name, type, version]
      );

      const activatedResult = await client.query<PromptVersionRow>(
        `UPDATE prompt_versions
           SET is_active = TRUE, activated_on = NOW()
         WHERE prompt_name = $1 AND prompt_type = $2 AND version = $3
         RETURNING *`,
        [name, type, version]
      );
      const activated = activatedResult.rows[0];
      if (!activated) {
        await client.query('ROLLBACK');
        throw new PromptStorageError(
          'activateVersion',
          new Error('UPDATE ... RETURNING produced no row')
        );
      }

      await client.query('COMMIT');
      return rowToRecord(activated);
    } catch (err) {
      if (err instanceof PromptNotFoundError || err instanceof PromptStorageError) throw err;
      throw new PromptStorageError('activateVersion', err);
    } finally {
      client.release();
    }
  }
}
