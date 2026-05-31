# dlabs-toolkit

Shared platform infrastructure for the Diabolical Labs and Diana Ismail project fleet. pnpm + Turborepo monorepo of independently-versioned TypeScript packages consumed by multiple downstream repos.

For fleet-wide standards (TypeScript, security, git workflow, PR comprehension gate, language policy), see `~/AGENTS.md`.

## Stack

- Node ≥ 20, pnpm ≥ 9
- TypeScript strict, ESM-only
- Turborepo (`turbo run build|typecheck|lint|test`)
- Biome (format + lint, alongside ESLint + `@typescript-eslint`)
- Changesets — independent versioning per package
- Vite (where packages need a bundler)

## Packages

`packages/` — each independently versioned and published under the `@diabolicallabs/*` npm scope:

- `agent-sdk` — instrumentation client for cross-project cost/usage telemetry (consumed by FitChecker, GEOAudit, etc.)
- `llm-client` — provider-agnostic LLM client (OpenAI, Anthropic, Gemini, Perplexity); retries, structured outputs, prompt caching, streaming
- `llm-pricing` — pricing tables + cost computation
- `notifier-core` — notification primitives
- `notion` — Notion API helpers
- `rate-limiter` — sliding-window rate limiter
- `slack` — Slack Bolt wrapper
- `telegram` — Telegram Bot wrapper

## Commands

```bash
pnpm install
pnpm run build       # turbo run build across all packages
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run format      # biome format --write .
pnpm run check       # biome check --write .

# Changesets
pnpm changeset            # create a changeset entry
pnpm version-packages     # bump versions from queued changesets
pnpm release              # build + changeset publish
```

## Conventions

- **TypeScript strict.** No `any`, no implicit `any`, no unused locals/params.
- **ESM-only.** Modern Node (≥ 20) and modern bundlers only. No CJS dual-publish.
- **US English** in docs, code identifiers, and copy. Per `/Users/mann/Documents/Claude/decisions.md` (2026-05-04): dlabs-toolkit and `@diabolicallabs` packages are commercial-surface infrastructure, not personal-brand. Use `normalize`, `serialize`, `color`, `behavior`, `analyze` — not the `-ise`/`-our` UK variants. Applies to function names, variable names, JSDoc, error messages, READMEs, and all public API surface.
- **Independent versioning per package** via Changesets. Semver discipline mandatory.
- **No package ships without tests.**
- **Manifest files per package** following the global manifest schema at `/Users/mann/Documents/Claude/manifest-schema.md`.

## Brand and legal

- **Published under:** Diabolical Labs (Diana Ismail's sole proprietor trade name).
- **Copyright footer:** "© Diabolical Labs" for package metadata; "© Diana Ismail trading as Diabolical Labs" for contract-grade artefacts.
- **License:** [MIT](LICENSE) (adopted 2026-05-06). Single canonical `LICENSE` at monorepo root. Each `package.json` carries `"license": "MIT"`. New packages default to MIT unless their own brief explicitly overrides.

## Repo-specific gotchas

- **Root `package.json` `"license"` is `"UNLICENSED"` (private), while each published `package.json` is `"MIT"`.** The root is private (the monorepo isn't published); the packages are MIT-licensed for downstream consumption. Don't "fix" the root to match.
- **Changesets are the only way to bump a version.** Do not edit `package.json` `"version"` by hand.
- **`@diabolicallabs/*` scope is registered on npm.** Publishing requires the appropriate npm auth — no workarounds.
- **Some packages have downstream callers in private repos** (FitChecker, GEOAudit, labs). Breaking changes need at least one cycle of downstream coordination — flag in the Changeset.

## Testing

No fleet tier currently assigned. Apply per-package judgement; new packages must ship with tests, and Turborepo-level `pnpm run test` should always be green before publishing.

## Where things live

- Platform brief and design docs: `/Users/mann/Documents/Claude/proj-plan/dlabs-toolkit/`
- Cross-project decisions affecting this repo: `/Users/mann/Documents/Claude/decisions.md`

## Related projects

- **Agent Spend Dashboard** (first commercial consumer): `proj-plan/agent-spend-dashboard/`
- **Experiential Brief Generator** (private commercial): `proj-plan/experiential-brief-generator/`
- **FitCheckerApp**, **GEOAudit**, **labs** — current downstream consumers of `@diabolicallabs/llm-client` + `@diabolicallabs/agent-sdk`

## See also

- `~/AGENTS.md` — fleet-wide standards
- `CLAUDE.md` — Claude-Code-specific layers
- `README.md` — human-facing overview, current status, install instructions
- `MODULES.md` — module manifest index
