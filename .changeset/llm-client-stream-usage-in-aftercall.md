---
"@diabolicallabs/llm-client": minor
---

Streaming usage in afterCall context (v1.6.0): `LlmAfterCallContext` now carries a `usage?: LlmUsage` field populated for all five call types. Non-streaming paths (complete, structured, withTools) mirror `response.usage`. Streaming paths accumulate usage from the terminal chunk (`stream`) or the `done` event (`streamStructured`). This unblocks agent-sdk's stream/streamStructured wrappers from needing to maintain their own generators for usage capture.
