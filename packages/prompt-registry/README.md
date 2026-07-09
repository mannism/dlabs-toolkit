# @diabolicallabs/prompt-registry

Versioned LLM prompt lifecycle. Implements the fleet admin standard (§S7) as a package: `seed()` from repo files, `get()` the active or a specific version, `publish()` a new version, `history()`, `rollback()`. Storage is adapter-based; `PostgresPromptStorageAdapter` is the shipped reference. © Diabolical Labs

**Canonical source:** [`/Users/mann/Documents/Claude/admin-standard.md`](/Users/mann/Documents/Claude/admin-standard.md) (ratified 2026-07-06) — this package implements §S7 ("LLM prompt storage — prompts live in the DB, versioned"). If the standard and this README disagree, the standard wins; file a PR to reconcile.

## Install

```bash
pnpm add @diabolicallabs/prompt-registry
# pg is an optional peerDependency — install if you don't already have it
pnpm add pg
```

## Usage

```typescript
import { Pool } from 'pg';
import {
  createPromptRegistry,
  PostgresPromptStorageAdapter,
  loadSeedFilesFromDirectory,
} from '@diabolicallabs/prompt-registry';

// Bring your own pool — the registry never opens its own connection.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PostgresPromptStorageAdapter(pool);
await adapter.ensureSchema(); // idempotent CREATE TABLE IF NOT EXISTS

const registry = createPromptRegistry({ adapter });

// Seed step (deploy time) — repo files are the source of truth for v1.
const entries = await loadSeedFilesFromDirectory('./constants/prompts');
await registry.seed(entries); // no-op after the first run

// Runtime read
const prompt = await registry.get('onboarding'); // type defaults to 'system', version defaults to active
const systemPrompt = prompt.content;

// Admin publish (new version, activates immediately, old version untouched)
await registry.publish('onboarding', updatedText, {
  createdBy: 'diana',
  changeNotes: 'tightened tone per Reid review',
});

// Roll back to a prior version without creating a new row
await registry.rollback('onboarding', 3);

// Full version history, newest first
const versions = await registry.history('onboarding');
```

### Multiple prompt types (SYSTEM/USER)

```typescript
await registry.publish('interview', systemText, { type: 'system' });
await registry.publish('interview', userTemplateText, { type: 'user' });

const system = await registry.get('interview', { type: 'system' });
const user = await registry.get('interview', { type: 'user' });
```

### Seed file format

`.md` files with YAML-ish frontmatter — `name` required, `type` optional (defaults to `system`):

```markdown
---
name: onboarding
type: system
---
You are a helpful onboarding assistant...
```

## API

### `createPromptRegistry(config): PromptRegistry`

| Config field | Type | Description |
|---|---|---|
| `adapter` | `PromptStorageAdapter` | Required. `PostgresPromptStorageAdapter` or a custom implementation. |

### `PromptRegistry`

| Method | Signature | Description |
|---|---|---|
| `seed` | `(entries: SeedPromptEntry[]) => Promise<SeedResult[]>` | Idempotent — inserts v1 (active) only for names with no existing version. Safe to call on every deploy. |
| `get` | `(name, options?: { type?, version?: number \| 'latest' }) => Promise<PromptRecord>` | Defaults: `type: 'system'`, `version: 'latest'` (the active row). A numeric version returns that row regardless of active state. Throws `PromptNotFoundError`. |
| `publish` | `(name, content, meta?: { type?, createdBy?, changeNotes? }) => Promise<PromptRecord>` | Always inserts a new version and activates it; never overwrites a prior row. |
| `history` | `(name, options?: { type? }) => Promise<PromptRecord[]>` | All versions, newest first. Empty array if never seeded/published. |
| `rollback` | `(name, version, options?: { type? }) => Promise<PromptRecord>` | Re-activates a prior version in place (content untouched, no new row). Throws `PromptNotFoundError` if the version doesn't exist. |

### `PromptRecord`

```typescript
interface PromptRecord {
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
```

## Sensitivity masking

Per admin-standard §S6 (`is_sensitive` masking), prompt bodies are maskable for lower-trust display contexts — audit-log list views, Slack/webhook notification payloads:

