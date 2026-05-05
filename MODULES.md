# MODULES.md — dlabs-toolkit Package Index

Module manifest index for the dlabs-toolkit monorepo. Each row points to the package's `manifest.yaml` for the full contract: exports, dependencies, consumers, failure modes, and performance notes.

Schema: [`/Users/mann/Documents/Claude/manifest-schema.md`](https://github.com/mannism/dlabs-toolkit)

---

| Package | Status | Path | Description |
|---|---|---|---|
| `@diabolicallabs/llm-client` | in-progress | [`packages/llm-client/manifest.yaml`](packages/llm-client/manifest.yaml) | Unified LLM API — Anthropic (impl), OpenAI (impl), Gemini/DeepSeek/Perplexity (stubs). Streaming, retry, structured output, token normalisation. |
| `@diabolicallabs/agent-sdk` | scaffolded | [`packages/agent-sdk/manifest.yaml`](packages/agent-sdk/manifest.yaml) | Cost-tracking middleware wrapping llm-client. Fire-and-forget ingestion to Agent Spend Dashboard. |
| `@diabolicallabs/notion` | scaffolded | [`packages/notion/manifest.yaml`](packages/notion/manifest.yaml) | Notion REST API helpers — page creation, property serialisation, conflict retry, rate-limit backoff. |
| `@diabolicallabs/rate-limiter` | scaffolded | [`packages/rate-limiter/manifest.yaml`](packages/rate-limiter/manifest.yaml) | Redis sliding-window rate limiter. Sorted-set pipeline, fail-closed on Redis outage. |

---

## Status key

| Status | Meaning |
|---|---|
| `scaffolded` | Types and public API surface defined. Implementation stub in place. Not yet functional. |
| `in-progress` | Implementation underway. Not yet production-ready. |
| `published` | At least one version released to GitHub Packages. |
| `stable` | v0.1.0+ released, GEOAudit pilot migration complete, CI green for 30 consecutive days. |
| `deprecated` | Superseded. Pin to last version; no new features. |

## Build plan

| Package | Implementation week |
|---|---|
| `@diabolicallabs/llm-client` — Anthropic + OpenAI | Week 2 |
| `@diabolicallabs/llm-client` — Google + DeepSeek + `@next` release | Week 3 |
| `@diabolicallabs/agent-sdk` | Week 4 |
| `@diabolicallabs/notion` + `@diabolicallabs/rate-limiter` | Week 5 (parallel) |
| GEOAudit pilot migration | Week 6 |
