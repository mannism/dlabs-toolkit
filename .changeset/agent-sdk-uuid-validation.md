---
"@diabolicallabs/agent-sdk": minor
---

`instrumentClient()` now validates `identity.agentId` and `identity.projectId` as RFC 4122 UUIDs at call time — invalid values emit a `console.warn` naming the malformed field(s) and flip the client to no-op mode instead of silently dispatching records that the dashboard rejects.
