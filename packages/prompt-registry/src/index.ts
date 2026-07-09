/**
 * @diabolicallabs/prompt-registry
 *
 * Versioned LLM prompt lifecycle — the admin-standard (§S7, ratified
 * 2026-07-06) prompt_versions pattern extracted into a reusable package.
 * See /Users/mann/Documents/Claude/admin-standard.md for the canonical spec
 * this package implements, and README.md for the migration guide.
 *
 *   - createPromptRegistry({ adapter })  — seed/get/publish/history/rollback
 *   - PostgresPromptStorageAdapter       — reference Postgres adapter (parameterized queries only)
 *   - loadSeedFilesFromDirectory()       — repo-file frontmatter .md → SeedPromptEntry[]
 *   - maskPromptBody() / redactConnectionString() — sensitivity masking for logs/audit UI
 *   - runPromptEvalGate()                — CI gate: run an eval script against a changed prompt
 *   - setPromptRegistryLogger()          — pluggable structured logger
 */

// Error taxonomy
export {
  PromptEvalGateFailedError,
  PromptNotFoundError,
  PromptRegistryError,
  PromptStorageError,
  PromptValidationError,
  PromptVersionConflictError,
} from './errors.js';
export type { EvalGateOptions, EvalGateResult } from './eval-gate.js';
// CI eval-gate helper
export { runPromptEvalGate } from './eval-gate.js';
// Logger
export { setPromptRegistryLogger } from './logger.js';
export type { MaskMode } from './masking.js';
// Masking
export { maskPromptBody, redactConnectionString } from './masking.js';
export type { PgClientLike, PgPoolLike } from './postgres-adapter.js';
// Postgres reference adapter
export { PostgresPromptStorageAdapter } from './postgres-adapter.js';
export type { PromptRegistry, PromptRegistryConfig, SeedResult } from './registry.js';
// Registry — the public lifecycle API
export { createPromptRegistry } from './registry.js';
// Seed loader
export { loadSeedFilesFromDirectory, parseSeedFile } from './seed-loader.js';
// Types — public interfaces + Zod-inferred option types
export type {
  GetOptions,
  HistoryOptions,
  InsertPromptVersionInput,
  Logger,
  PromptRecord,
  PromptStorageAdapter,
  PublishMeta,
  RollbackOptions,
  SeedPromptEntry,
} from './types.js';
export { DEFAULT_PROMPT_TYPE, MAX_PROMPT_CONTENT_BYTES } from './types.js';
