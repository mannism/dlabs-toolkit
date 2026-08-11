---
"@diabolicallabs/agent-sdk": minor
---

Add `CallRecord.provider`, an optional `LlmProvider` field always populated from the wrapped `LlmClient`'s `config.provider` — a required, `readonly`-enforced, construction-time-invariant field on the client, not inferred from the model string. `buildAfterCallDispatch()` now takes a `provider` parameter bound once per `instrumentClient()` call, and `buildCallRecord()`'s seven positional parameters have been converted to a single options object (both are module-private, so this is not a public API change).

This makes the SDK the authoritative provider source for the Agent Spend Dashboard's ingest resolution chain (`record.provider ?? resolveProviderFromModel(record.model) ?? agent.provider ?? null`), which already accepts the field (PR #44) and requires no changes on the Dashboard side to pick it up — any consumer upgrading to `@diabolicallabs/agent-sdk@^3.3.0` starts sending `provider` automatically.

This is additive only — `provider` is optional on `CallRecord`, and `AgentSdkConfig`'s public shape is unchanged, so no caller needs to pass anything new. **Downstream flag:** once a consumer upgrades, `record.provider` takes unconditional priority over the Dashboard's `resolveProviderFromModel()` fallback in its resolution chain. Since the value is read straight from a required, readonly, construction-time-invariant field rather than inferred or user-supplied, the risk of a wrong-but-valid value silently mis-pricing a call is low, but it is the same failure class Dashboard PR #44 closed off on the ingest side — now reachable, in principle, from the client side too.
