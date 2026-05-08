# MODULES.md — dlabs-toolkit Package Index

Module manifest index for the dlabs-toolkit monorepo. Each row points to the package's `manifest.yaml` for the full contract: exports, dependencies, consumers, failure modes, and performance notes.

Schema: [`/Users/mann/Documents/Claude/manifest-schema.md`](https://github.com/mannism/dlabs-toolkit)

---

| Package | Status | Version | Path | Description |
|---|---|---|---|---|
| `@diabolicallabs/llm-client` | published | 0.2.0 | [`packages/llm-client/manifest.yaml`](packages/llm-client/manifest.yaml) | Unified LLM API — all 5 providers implemented. Perplexity: web-grounded responses, citations, providerOptions search filters. Streaming, retry, structured output, token normalization. |
| `@diabolicallabs/agent-sdk` | published | 0.1.1 | [`packages/agent-sdk/manifest.yaml`](packages/agent-sdk/manifest.yaml) | Cost-tracking middleware wrapping llm-client. Async fire-and-forget ingestion to Agent Spend Dashboard. |
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
| Week 5 (Perplexity) | `@diabolicallabs/llm-client` Perplexity provider — citations, providerOptions | ✅ shipped 2026-05-08 (PR #TBD) |
| Week 5 (packages) | `@diabolicallabs/notion` + `@diabolicallabs/rate-limiter` (parallel) | not yet briefed |
| Week 6+ | GEOAudit pilot migration; Trusted Publishing migration on npm | scoped, not briefed |
