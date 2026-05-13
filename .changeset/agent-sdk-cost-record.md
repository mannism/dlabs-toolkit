---
"@diabolicallabs/agent-sdk": minor
---

feat(agent-sdk): include cost in CallRecord when provided by llm-client

CallRecord gains an optional `cost?: LlmCost` field (v1.1.0). When the wrapped LlmClient
has `pricing` configured (via `@diabolicallabs/llm-client@^1.1.0`), cost is propagated
from the response into the ingestion payload for `complete()`, `structured()`, and
`withTools()`. Stream calls do not carry cost — there is no single response object to
attach it to.

`@diabolicallabs/llm-pricing` is declared as an optional peer dependency.
