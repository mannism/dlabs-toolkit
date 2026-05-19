# MODULES.md — dlabs-toolkit Package Index

Module manifest index for the dlabs-toolkit monorepo. Each row points to the package's `manifest.yaml` for the full contract: exports, dependencies, consumers, failure modes, and performance notes.

Schema: [`/Users/mann/Documents/Claude/manifest-schema.md`](https://github.com/mannism/dlabs-toolkit)

---

| Package | Status | Version | Path | Description |
|---|---|---|---|---|
| `@diabolicallabs/llm-client` | published | 4.0.0 | [`packages/llm-client/manifest.yaml`](packages/llm-client/manifest.yaml) | Unified LLM API — all 5 providers. Native tool calling (`withTools`), full `LlmErrorKind` taxonomy, OpenAI Responses API, Gemini structured-output fix, native strict structured outputs (Zod 4), per-call timeouts/AbortSignal/stream stall, web-grounded citations (Perplexity), `providerOptions` escape hatch, opt-in Anthropic prompt caching, configurable retry + provider failover, pool/semaphore, `streamStructured()`, `getModelCapabilities()`, `linkedAbortController`, pre-call `LlmHooks` API, optional per-response cost via `@diabolicallabs/llm-pricing`, remote pricing table via `pricing.remoteUrl`. |
| `@diabolicallabs/llm-pricing` | published | 1.1.0 | [`packages/llm-pricing/manifest.yaml`](packages/llm-pricing/manifest.yaml) | Default pricing table + `computeCost()` for all 5 providers. Long-context tiering (Gemini), cache math (Anthropic), deprecated-alias resolution (DeepSeek), partial-coverage flags (o-series, sonar-deep-research). `versionedAt` field + `pnpm pricing:verify` script. Remote fetch via `fetchRemoteTable`. Pluggable `PricingLogger` with stdout JSON default (`setPricingLogger()`). |
| `@diabolicallabs/agent-sdk` | published | 3.0.5 | [`packages/agent-sdk/manifest.yaml`](packages/agent-sdk/manifest.yaml) | Cost-tracking middleware wrapping llm-client. Async fire-and-forget ingestion to Agent Spend Dashboard. Wraps `withTools()` + `toolCalls` on `CallRecord`. Uniform `afterCall` dispatch across all call types. Cost included in `CallRecord` when provided by llm-client. `LlmCost` type inlined (no llm-pricing peer-dep). |
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
| Prompt cache | `@diabolicallabs/llm-client@0.4.3` — opt-in Anthropic prompt caching via `providerOptions.promptCache: 'ephemeral'`; system block + tool definition; `cacheCreationTokens`/`cacheReadTokens` coverage | ✅ shipped 2026-05-11 (PR #48) |
| llm-client@1.0.0 stable | Breaking: OpenAI Responses API migration, full `withTools()` call type, expanded `LlmErrorKind` HTTP taxonomy (`rate_limit`, `auth`, `not_found`, `bad_request`, `content_filter`) | ✅ shipped 2026-05-13 (PR #61, #65, #66) |
| llm-pricing scaffold + cost wiring (Wave 2a) | `@diabolicallabs/llm-pricing@0.1.0` — default pricing table, `computeCost()`, 5-provider coverage; optional per-response cost wired into `llm-client@1.1.0` and `agent-sdk@1.1.0` | ✅ shipped 2026-05-13 (PR #70, #71, #73, #75) |
| Retry/failover/pool/streamStructured (Wave 2b) | `llm-client@1.2.0` — configurable retry with exponential backoff + jitter, provider failover; `llm-client@1.2.0` pool/semaphore (`@diabolicallabs/llm-client/pool`); `llm-client@1.3.0` `streamStructured()` — token streaming + Zod-validated output | ✅ shipped 2026-05-13 (PR #77, #80, #82, #83) |
| Wave 3a — capabilities/linked abort/response IDs | `llm-client@1.4.0` — `getModelCapabilities()` provider capability matrix; `linkedAbortController` fan-out with root signal + per-call timeouts; `id` + `idSource` on all response types | ✅ shipped 2026-05-13 (PR #85, #86, #87, #89) |
| Wave 3b — hooks + agent-sdk@2.0.0 | `llm-client@1.5.0` pre-call `LlmHooks` API; `llm-client@1.6.0` usage propagation in `LlmAfterCallContext` for all 5 call types; `agent-sdk@2.0.0` (breaking) — deleted retained stream wrappers, uniform `afterCall` dispatch | ✅ shipped 2026-05-13/14 (PR #90, #94, #95, #97) |
| Remote pricing + llm-client@1.7.0 | `llm-pricing@0.2.0` — `pricing/table.json` as canonical remote source, `fetchRemoteTable()` opt-in remote fetch; `llm-client@1.7.0` — `pricing.remoteUrl` option wired into `createClient` | ✅ shipped 2026-05-14 (PR #98, #99, #100, #101) |
| agent-sdk@3.0.x — peer-dep repair | `agent-sdk@3.0.0` — remove `llm-pricing` peer-dep, inline `LlmCost` type to prevent peer-cascade major bumps | ✅ shipped 2026-05-14 (PR #103, #105, #106) |
| llm-pricing model coverage + llm-client@2.0.0 cascade | `llm-pricing@0.3.0` — date-strip fallback for dated model IDs, 13 missing model entries; `llm-client@2.0.0` (peer-dep cascade from llm-pricing minor boundary crossing) | ✅ shipped 2026-05-17 (PR #108, #109) |
| llm-pricing GPT-5 family + graduation to 1.0.0; llm-client@3.0.0 cascade | `llm-pricing@0.4.0` — gpt-5.1/5.2/5.3 family + codex variants; `llm-pricing@1.0.0` — semver stable graduation, `llm-client` peer-dep updated; `llm-client@3.0.0` (cascade) | ✅ shipped 2026-05-18 (PR #114, #116, #117) |
| llm-pricing@1.1.0 pluggable logger; llm-client@4.0.0 cascade | `llm-pricing@1.1.0` — `setPricingLogger()` escape hatch, pluggable `PricingLogger` interface, stdout JSON default (Railway-friendly); `llm-client@4.0.0` + `agent-sdk@3.0.3` (cascade) | ✅ shipped 2026-05-19 (PR #119, #120) |
| Week 5 (packages) | `@diabolicallabs/notion` + `@diabolicallabs/rate-limiter` (parallel) | not yet briefed |
| Week 6+ | GEOAudit pilot migration; Trusted Publishing migration on npm | scoped, not briefed |
