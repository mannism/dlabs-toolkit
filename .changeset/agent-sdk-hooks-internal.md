---
"@diabolicallabs/agent-sdk": minor
---

Internal refactor (v1.4.0): non-streaming paths now use a shared `buildAfterCallHandler()` instead of bespoke per-method closures. `stream()` and `streamStructured()` wrappers retained for usage capture. Public API unchanged.
