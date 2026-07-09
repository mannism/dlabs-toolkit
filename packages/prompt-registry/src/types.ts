/**
 * Core types and Zod schemas for @diabolicallabs/prompt-registry.
 *
 * Every public API input is validated with a Zod schema at the boundary
 * (registry.ts calls `.parse()` before touching the storage adapter) — no
 * `any`, per fleet TypeScript-strict policy. Runtime validation matters here
 * specifically because `content` is LLM-facing text that gets persisted and
 * later re-injected into prompts; malformed input (wrong types, oversized
 * payloads) should fail at the API boundary, not surface as a DB constraint
 * error three layers down.
 */

import { z } from 'zod';

/** Default prompt_type used when a caller omits the type dimension. Matches the admin-standard SYSTEM/USER convention loosely — 'system' is the common case for the single-prompt-per-name products the reference implementation ports from. */
export const DEFAULT_PROMPT_TYPE = 'system';

/** Max prompt body size accepted by publish()/seed() — guards against pathological payloads reaching the DB. 200 KB is generous headroom over any real system/user prompt observed in the fleet. */
export const MAX_PROMPT_CONTENT_BYTES = 200_000;

const promptNameSchema = z
  .string()
  .trim()
  .min(1, 'name must not be empty')
  .max(100, 'name must be at most 100 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'name may contain only letters, numbers, dot, underscore, hyphen');

const promptTypeSchema = z
  .string()
  .trim()
  .min(1, 'type must not be empty')
  .max(50, 'type must be at most 50 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'type may contain only letters, numbers, dot, underscore, hyphen');

const promptContentSchema = z
  .string()
  .min(1, 'content must not be empty')
  .refine(
    (val) => Buffer.byteLength(val, 'utf8') <= MAX_PROMPT_CONTENT_BYTES,
    `content must be at most ${MAX_PROMPT_CONTENT_BYTES} bytes`
  );

/** A single seed entry — one repo-file-backed prompt to load into the registry via seed(). */
export const seedPromptEntrySchema = z.object({
  name: promptNameSchema,
  type: promptTypeSchema.optional(),
  content: promptContentSchema,
  changeNotes: z.string().max(2000).optional(),
});
export type SeedPromptEntry = z.infer<typeof seedPromptEntrySchema>;

export const getOptionsSchema = z.object({
  type: promptTypeSchema.optional(),
  version: z.union([z.number().int().positive(), z.literal('latest')]).optional(),
});
export type GetOptions = z.infer<typeof getOptionsSchema>;

export const publishMetaSchema = z.object({
  type: promptTypeSchema.optional(),
  createdBy: z.string().max(255).optional(),
  changeNotes: z.string().max(2000).optional(),
});
export type PublishMeta = z.infer<typeof publishMetaSchema>;

export const historyOptionsSchema = z.object({
  type: promptTypeSchema.optional(),
});
export type HistoryOptions = z.infer<typeof historyOptionsSchema>;

export const rollbackOptionsSchema = z.object({
  type: promptTypeSchema.optional(),
});
export type RollbackOptions = z.infer<typeof rollbackOptionsSchema>;

/** Zod-validated positional-argument schemas, used internally to validate (name, version) pairs before they reach the storage adapter. */
export const promptNameArgSchema = promptNameSchema;
export const promptTypeArgSchema = promptTypeSchema;
export const versionArgSchema = z.number().int().positive();

/**
 * A single row of the prompt_versions table, normalized across storage
 * adapters. Field names are camelCase in-process per the toolkit's two-tier
 * naming rule — the Postgres adapter maps to/from snake_case columns at the
 * boundary.
 */
export interface PromptRecord {
  id: number | string;
  name: string;
  type: string;
  version: number;
  content: string;
  isActive: boolean;
  activatedOn: Date | null;
  createdBy: string | null;
  changeNotes: string | null;
  createdOn: Date;
}

/** Input to insertVersion() — the adapter assigns id/version/createdOn. */
export interface InsertPromptVersionInput {
  name: string;
  type: string;
  version: number;
  content: string;
  isActive: boolean;
  createdBy: string | null;
  changeNotes: string | null;
}

/**
 * Storage adapter interface — the seam that makes the registry backend-agnostic.
 * PostgresPromptStorageAdapter (postgres-adapter.ts) is the shipped reference
 * implementation. A test/in-memory adapter or a future non-Postgres adapter
 * implements the same contract.
 */
export interface PromptStorageAdapter {
  /** Idempotently create the backing table/indexes if they do not already exist. */
  ensureSchema(): Promise<void>;
  /** Insert a new version row. Never mutates an existing row's content — versions are append-only. */
  insertVersion(input: InsertPromptVersionInput): Promise<PromptRecord>;
  /** Fetch one specific version, or null if it does not exist. */
  getVersion(name: string, type: string, version: number): Promise<PromptRecord | null>;
  /** Fetch the currently active version for (name, type), or null if none is active. */
  getActiveVersion(name: string, type: string): Promise<PromptRecord | null>;
  /** All versions for (name, type), newest version first. */
  listVersions(name: string, type: string): Promise<PromptRecord[]>;
  /** Highest existing version number for (name, type), or 0 if none exist yet. */
  getMaxVersion(name: string, type: string): Promise<number>;
  /**
   * Atomically deactivate whichever version is currently active and activate
   * `version` instead. Throws PromptNotFoundError if `version` does not exist.
   * Returns the newly-activated record.
   */
  activateVersion(name: string, type: string, version: number): Promise<PromptRecord>;
}

/** Pluggable logger — matches the toolkit-wide convention (llm-pricing, llm-client, notion, rate-limiter). Consumers route through their app logger; default is structured JSON to stdout. Log payloads NEVER include raw prompt content or connection credentials — see masking.ts. */
export interface Logger {
  info: (event: string, data: Record<string, unknown>) => void;
  warn: (event: string, data: Record<string, unknown>) => void;
  error: (event: string, data: Record<string, unknown>) => void;
}
