# dlabs-toolkit

Shared platform infrastructure for the Diabolical Labs and Diana Ismail project fleet. Independently-versioned TypeScript packages consumed across multiple repos. © Diabolical Labs

**`llm-client` at v1.6.0; `agent-sdk` at v2.0.0; `llm-pricing` at v0.1.0.** `notion` and `rate-limiter` remain pre-1.0.

---

## Packages

| Package | Status | Description |
|---|---|---|
| [`@diabolicallabs/llm-client`](packages/llm-client/) | published (v1.6.0) | Unified LLM API — Anthropic, OpenAI (Responses API), Gemini, DeepSeek, Perplexity. `complete()` / `stream()` / `structured()` / `withTools()` / `streamStructured()`. 14-kind `LlmErrorKind` taxonomy. Native strict structured outputs (Zod 4). Per-call timeouts/AbortSignal/stream stall, token normalization, web-grounded citations, `providerOptions` escape hatch. Anthropic prompt cache opt-in. Optional cost computation via `@diabolicallabs/llm-pricing` (v1.1.0+). Configurable retry (v1.2.0+), provider failover, pool sub-path. Capability matrix + linked abort + response IDs (v1.4.0+). **v1.5.0:** pre-call hooks (`beforeCall`/`afterCall`) on all 5 call types. **v1.6.0:** `LlmAfterCallContext.usage` populated for all 5 call types including streaming paths. See [`packages/llm-client/MIGRATION.md`](packages/llm-client/MIGRATION.md) for v0.x → v1.0.0 migration. |
| [`@diabolicallabs/llm-pricing`](packages/llm-pricing/) | published (v0.1.0) | Default pricing table + `computeCost()` for all 5 providers. Verified 2026-05-13. Gemini long-context tiering, Anthropic dual cache write rates, DeepSeek deprecated alias resolution, o-series and sonar-deep-research partial-cost flags. `versionedAt` field for staleness detection. `pnpm pricing:verify` script for monthly drift checks. Optional peer dep for `llm-client` and `agent-sdk`. |
| [`@diabolicallabs/agent-sdk`](packages/agent-sdk/) | published (v2.0.0) | Cost-tracking middleware wrapping llm-client. Async fire-and-forget ingestion to Agent Spend Dashboard. `CallRecord.tool_calls` captures `withTools()` invocations. `CallRecord.cost` propagates per-call USD cost when `llm-pricing` is installed (v1.1.0+). `CallRecord.requestedModel` on provider failover (v1.2.0+). `streamStructured()` usage capture (v1.3.0+). **v2.0.0:** architecture-migration complete — all 5 call types route through a single dispatch function; bespoke stream wrappers deleted; public API unchanged. Requires `llm-client@^1.6.0`. Optional peer-dep on `llm-pricing@^0.1.0`. |
| [`@diabolicallabs/notion`](packages/notion/) | scaffolded (v0.0.2) | Notion REST API helpers — page creation, property serialization, conflict retry, rate-limit backoff. |
| [`@diabolicallabs/rate-limiter`](packages/rate-limiter/) | scaffolded (v0.0.2) | Redis sliding-window rate limiter. Sorted-set pipeline, fail-closed on Redis outage. |

See [`MODULES.md`](MODULES.md) for the full manifest index and build plan.

---

## Quick start

```bash
pnpm add @diabolicallabs/llm-client
```

Public on npmjs.com under the `@diabolicallabs` scope — no `.npmrc` config required.

```typescript
import { createClientFromEnv } from '@diabolicallabs/llm-client';

// Reads ANTHROPIC_API_KEY from environment
const client = createClientFromEnv('anthropic', 'claude-sonnet-4-6');

const response = await client.complete([
  { role: 'user', content: 'Hello' },
]);
console.log(response.content, response.usage);

// Streaming
for await (const chunk of client.stream([{ role: 'user', content: 'Hello' }])) {
  process.stdout.write(chunk.token);
}

// Configurable retry (v1.2.0)
const clientWithRetry = createClientFromEnv('openai', 'gpt-5.5', {
  retry: {
    maxAttempts: 5,
    strategy: 'decorrelated',
    baseDelayMs: 500,
    respectRetryAfter: true,
    retryOn: ['rate_limit', 'server_error', 'timeout', 'network'],
  },
});

// Provider failover (v1.2.0)
const clientWithFallback = createClientFromEnv('anthropic', ['claude-opus-4-99', 'claude-sonnet-4-6'], {
  fallbackOn: ['not_found'],
});

// Parallel workloads with concurrency control (v1.2.0)
import { createPool } from '@diabolicallabs/llm-client/pool';

const pool = createPool({
  concurrencyPerProvider: { anthropic: 4, openai: 4, gemini: 2 },
  rateLimitPerProvider: { anthropic: { rpm: 60 } },
});

const results = await pool.runAll(
  tasks.map(t => ({ task: () => client.complete(t.messages), provider: 'anthropic' })),
  { signal: abortController.signal, onProgress: (done, total) => console.log(`${done}/${total}`) }
);
```