```typescript
import { maskPromptBody, redactConnectionString } from '@diabolicallabs/prompt-registry';

maskPromptBody(record.content);          // preview mode (default): first 60 chars + byte count
maskPromptBody(record.content, 'full');  // fully redacted, byte count only
maskPromptBody(record.content, 'hash');  // sha256 fingerprint only — for diff-changed checks

redactConnectionString('postgres://admin:secret@db.internal:5432/prod');
// -> 'postgres://***:***@db.internal:5432/prod'
```

The package's own internal logging **never** includes raw `content` or connection secrets in any log call — asserted by `src/__tests__/unit/logging-security.test.ts`, which spies on every log call across the full `seed → get → publish → history → rollback` lifecycle and asserts a sentinel prompt body never appears in logged output.

## CI eval-gate

Gate a prompt change on an eval script's exit code — wire into your CI before a `publish()` call, or as a pre-merge check on a PR that touches a seed file:

```typescript
import { runPromptEvalGate } from '@diabolicallabs/prompt-registry';

// Throws PromptEvalGateFailedError on non-zero exit — un-caught, this fails the CI step.
await runPromptEvalGate({
  promptPath: './constants/prompts/onboarding.md',
  evalScriptPath: './scripts/eval-onboarding-prompt.mjs',
});
```

Or as a shell step via the bundled CLI:

```bash
npx prompt-registry-eval-gate ./constants/prompts/onboarding.md ./scripts/eval-onboarding-prompt.mjs
```

The eval script receives the prompt path as `argv[2]` and the `PROMPT_FILE` env var; its exit code is the verdict. This package does not prescribe what the script checks — golden-output diffing, a judge-model rubric, a regex smoke test are all valid. `scripts/eval-gate-demo.mjs` demonstrates both directions (pass and fail) against fixture prompts/scripts and runs as part of this package's own CI.

## `PromptStorageAdapter` interface

```typescript
interface PromptStorageAdapter {
  ensureSchema(): Promise<void>;
  insertVersion(input: InsertPromptVersionInput): Promise<PromptRecord>;
  getVersion(name: string, type: string, version: number): Promise<PromptRecord | null>;
  getActiveVersion(name: string, type: string): Promise<PromptRecord | null>;
  listVersions(name: string, type: string): Promise<PromptRecord[]>;
  getMaxVersion(name: string, type: string): Promise<number>;
  activateVersion(name: string, type: string, version: number): Promise<PromptRecord>;
}
```

`PostgresPromptStorageAdapter` is the shipped implementation. It takes a structural `PgPoolLike` (`query` + `connect`) — any real `pg.Pool` instance satisfies it, so you pass your existing pool rather than the registry opening a new connection. All queries are parameterized (`$1`, `$2`, ...) — no string interpolation into SQL anywhere in the adapter. `insertVersion()` and `activateVersion()` each run inside a single checked-out-client transaction (`BEGIN`/`COMMIT`/`ROLLBACK`) so "insert new version" + "deactivate the old active row" (or "deactivate + activate") never observably interleave with a concurrent reader.

A non-Postgres backend implements the same interface — the interface is the extension point, not a plugin registry.

## Migration guide: converting an existing per-product implementation

This section shows the actual diff shape for migrating a product that already has its own `prompt_versions` implementation (the pre-package pattern from admin-standard §S7) onto this package. **FitCheckerApp** (`/Users/mann/Documents/GitHub/FitCheckerApp`) was used as the reference — admin-standard identifies it as the fleet's cleanest `prompt_versions` schema (`db/schema/prompt-versions.ts`, `lib/prompts.ts`, `scripts/seed-prompt-versions.ts`). This is a worked example, not a completed migration — no product is migrated in this PR (see "Out of scope" below); a real migration is its own per-product follow-up brief.

### Before — FitCheckerApp's hand-rolled implementation

`db/schema/prompt-versions.ts` (Drizzle):

```typescript
export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  promptName: varchar("prompt_name", { length: 100 }).notNull(),
  promptType: varchar("prompt_type", { length: 10 }).notNull(),
  version: integer("version").notNull(),
  content: text("content").notNull(),
  llmModelId: uuid("llm_model_id").references(() => llmModels.id),
  isActive: boolean("is_active").notNull().default(false),
  activatedOn: timestamp("activated_on"),
  createdBy: uuid("created_by").references(() => users.id),
  createdOn: timestamp("created_on").defaultNow().notNull(),
  changeNotes: text("change_notes"),
}, (table) => [
  unique("prompt_versions_prompt_name_prompt_type_version_key")
    .on(table.promptName, table.promptType, table.version),
]);
```

