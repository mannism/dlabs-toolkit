---
'@diabolicallabs/llm-client': minor
---

feat(llm-client): pluggable LlmClientLogger with stdout JSON default

Adds a `setLlmClientLogger(logger | null)` escape hatch and `LlmClientLogger`
type to `@diabolicallabs/llm-client`, mirroring the `setPricingLogger` pattern
shipped in `@diabolicallabs/llm-pricing@1.1.0`.

**New public API:**
- `setLlmClientLogger(logger: LlmClientLogger | null): void` — swap the
  package's diagnostic logger at bootstrap. Pass `null` to reset to the default.
- `LlmClientLogger` interface: `{ warn: (event: string, data: Record<string, unknown>) => void }`

**Behavior change (stdout vs stderr):**
All diagnostic `console.warn` / `console.info` / `console.log` calls in
`packages/llm-client/src/client.ts` and `hooks.ts` now route through the
pluggable logger. The default logger writes structured JSON to **stdout**
(not stderr) so log ingesters that classify severity by stream (Railway, many
GCP/AWS routers) see these as info, not error.

**Stable event names emitted (consumers may key alerts on these):**
- `pricing_source` — emitted at `createClient()` init when `pricing` config is
  set. Payload: `{ source: 'bundled' | 'consumer_override' | 'remote' | 'cache' | 'fallback', url?, fetchedAt?, error? }`
- `pricing_peer_dep_missing` — `@diabolicallabs/llm-pricing` not installed but
  `pricing` config is set. Payload: `{ message }`
- `model_fallback` — primary model rejected; next model in the array served the
  call. Payload: `{ level: 'info', from, to, reason }` where `reason` is an `LlmErrorKind`.
- `aftercall_hook_error` — `afterCall` hook threw; error was dropped to protect
  the caller. Payload: `{ callType, model, message }`

**Migration:** No consumer migration required. The API is additive — new exports
only. Consumers that previously relied on `console.warn` output from this package
landing on stderr should call `setLlmClientLogger({ warn: (event, data) => console.warn(JSON.stringify({ event, ...data })) })` once at bootstrap to restore stderr routing.
