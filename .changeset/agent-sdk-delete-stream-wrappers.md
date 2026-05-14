---
"@diabolicallabs/agent-sdk": major
---

Architecture-migration complete (v2.0.0): stream() and streamStructured() bespoke usage-capture wrappers deleted from sdk.ts. All 5 call types now flow through a single buildAfterCallDispatch() function — no per-method ingestion closures remain. Public API unchanged. Requires llm-client@^1.6.0 (usage now surfaced in LlmAfterCallContext for streaming paths).

BREAKING CHANGE: agent-sdk@2.0.0 completes the hooks-internal architecture migration from v1.4.0. Stream() and streamStructured() wrappers in sdk.ts are deleted; all 5 call types now flow uniformly through llm-client's afterCall hook. Public API unchanged. Peer-dep bumps to llm-client@^1.6.0 (required for usage in LlmAfterCallContext on streaming paths).
