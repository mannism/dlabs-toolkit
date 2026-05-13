# MODULES.md — dlabs-toolkit Package Index

Module manifest index for the dlabs-toolkit monorepo. Each row points to the package's `manifest.yaml` for the full contract: exports, dependencies, consumers, failure modes, and performance notes.

Schema: [`/Users/mann/Documents/Claude/manifest-schema.md`](https://github.com/mannism/dlabs-toolkit)

---

| Package | Status | Version | Path | Description |
|---|---|---|---|---|
| `@diabolicallabs/llm-client` | published | 1.0.0 | [`packages/llm-client/manifest.yaml`](packages/llm-client/manifest.yaml) | Unified LLM API — all 5 providers. Native tool calling (`withTools`), full `LlmErrorKind` taxonomy, OpenAI Responses API, Gemini structured-output fix, native strict structured outputs (Zod 4), per-call timeouts/AbortSignal/stream stall, web-grounded citations (Perplexity), `providerOptions` escape hatch, opt-in Anthropic prompt caching. |
| `@diabolicallabs/llm-pricing` | published | 0.1.0 | [`packages/llm-pricing/manifest.yaml`](packages/llm-pricing/manifest.yaml) | Default pricing table + `computeCost()` for all 5 providers. Long-context tiering (Gemini), cache math (Anthropic), deprecated-alias resolution (DeepSeek), partial-coverage flags (o-series, sonar-deep-research). `versionedAt` field + `pnpm pricing:verify` script. |
| `@diabolicallabs/agent-sdk` | published | 1.0.0 | [`packages/agent-sdk/manifest.yaml`](packages/agent-sdk/manifest.yaml) | Cost-tracking middleware wrapping llm-client. Async fire-and-forget ingestion to Agent Spend Dashboard. Wraps `withTools()` + `toolCalls` on `CallRecord`. |
| `@diabolicallabs/notion` | scaffolded | 0.0.2 | [`packages/notion/manifest.yaml`](packages/notion/manifest.yaml) | Notion REST API helpers — page creation, property serialization, conflict retry, rate-limit backoff. |
| `@diabolicallabs/rate-limiter` | scaffolded | 0.0.2 | [`packages/rate-limiter/manifest.yaml`](packages/rate-limiter/manifest.yaml) | Redis sliding-window rate limiter. Sorted-set pipeline, fail-closed on Redis outage. |

All packages live on **npmjs.com** under the public `@diabolicallabs` scope. Licensed [MIT](LICENSE).

---

## Status key

| Status | Meaning |
|---|---|
| `scaffolded` | Types and public API surface defined. Implementation stub in place. Not yet functional. |
| `in-progress` | Implementation underway. Not yet production-ready. |
| `published` | At least one version released to npmjs.com under the `@diabolicallabs` scope. |
| `stable` | v1.0.0+ released, GEOAudit pilot migration complete, CI green for 30 consecutive days. |
| `deprecated` | Superseded. Pin to last version; no new features. |

## Build plan

| Wave | Scope | Status |
|---|---|---|
| Week 1 | Monorepo scaffold (4 packages, Turborepo, Changesets, CI) | ✅ shipped 2026-05-03 (PR #1) |
| Week 2 | `@diabolicallabs/llm-client` Anthropic + OpenAI | ✅ shipped 2026-05-05 (PR #9) |
| Week 3 | `@diabolicallabs/llm-client` Gemini + DeepSeek | ✅ shipped 2026-05-06 (PR #10) |
| Week 4 | `@diabolicallabs/agent-sdk` `instrumentClient()` | ✅ shipped 2026-05-06 (PR #21) |
| Week 5 (Perplexity) | `@diabolicallabs/llm-client` Perplexity provider — citations, providerOptions | ✅ shipped 2026-05-08 (PR #30) |
| Abort/timeout/stall | `@diabolicallabs/llm-client@0.3.0` — per-call `timeoutMs`, `AbortSignal`, stream stall detection, `LlmError.kind` discriminator | ✅ shipped 2026-05-10 (PR #34) |
| Structured-strict | `@diabolicallabs/llm-client@0.4.0` — native strict structured outputs (OpenAI `json_schema`, Anthropic tool-use, Gemini `responseSchema`); Zod 4 conversion; `LlmStructuredResponse` gains `model`/`id`/`citations` | ✅ shipped 2026-05-10 (PR #35) |
| Prompt cache | `@diabolicallabs/llm-client@0.4.3` — opt-in Anthropic prompt caching via `providerOptions.promptCache: 'ephemeral'`; system block + tool definition; `cacheCreationTokens`/`cacheReadTokens` coverage | ✅ shipped 2026-05-11 (PR #43) |
| Week 5 (packages) | `@diabolicallabs/notion` + `@diabolicallabs/rate-limiter` (parallel) | not yet briefed |
| Week 6+ | GEOAudit pilot migration; Trusted Publishing migration on npm | scoped, not briefed |
