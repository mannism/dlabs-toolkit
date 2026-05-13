---
"@diabolicallabs/llm-client": minor
---

feat(llm-client): linkedAbortController helper — fan-out with root signal + per-call timeouts (Wave 3a §3.3)

Adds `linkedAbortController(parentSignal, { timeoutMs? }): LinkedAbortHandle` — a consumer-facing
utility for parallel call patterns where a root signal cancels all in-flight calls and individual
calls have their own per-call timeouts.

Behaviour:
- Parent abort forwards immediately to the child, preserving the parent's abort reason.
- If the parent is already aborted when linkedAbortController() is called, the child aborts
  synchronously (before any API call is made).
- Optional `timeoutMs` starts an independent timer that aborts the child after the elapsed time
  with a timeout reason string. Fires independently of the parent.
- `dispose()` removes the parent listener and clears the timer without aborting the child.
  Call in the `finally` block of the consuming call to prevent listener leaks.
- `abort()` aborts the child immediately and calls `dispose()`.

Returns `{ signal, abort, dispose }`. Pass `signal` to `client.complete()`, `client.stream()`, etc.
