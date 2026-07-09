/**
 * PromptRegistry — the admin-standard §S7 prompt lifecycle: seed(), get(),
 * publish(), history(), rollback(). Adapter-agnostic: all storage access goes
 * through the injected PromptStorageAdapter (postgres-adapter.ts is the
 * shipped reference implementation).
 *
 * Every public method validates its inputs with the Zod schemas in types.ts
 * before touching the adapter — PromptValidationError surfaces malformed
 * input at the API boundary rather than as an opaque DB error.
 *
 * Logging discipline (see logger.ts): every log call in this file passes
 * name/type/version/length metadata only — never `content`. This is asserted
 * by src/__tests__/unit/logging-security.test.ts across every method below.
 */

import type { z } from 'zod';
import { PromptNotFoundError, PromptValidationError } from './errors.js';
import { getLogger } from './logger.js';
import type {
  GetOptions,
  HistoryOptions,
  PromptRecord,
  PromptStorageAdapter,
  PublishMeta,
  RollbackOptions,
  SeedPromptEntry,
} from './types.js';
import {
  DEFAULT_PROMPT_TYPE,
  getOptionsSchema,
  historyOptionsSchema,
  promptNameArgSchema,
  publishMetaSchema,
  rollbackOptionsSchema,
  seedPromptEntrySchema,
  versionArgSchema,
} from './types.js';

export interface SeedResult {
  name: string;
  type: string;
  status: 'seeded' | 'skipped_existing';
  version: number;
}

export interface PromptRegistryConfig {
  adapter: PromptStorageAdapter;
}

export interface PromptRegistry {
  /** Idempotent: for each entry, inserts v1 (active) only if no version exists yet for (name, type). Existing versions are never touched — safe to run on every deploy. */
  seed(entries: SeedPromptEntry[]): Promise<SeedResult[]>;
  /** Fetch a prompt. Defaults: type='system', version='latest' (the currently active version). Passing a specific version number returns that version regardless of active state (useful for diff/preview before rollback). Throws PromptNotFoundError if nothing matches. */
  get(name: string, options?: GetOptions): Promise<PromptRecord>;
  /** Insert a new version and activate it immediately, deactivating whichever version was previously active. Never overwrites an existing row's content. */
  publish(name: string, content: string, meta?: PublishMeta): Promise<PromptRecord>;
  /** All versions for (name, type), newest first. Empty array if the name/type has never been seeded or published. */
  history(name: string, options?: HistoryOptions): Promise<PromptRecord[]>;
  /** Re-activates a prior version without creating a new row — the version's content is untouched; only is_active/activated_on move. Throws PromptNotFoundError if the target version does not exist. */
  rollback(name: string, version: number, options?: RollbackOptions): Promise<PromptRecord>;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    );
    throw new PromptValidationError(details.length > 0 ? details : ['invalid input']);
  }
  return result.data;
}