`lib/prompts.ts` (custom cache + fallback logic, ~165 lines):

```typescript
export async function getPrompt(prompt_name: string, prompt_type: string): Promise<Prompt | null> {
  const normalizedName = prompt_name.trim().toUpperCase();
  const normalizedType = prompt_type.trim().toUpperCase();
  try {
    const cacheKey = `prompt:${normalizedName}:${normalizedType}`;
    const dbPrompt = await withCache(cacheKey, PROMPT_CACHE_TTL, async () => {
      const { getActivePromptVersion, getPromptModelOverride } =
        await import("@/lib/repositories/prompt.repository");
      const active = await getActivePromptVersion(normalizedName, normalizedType);
      // ...
    });
    if (dbPrompt) return { /* hand-built Prompt shape */ };
  } catch {
    // DB unavailable — fall through to filesystem
  }
  // ...filesystem fallback via loadPrompts()...
}
```

`scripts/seed-prompt-versions.ts` (~114 lines, hand-rolled `pg.Pool` + manual `INSERT ... WHERE NOT EXISTS` idempotency check).

### After — with `@diabolicallabs/prompt-registry`

```typescript
// lib/prompt-registry.ts — replaces db/schema/prompt-versions.ts's manual
// table definition (ensureSchema() owns the DDL) and lib/prompts.ts's
// getPrompt()/loadPrompts() (registry.get() replaces both).
import { Pool } from 'pg';
import { createPromptRegistry, PostgresPromptStorageAdapter } from '@diabolicallabs/prompt-registry';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const promptRegistry = createPromptRegistry({
  adapter: new PostgresPromptStorageAdapter(pool),
});
```

```typescript
// scripts/seed-prompts.ts — replaces scripts/seed-prompt-versions.ts (114 lines -> ~10)
import { loadSeedFilesFromDirectory } from '@diabolicallabs/prompt-registry';
import { promptRegistry } from '../lib/prompt-registry';

const entries = await loadSeedFilesFromDirectory('./constants/prompts');
const results = await promptRegistry.seed(entries);
console.log(results); // [{ name, type, status: 'seeded' | 'skipped_existing', version }]
```

```typescript
// call sites — getPrompt(name, type) becomes registry.get(name, { type })
- const prompt = await getPrompt("ONBOARDING", "SYSTEM");
- const text = prompt?.prompt ?? FALLBACK_TEXT;
+ const prompt = await promptRegistry.get('onboarding', { type: 'system' });
+ const text = prompt.content;
```

### What changes, what doesn't

| Aspect | FitCheckerApp before | With prompt-registry |
|---|---|---|
| Schema | Hand-written Drizzle table, product owns migration | `ensureSchema()` (or hand-author an equivalent migration from `schema.sql` if you already use Drizzle migrations) |
| Idempotent seed | 114-line script, manual `WHERE NOT EXISTS` | `loadSeedFilesFromDirectory()` + `seed()`, ~10 lines |
| Read path | `getPrompt()` + `withCache()` + filesystem fallback, ~165 lines | `registry.get(name, options)` — no built-in cache (see Performance note below); filesystem fallback is your call, not the package's |
| Rollback | Not implemented in FitCheckerApp today | `registry.rollback(name, version)` |
| Concurrency safety | Not explicitly handled | `PromptVersionConflictError` on a version-number race (UNIQUE constraint backstop) |
| Frontmatter format | `name`/`type` fields, same as this package | Unchanged — `loadSeedFilesFromDirectory()` reads the exact same `.md` files FitCheckerApp already has in `constants/prompts/` |

**Not carried over on purpose:** FitCheckerApp's `withCache()` 10-minute TTL and filesystem fallback are product-specific request-path optimizations, not part of the admin-standard contract. A migrating product keeps its own cache layer in front of `registry.get()` — see the Performance note in `manifest.yaml`.

## Testing

```bash
pnpm test              # unit suite, mocked/in-memory adapters
pnpm test:integration   # requires DATABASE_URL — see src/__tests__/integration/postgres.test.ts header
pnpm demo:eval-gate     # eval-gate fixture demonstration (requires `pnpm build` first)
```
