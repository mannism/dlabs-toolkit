---
'@diabolicallabs/llm-client': patch
---

Pin the Gemini client to `apiVersion: 'v1beta'`. `@google/genai` 3.x changed the Developer API default from `v1beta` to `v1`, which rejects JSON mode and made `structured()` fail with HTTP 400 ("JSON mode is not enabled for api version v1"). This pins the pre-3.x default.
