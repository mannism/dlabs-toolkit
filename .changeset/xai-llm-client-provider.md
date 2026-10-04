---
'@diabolicallabs/llm-client': minor
---

Add the `xai` (Grok) provider with server-side tools.

- `createClient({ provider: 'xai', ... })` and `createClientFromEnv('xai', model)` (reads `XAI_API_KEY`). Built on the OpenAI Responses API at `https://api.x.ai/v1`; supports `complete`, `stream`, `structured`, `streamStructured` and `withTools`.
- Server-side tools via `providerOptions.serverTools` (typed `XaiServerTool[]`, camelCase): `xSearch`, `webSearch`, `codeInterpreter`, `fileSearch`, `mcp`, `imageGeneration`. Plus `providerOptions.maxToolCalls` and `providerOptions.inlineCitations`. Invalid tool configuration throws `LlmError({ kind: 'bad_request' })` before any network call.
- New optional response fields: `citations` (now populated for xai from `url_citation` annotations and `web_search_call` sources), `images`, `serverToolCalls` on `LlmResponse` / `LlmStructuredResponse` / `LlmToolResponse` and the final stream chunk.
- `LlmUsage` gains `serverToolUsage` and `providerReportedCostUsd` (xAI's own billed cost). `cost.serverTools` is priced through `@diabolicallabs/llm-pricing`.
- `xai` added to `LlmClientConfig.provider`, the pool's `PoolProvider`, and the capability matrix (`getModelCapabilities('xai', ...)`, new `'xai-effort'` reasoning-effort dialect).
- Peer dependency `@diabolicallabs/llm-pricing` raised to `^1.7.0` (server tool fees, long-context threshold on total prompt tokens).

All additions are optional; existing providers and callers are unaffected.
