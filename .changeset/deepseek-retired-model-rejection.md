---
"@diabolicallabs/llm-client": patch
---

fix(deepseek): reject retired deepseek-chat/deepseek-reasoner client-side instead of forwarding a doomed request

DeepSeek fully retired the `deepseek-chat` and `deepseek-reasoner` model IDs on
2026-07-24 15:59 UTC with no fallback alias — calls using either string already
errored at DeepSeek's API. `capabilities.ts` still listed both as live, routable
capability entries, so callers sailed past validation and got forwarded to a
guaranteed failure with no client-side signal of why.

Calling `complete()`, `stream()`, `structured()`, `withTools()`, or
`streamStructured()` with `model: 'deepseek-chat'` or `model: 'deepseek-reasoner'`
(as a config default or a per-call override) now throws
`LlmError({ kind: 'bad_request', retryable: false })` immediately — before any HTTP
call reaches DeepSeek — naming the retired ID and pointing to `deepseek-v4-flash`
as the replacement. Both IDs are removed from the capability matrix;
`getModelCapabilities('deepseek', 'deepseek-chat' | 'deepseek-reasoner')` now
returns `null` (unknown model) instead of a stale live descriptor.

**Design decision: reject, don't auto-remap.** Silently rerouting `deepseek-chat`
to `deepseek-v4-flash` would change which model actually serves the request
without the caller knowing — a silent behavior/cost change, not a fix.

**Patch, not minor:** this is a bug fix, not new API surface. The underlying
behavior was already broken (every call to either ID already failed at
DeepSeek's API) — this PR moves the failure point from "silent error deep in a
provider SDK call" to "immediate, clearly-worded client-side rejection." No new
exported functions or types; `getModelCapabilities` returning `null` instead of
a descriptor for two already-dead model IDs is a correction of stale data, not a
behavior contract change any caller could have been relying on productively.

Consumers still passing `deepseek-chat` or `deepseek-reasoner` (these IDs have
been non-functional since 2026-07-24 regardless of this change) must migrate to
`deepseek-v4-flash` or `deepseek-v4-pro`.
