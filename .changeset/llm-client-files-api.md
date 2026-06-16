---
"@diabolicallabs/llm-client": minor
"@diabolicallabs/agent-sdk": patch
---

feat(llm-client): Files API — video and large-file inputs (v5.1.0)

Adds a `client.files` namespace to every `LlmClient` instance for uploading binary
assets to the provider's file store and referencing them in messages.

**New public surface:**
- `LlmFileMediaType` — MIME type union for uploadable files (`video/*`, `image/*`, `application/pdf`)
- `LlmFileState` — `'processing' | 'active' | 'failed'`
- `LlmFileRef` — provider-neutral file reference with id, provider, mediaType, sizeBytes, state, expiresAt?
- `LlmFilesApi` — upload / refresh / waitForActive / delete namespace
- `LlmContentBlock` — extended with `{ type: 'file'; ref: LlmFileRef }` variant
- `LlmClient.files` — `LlmFilesApi` namespace on every client instance

**Provider support:**
- **Gemini** — full: video/*/image/*/PDF upload, async state poll (PROCESSING → ACTIVE), fileData parts in messages
- **OpenAI** — PDF only via `input_file.file_id`; `purpose: 'user_data'` with `'assistants'` fallback; video/image rejects `bad_request`
- **Anthropic** — PDF + image/* via Files beta (`betas: ['files-api-2025-04-14']`); video rejects `bad_request`
- **DeepSeek / Perplexity** — `bad_request` stubs (no Files API)

**Cross-provider safety:** A `file` block whose `ref.provider` does not match the receiving provider hard-rejects pre-flight with `bad_request`. Refs are not portable across providers.

**Error taxonomy:** All file errors map to existing `LlmErrorKind` values — no new kind added.

**No breaking changes.** v5.0.0 callers using `text | image | document` blocks are unaffected. This also fixes the manifest's stale "15-kind LlmError taxonomy" count → 16 (pre-existing drift from when `stream_stall` was added).

**Consumer migration (brand-compliance-saas):** deferred to a separate consumer brief filed post-publish.

**agent-sdk patch:** adds `files` passthrough on `InstrumentedLlmClient` to forward the new `client.files` namespace from llm-client v5.1.0. File operations bypass instrumentation (no CallRecord — correct, since uploads are not LLM calls).
