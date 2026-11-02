---
'@diabolicallabs/llm-client': major
---

feat!: upgrade `@anthropic-ai/sdk` 0.135 to ^1.3.0. BREAKING for Anthropic callers that pass `temperature`.

SDK 1.x pins Anthropic API version 2026-10-21, which removes `temperature`, `top_p` and `top_k` (HTTP 400 on every model). For Anthropic calls, `temperature` from `LlmCallOptions` or `LlmClientConfig` is no longer sent: it is dropped and a single `anthropic_sampling_param_dropped` warning is logged through the toolkit logger once per process per model. Calls succeed with the model's default sampling, so a configured temperature silently stops taking effect on models that previously honored it (Claude 4.6 and older). `temperature` remains on the public types for the other providers; `top_p` / `top_k` were never exposed.

Downstream coordination: `brand-compliance-saas` passes `temperature` to Anthropic at `packages/module-brand-compliance/src/lib/review/anthropic-adapter.ts:391` and `packages/platform-core/src/app/api/admin/settings/verify-model/route.ts:103`; it should stop passing it for Anthropic models. See MIGRATION.md (v6.x to v7.0.0). Every publish auto-propagates to GEOAudit on caret: run the 6-provider smoke gate and confirm GEOAudit's range before merging the version PR.
