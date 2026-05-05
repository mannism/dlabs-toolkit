# dlabs-toolkit

Shared platform infrastructure for the Diabolical Labs and Diana Ismail project fleet. Independently-versioned TypeScript packages consumed across multiple repos. © Diabolical Labs

**Pre-1.0. APIs may change between minor versions.**

---

## Packages

| Package | Status | Description |
|---|---|---|
| [`@diabolicallabs/llm-client`](packages/llm-client/) | published (v0.1.0) | Unified LLM API — Anthropic, OpenAI, Gemini, DeepSeek (implemented); Perplexity (stub). Streaming, retry, structured output, token normalization. |
| [`@diabolicallabs/agent-sdk`](packages/agent-sdk/) | scaffolded | Cost-tracking middleware wrapping llm-client. Async fire-and-forget ingestion to Agent Spend Dashboard. |
| [`@diabolicallabs/notion`](packages/notion/) | scaffolded | Notion REST API helpers — page creation, property serialization, conflict retry, rate-limit backoff. |
| [`@diabolicallabs/rate-limiter`](packages/rate-limiter/) | scaffolded | Redis sliding-window rate limiter. Sorted-set pipeline, fail-closed on Redis outage. |

See [`MODULES.md`](MODULES.md) for the full manifest index and build plan.

---

## Quick start

```bash
# .npmrc must point @diabolicallabs scope at GitHub Packages
echo "@diabolicallabs:registry=https://npm.pkg.github.com" >> .npmrc
echo "//npm.pkg.github.com/:_authToken=\${GITHUB_TOKEN}" >> .npmrc

pnpm add @diabolicallabs/llm-client
```

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
```

---

## Provider universe

| Provider | Status | Env var |
|---|---|---|
| `anthropic` | Implemented | `ANTHROPIC_API_KEY` |
| `openai` | Implemented | `OPENAI_API_KEY` |
| `google` | Implemented | `GOOGLE_AI_API_KEY` |
| `deepseek` | Implemented | `DEEPSEEK_API_KEY` |
| `perplexity` | Stub — throws `LlmError` | — |

The Perplexity stub throws an `LlmError` with a message listing all implemented providers and stating that Perplexity is planned for a future release.

---

## Repo layout

```
dlabs-toolkit/
  packages/
    llm-client/     @diabolicallabs/llm-client
    agent-sdk/      @diabolicallabs/agent-sdk
    notion/         @diabolicallabs/notion
    rate-limiter/   @diabolicallabs/rate-limiter
  scripts/
    integration-test.ts   manual API integration tests (not in CI)
  .changeset/       Changesets version files
  .github/
    workflows/
      ci.yml        typecheck + lint + build + test (Turbo)
      release.yml   Changesets release workflow → GitHub Packages
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

Pre-1.0 packages are currently distributed via **git tags + GitHub Releases**. No npm registry publish is active.

Each merged "Version Packages" PR triggers `changeset tag`, which creates a git tag (e.g. `@diabolicallabs/llm-client@0.1.0`) and a GitHub Release. Consume packages internally via workspace dependency or git URL until the npm registry path is ready.

**Planned (Week 4+):** Register `@diabolicallabs` org on npmjs.com, generate `NPM_TOKEN`, add to GitHub secrets, switch `release` script back to `changeset publish` targeting the default npm registry.

---

## License

TBD. Default state (no LICENSE file) = all rights reserved. © Diabolical Labs (Diana Ismail trading as Diabolical Labs).

---

## Maintainer

Diana Ismail · [diabolicallabs.studio](https://diabolicallabs.studio)
