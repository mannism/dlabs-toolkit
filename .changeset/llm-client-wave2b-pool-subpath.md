---
"@diabolicallabs/llm-client": minor
---

feat(llm-client): concurrency pool at @diabolicallabs/llm-client/pool sub-path (Wave 2b)

New export: `createPool(config)` — returns a `Pool` instance for managing parallel LLM
call workloads with per-provider concurrency and optional rate limiting.

**API:**
- `createPool({ concurrencyPerProvider?, rateLimitPerProvider? })` — configure per-provider
  semaphore caps (e.g. `{ anthropic: 4, gemini: 2 }`) and optional rolling-window rpm limits.
- `pool.runAll(tasks, { signal?, onProgress? })` — run all tasks concurrently within the
  configured caps. Returns `PoolResult<T>[]` in input order. Individual task errors are
  captured as `{ status: 'rejected' }` — pool always resolves.
- `PoolResult<T>`: `'fulfilled' | 'rejected' | 'aborted'` discriminated union.
- AbortSignal support: pending tasks are skipped when the signal fires.

**Motivation:** EXP_009 (agentic-reliability benchmark) sends 45 parallel calls
(15 tasks × 3 providers) and hand-rolled its own semaphore in `orchestrator.ts`.
The pool primitive replaces that boilerplate and is available to all toolkit consumers.