export function createPromptRegistry(config: PromptRegistryConfig): PromptRegistry {
  const { adapter } = config;

  return {
    async seed(entries: SeedPromptEntry[]): Promise<SeedResult[]> {
      const validated = entries.map((entry) => parseOrThrow(seedPromptEntrySchema, entry));
      const logger = getLogger();
      const results: SeedResult[] = [];

      for (const entry of validated) {
        const type = entry.type ?? DEFAULT_PROMPT_TYPE;
        const existingMax = await adapter.getMaxVersion(entry.name, type);

        if (existingMax > 0) {
          logger.info('PROMPT_SEED_SKIPPED', {
            name: entry.name,
            type,
            existingVersions: existingMax,
          });
          results.push({
            name: entry.name,
            type,
            status: 'skipped_existing',
            version: existingMax,
          });
          continue;
        }

        const inserted = await adapter.insertVersion({
          name: entry.name,
          type,
          version: 1,
          content: entry.content,
          isActive: true,
          createdBy: null,
          changeNotes: entry.changeNotes ?? 'Initial seed from repository file',
        });
        logger.info('PROMPT_SEEDED', {
          name: entry.name,
          type,
          version: inserted.version,
          contentLength: entry.content.length,
        });
        results.push({ name: entry.name, type, status: 'seeded', version: inserted.version });
      }

      return results;
    },

    async get(name: string, options?: GetOptions): Promise<PromptRecord> {
      const validatedName = parseOrThrow(promptNameArgSchema, name);
      const validatedOptions = parseOrThrow(getOptionsSchema, options ?? {});
      const type = validatedOptions.type ?? DEFAULT_PROMPT_TYPE;
      const logger = getLogger();

      const record =
        validatedOptions.version === undefined || validatedOptions.version === 'latest'
          ? await adapter.getActiveVersion(validatedName, type)
          : await adapter.getVersion(validatedName, type, validatedOptions.version);

      if (!record) {
        logger.warn('PROMPT_NOT_FOUND', {
          name: validatedName,
          type,
          version:
            typeof validatedOptions.version === 'number' ? validatedOptions.version : 'active',
        });
        throw new PromptNotFoundError(
          validatedName,
          type,
          typeof validatedOptions.version === 'number' ? validatedOptions.version : undefined
        );
      }

      return record;
    },

    async publish(name: string, content: string, meta?: PublishMeta): Promise<PromptRecord> {
      const validatedName = parseOrThrow(promptNameArgSchema, name);
      const validatedMeta = parseOrThrow(publishMetaSchema, meta ?? {});
      // content validated via the seed schema's content rule, reused here directly
      // rather than duplicating the byte-length/non-empty check.
      const validatedEntry = parseOrThrow(seedPromptEntrySchema, {
        name: validatedName,
        type: validatedMeta.type,
        content,
        changeNotes: validatedMeta.changeNotes,
      });
      const type = validatedEntry.type ?? DEFAULT_PROMPT_TYPE;
      const logger = getLogger();

      const nextVersion = (await adapter.getMaxVersion(validatedName, type)) + 1;
      const inserted = await adapter.insertVersion({
        name: validatedName,
        type,
        version: nextVersion,
        content: validatedEntry.content,
        isActive: true,
        createdBy: validatedMeta.createdBy ?? null,
        changeNotes: validatedMeta.changeNotes ?? null,
      });

      logger.info('PROMPT_PUBLISHED', {
        name: validatedName,
        type,
        version: inserted.version,
        contentLength: validatedEntry.content.length,
        createdBy: validatedMeta.createdBy ?? null,
      });

      return inserted;
    },

    async history(name: string, options?: HistoryOptions): Promise<PromptRecord[]> {
      const validatedName = parseOrThrow(promptNameArgSchema, name);
      const validatedOptions = parseOrThrow(historyOptionsSchema, options ?? {});
      const type = validatedOptions.type ?? DEFAULT_PROMPT_TYPE;
      return adapter.listVersions(validatedName, type);
    },

    async rollback(
      name: string,
      version: number,
      options?: RollbackOptions
    ): Promise<PromptRecord> {
      const validatedName = parseOrThrow(promptNameArgSchema, name);
      const validatedVersion = parseOrThrow(versionArgSchema, version);
      const validatedOptions = parseOrThrow(rollbackOptionsSchema, options ?? {});
      const type = validatedOptions.type ?? DEFAULT_PROMPT_TYPE;
      const logger = getLogger();

      try {
        const activated = await adapter.activateVersion(validatedName, type, validatedVersion);
        logger.info('PROMPT_ROLLED_BACK', { name: validatedName, type, version: validatedVersion });
        return activated;
      } catch (err) {
        if (err instanceof PromptNotFoundError) {
          logger.warn('PROMPT_NOT_FOUND', { name: validatedName, type, version: validatedVersion });
        }
        throw err;
      }
    },
  };
}
