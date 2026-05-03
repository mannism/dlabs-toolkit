# dlabs-toolkit

**Diabolical Labs platform toolkit** — shared TypeScript infrastructure consumed across the Diabolical Labs and Diana Ismail project fleet. © Diabolical Labs

## Status

**Week 1 scaffold.** Monorepo structure, CI, and package skeletons are in place. Package implementations begin Week 2.

## Packages

| Package | Status | Description |
|---|---|---|
| [`@diabolicallabs/llm-client`](packages/llm-client/) | Scaffolded | Unified LLM API — Anthropic, OpenAI, Google, DeepSeek. Streaming, retry, structured output, token normalisation. |
| [`@diabolicallabs/agent-sdk`](packages/agent-sdk/) | Scaffolded | Cost-tracking middleware wrapping llm-client. Async ingestion to Agent Spend Dashboard. |
| [`@diabolicallabs/notion`](packages/notion/) | Scaffolded | Notion REST API helpers — page creation, property serialisation, conflict retry, rate-limit backoff. |
| [`@diabolicallabs/rate-limiter`](packages/rate-limiter/) | Scaffolded | Redis sliding-window rate limiter. Sorted-set pipeline, fail-closed on Redis outage. |

See [`MODULES.md`](MODULES.md) for the manifest index.

## Prerequisites

- Node ≥20
- pnpm ≥9

## Development

```bash
# Install all workspace dependencies
pnpm install

# Typecheck all packages (topological order via tsc project references)
pnpm turbo run typecheck

# Lint all packages (Biome + narrow ESLint for floating-promises)
pnpm turbo run lint

# Build all packages (tsup, ESM only)
pnpm turbo run build

# Test all packages (Vitest per package)
pnpm turbo run test

# Run full CI pipeline locally (mirrors ci.yml)
pnpm turbo run typecheck lint build test
```

## Remote cache

Turborepo remote cache is **not yet configured**. See `turbo.json` for the TODO. To enable: link the repo to Vercel and set `TURBO_TOKEN` + `TURBO_TEAM` env vars.

## Toolchain

| Tool | Purpose |
|---|---|
| pnpm workspaces | Package manager + workspace protocol |
| Turborepo | Task pipeline, topological ordering, local cache |
| tsup (esbuild) | Per-package bundler — ESM only |
| TypeScript strict | Strict mode, NodeNext module resolution |
| Biome | Formatter + linter (all rules except floating-promises) |
| ESLint (narrow) | `no-floating-promises` + `no-misused-promises` only |
| Vitest | Per-package unit tests |
| Changesets | Independent semver versioning per package |

## Publishing

Packages are published to **GitHub Packages** at v0. Migration to npm public registry is a single workflow change when an external consumer requires it.

Consumer repos add to their `.npmrc`:

```
@diabolicallabs:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

## Architecture

Full architecture, v0 scope, public API surface, and build plan:
`/Users/mann/Documents/Claude/proj-plan/dlabs-toolkit/briefs/brief-platform.md`

## Maintainer

Diana Ismail · [diabolicallabs.studio](https://diabolicallabs.studio)
