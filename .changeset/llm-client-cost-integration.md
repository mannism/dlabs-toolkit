---
"@diabolicallabs/llm-client": minor
---

Optional per-response cost computation via @diabolicallabs/llm-pricing. Pass `pricing: { computeOnEveryCall: true }` to `createClient()` to attach `cost?: LlmCost` on every `complete()`, `structured()`, and `withTools()` response. Requires the optional peer dep `@diabolicallabs/llm-pricing@^0.1.0`. Consumers who don't configure pricing see no cost field and incur no import overhead.
