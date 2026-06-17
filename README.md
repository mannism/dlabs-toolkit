# dlabs-toolkit

Shared platform infrastructure for the Diabolical Labs and Diana Ismail project fleet. Independently-versioned TypeScript packages consumed across multiple repos. © Diabolical Labs

Eight v1.0.0+ packages on npmjs.com under `@diabolicallabs`. See per-package `package.json` for current versions — `MODULES.md` carries the canonical version index.

---

## Packages

### LLM platform
| Package | Status | Description |
|---|---|---|
| [`@diabolicallabs/llm-client`](packages/llm-client/) | stable | Unified LLM API across 5 providers — Anthropic, OpenAI (Responses API), Gemini, DeepSeek, Perplexity. `complete()` / `stream()` / `structured()` / `withTools()` / `streamStructured()`. `createClient()` is async. **Errors:** 14-kind `LlmErrorKind` taxonomy. **Structured outputs:** native Zod 4 strict mode. **Retry / timeouts / abort:** configurable retry with exponential backoff, per-call `AbortSignal`, stream stall detection. **Failover:** provider failover on `fallbackOn` kinds, pool sub-path for concurrency control. **Hooks:** `beforeCall`/`afterCall` on all 5 call types; `LlmAfterCallContext.usage` populated for all paths including streaming. **Cost:** optional cost computation via `@diabolicallabs/llm-pricing`; `pricing.remoteUrl` on `createClient()` fetches live pricing with stale-while-revalidate (24h TTL, never-throws). **Escape hatches:** `providerOptions`, Anthropic prompt cache opt-in, web-grounded citations (Perplexity), response IDs. Pluggable logger. |
| [`@diabolicallabs/llm-pricing`](packages/llm-pricing/) | stable | Default pricing table + `computeCost()` for all 5 providers. Covers Gemini long-context tiering, Anthropic dual cache write rates, DeepSeek deprecated alias resolution, o-series and `sonar-deep-research` partial-cost flags. `versionedAt` field for staleness detection. `pnpm pricing:verify` script for monthly drift checks. Hybrid storage: `pricing/table.json` at repo root is the canonical remote source; `fetchRemoteTable()` fetches it with stale-while-revalidate cache and a never-throws fail-safe — price refreshes update the JSON directly without a release cycle. Pluggable `PricingLogger`. |
| [`@diabolicallabs/agent-sdk`](packages/agent-sdk/) | stable | Cost-tracking middleware wrapping llm-client. Async fire-and-forget ingestion to Agent Spend Dashboard. `CallRecord.tool_calls` captures `withTools()` invocations. `CallRecord.cost` propagates per-call USD cost when `llm-pricing` is installed. `CallRecord.requestedModel` on provider failover. `streamStructured()` usage capture. All 5 call types route through a single dispatch function. Pluggable logger (v3.1.0). UUID validation on `agentId`/`projectId` at call time — non-UUID values flip to no-op mode (v3.2.0). `files` namespace passthrough on `InstrumentedLlmClient` (v3.2.4). Requires `llm-client@^5.0.0`. |

### Notifier family (Wave 6 — shipped 2026-05-24)
| Package | Status | Description |
|---|---|---|
| [`@diabolicallabs/notifier-core`](packages/notifier-core/) | stable | Shared `Notifier` interface, `PlatformError` taxonomy (5 named subclasses), `Logger` interface, and `retryWithJitter` helper (full-jitter exponential backoff). Zero runtime dependencies. All notifier-family packages import their contracts from here. |
| [`@diabolicallabs/slack`](packages/slack/) | stable | Send-only Slack notifier via `@slack/web-api` v7 — `chat.postMessage` (bot-token path) and incoming webhooks. Named error taxonomy extending `notifier-core` `PlatformError`. Two-layer rate limiting (reactive `Retry-After` + optional proactive `@diabolicallabs/rate-limiter` peer-dep for tier-1 gating). Block Kit type re-exports. Secrets never logged. |
| [`@diabolicallabs/telegram`](packages/telegram/) | stable | Send-only Telegram notifier via native `fetch` against `api.telegram.org` — no SDK dependency. `sendMessage` with `parseMode`, `InlineKeyboardMarkup`, and `MarkdownV2` escape helper. Named error taxonomy. `retry_after` sourced from response body (Telegram-specific). Bot token redacted in all log lines. |

### Integrations
| Package | Status | Description |
|---|---|---|
| [`@diabolicallabs/notion`](packages/notion/) | stable | Notion REST API client wrapping `@notionhq/client` v5. `createDatabasePage` / `queryDatabase` (auto-paginated via `collectPaginatedAPI`) / `getPage` / `updatePage`. Named error taxonomy (6 subclasses including `NotionValidationError`). Full-jitter 409-conflict retry. Pluggable logger. Default Notion-Version `2025-09-03`. |
| [`@diabolicallabs/rate-limiter`](packages/rate-limiter/) | stable | Redis sliding-window rate limiter using Lua `EVAL`/`EVALSHA` for atomicity. `RateLimiterConfig.onRedisError: 'closed' \| 'open'` (default closed). `RateLimitError.kind: 'exceeded' \| 'unavailable'` discriminator. Structural `RedisExecutor` interface — works with `ioredis` out of the box, swappable to `@upstash/redis` adapters without a major bump. Pluggable logger. |

See [`MODULES.md`](MODULES.md) for the canonical version index and build-plan history.

---

## Quick start

```bash
pnpm add @diabolicallabs/llm-client
```

Public on npmjs.com under the `@diabolicallabs` scope — no `.npmrc` config required.

```typescript
import { createClientFromEnv } from '@diabolicallabs/llm-client';

// Reads ANTHROPIC_API_KEY from environment
// createClientFromEnv is async as of v1.7.0
const client = await createClientFromEnv('anthropic', 'claude-sonnet-4-6');

const response = await client.complete([
  { role: 'user', content: 'Hello' },
]);
console.log(response.content, response.usage);

// Streaming
for await (const chunk of client.stream([{ role: 'user', content: 'Hello' }])) {
  process.stdout.write(chunk.token);
}

// Configurable retry (v1.2.0)
const clientWithRetry = await createClientFromEnv('openai', 'gpt-5.5', {
  retry: {
    maxAttempts: 5,
    strategy: 'decorrelated',
    baseDelayMs: 500,
    respectRetryAfter: true,
    retryOn: ['rate_limit', 'server_error', 'timeout', 'network'],
  },
});

// Provider failover (v1.2.0)
const clientWithFallback = await createClientFromEnv('anthropic', ['claude-opus-4-99', 'claude-sonnet-4-6'], {
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
    llm-client/      @diabolicallabs/llm-client
    llm-pricing/     @diabolicallabs/llm-pricing
    agent-sdk/       @diabolicallabs/agent-sdk
    notifier-core/   @diabolicallabs/notifier-core
    slack/           @diabolicallabs/slack
    telegram/        @diabolicallabs/telegram
    notion/          @diabolicallabs/notion
    rate-limiter/    @diabolicallabs/rate-limiter
  pricing/
    table.json                      canonical remote pricing source
    automation/                     n8n drift-check workflow + install docs
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
- **ESM-only.** Node >=20 and modern bundlers. No separate CJS build. `@diabolicallabs/llm-client` requires Node >=22.12.0 (the `require` condition in its exports map uses `require(esm)`, stable since 22.12).
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
