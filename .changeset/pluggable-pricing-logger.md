---
'@diabolicallabs/llm-pricing': minor
---

Add pluggable `PricingLogger` for diagnostic events; default routes structured JSON to stdout.

**Why.** `console.warn` writes to stderr, and Railway (plus most stream-classifying log ingesters) labels every stderr line as `severity: error`. The date-strip fallback path is a successful pricing resolution — emitting it as a "warning" produced 20–40 false errors per day across Railway-hosted consumers. Hard-coding a JSON-to-stdout format inside the library would solve that for Railway but force the choice on CLI/dev consumers who want human-readable stderr.

**What.**

- New `setPricingLogger(logger | null)` export and `PricingLogger` type. Pass an implementation to integrate with your app logger (pino, winston, Datadog, OpenTelemetry); pass `null` to restore the default.
- New default logger emits `console.log(JSON.stringify({ level: 'warn', event, ...data }))` — structured JSON, written to stdout. Railway and similar ingesters classify by the `level` field, not by stream.
- Four stable event names: `pricing_deprecated_alias`, `pricing_date_strip_fallback`, `pricing_unknown_model`, `pricing_fetch_failed`. Payload shapes documented in the README.

**Behavior change to flag.**

- The `fetchRemoteTable` fail event was previously emitted with `event: 'llm_pricing_fetch_failed'`. It is now `pricing_fetch_failed` (aligned with the rest of the namespace). Update any log alerts or dashboards keyed on the old name.
- All four diagnostic types now land on **stdout** instead of stderr. Tooling that grep'd stderr to surface llm-pricing warnings should switch to grepping the event names, or call `setPricingLogger()` to route back to stderr.

No code-change required for consumers. Existing callers automatically benefit from the Railway-friendly default after upgrade.