---

## Provider universe

| Provider | Status | Env var |
|---|---|---|
| `anthropic` | Implemented | `ANTHROPIC_API_KEY` |
| `openai` | Implemented | `OPENAI_API_KEY` |
| `gemini` | Implemented | `GOOGLE_AI_API_KEY` |
| `deepseek` | Implemented | `DEEPSEEK_API_KEY` |
| `perplexity` | Implemented | `PERPLEXITY_API_KEY` |

Perplexity is web-grounded — `complete()` returns `response.citations` (array of `{ url, title? }`) when sources are available. Stream mode does not include citations (Perplexity API limitation). Default model is `sonar`; reasoning is `sonar-reasoning-pro` (`sonar-reasoning` was deprecated December 2025). Perplexity-specific filters (`search_recency_filter`, `search_domain_filter`) flow through the per-call `providerOptions` escape hatch.

---

## Repo layout

```
dlabs-toolkit/
  packages/
    llm-client/     @diabolicallabs/llm-client
    llm-pricing/    @diabolicallabs/llm-pricing
    agent-sdk/      @diabolicallabs/agent-sdk
    notion/         @diabolicallabs/notion
    rate-limiter/   @diabolicallabs/rate-limiter
  scripts/
    integration-test.ts            manual API integration tests (not in CI)
    smoke-*.ts / smoke-*.mjs       per-provider live smoke tests — pre-publish gate
    tsconfig.json                  strict TS config for the scripts/ directory
  .changeset/       Changesets version files
  .github/
    workflows/
      ci.yml        typecheck + lint + build + test (Turbo)
      release.yml   Changesets release workflow → npmjs.com
    dependabot.yml  automated dependency bumps
  biome.json        formatter + linter config
  turbo.json        task pipeline config
  MODULES.md        package manifest index
```

Each package has a `manifest.yaml` with its full contract: exports, dependencies, consumers, failure modes, and performance notes.

---

## Conventions

- **TypeScript strict.** No `any`, no unused locals/params, no implicit `any`.
- **ESM-only.** Node >=20 and modern bundlers. No CJS dual-publish.
- **US English** in all code identifiers, JSDoc, error messages, READMEs, and manifests.
- **Independent versioning per package** via Changesets. Semver discipline mandatory.
- **No package ships without tests.** 80% coverage gate across lines, functions, branches, statements.
- **Conventional Commits** required. `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `ci:`.
- **semantic-release** via Changesets handles versioning, CHANGELOG, and GitHub Releases. Do not manually bump versions.

---

## Development

```bash
# Install all workspace dependencies
pnpm install

# Typecheck all packages (topological — agent-sdk builds after llm-client)
pnpm turbo run typecheck

# Lint all packages (Biome + narrow ESLint for floating-promise rules)
pnpm turbo run lint

# Build all packages (tsup, ESM only, per package)
pnpm turbo run build

# Test all packages (Vitest, per package, 80% coverage gate)
pnpm turbo run test

# Full CI pipeline locally (mirrors ci.yml)
pnpm turbo run typecheck lint build test

# Manual integration tests against real APIs (requires API keys set)
pnpm tsx scripts/integration-test.ts
```

---

## Toolchain

| Tool | Purpose |
|---|---|
| pnpm workspaces | Package manager and workspace protocol |
| Turborepo | Task pipeline, topological ordering, local cache |
| tsup (esbuild) | Per-package bundler — ESM only |
| TypeScript strict | Strict mode, NodeNext module resolution |
| Biome 2 | Formatter + linter (primary rule set) |
| ESLint (narrow) | `no-floating-promises` + `no-misused-promises` only |
| Vitest | Per-package unit tests with coverage gate |
| Changesets | Independent semver versioning per package |

---

## Publishing

Packages are published to **npmjs.com** under the public `@diabolicallabs` scope. Each merged "Version Packages" PR (auto-generated by `changesets/action`) runs `changeset publish`, which:

1. Pushes each package whose local version exceeds the registry version
2. Creates per-package git tags (e.g. `@diabolicallabs/llm-client@0.1.0`)
3. Creates a GitHub Release per tag, with the changelog body assembled from the consumed changeset files

Authentication uses an automation token (`NPM_TOKEN` GitHub secret) scoped to the `@diabolicallabs` scope, with read-only org access. Token expiration: 90 days.

**Planned migration:** switch each package to npm Trusted Publishing (OIDC) after the first publish lands, retiring the long-lived token. Tracked as a Week 5+ chore.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Diana Ismail trading as Diabolical Labs.

---

## Maintainer

Diana Ismail · [diabolicallabs.studio](https://diabolicallabs.studio)
