# @diabolicallabs/llm-client — Migration Guide

## v0.x → v1.0.0

### Breaking change 1 — Refined `LlmErrorKind` taxonomy

#### What changed

Provider normalizers now emit specific `LlmErrorKind` values for HTTP status codes instead of the generic `'http'` kind. The `'http'` member is preserved as a residual fallback only, for unclassified 4xx errors (402, 405, 408, etc.).

#### Migration table

| Old check | New check | Notes |
|---|---|---|
| `err.kind === 'http' && err.retryable === true` | `err.kind === 'rate_limit' \|\| err.kind === 'server_error'` | 429 → `rate_limit`; 5xx → `server_error` |
| `err.kind === 'http' && err.statusCode === 429` | `err.kind === 'rate_limit'` | Direct kind check |
| `err.kind === 'http' && err.statusCode >= 500` | `err.kind === 'server_error'` | Direct kind check |
| `err.kind === 'http' && err.statusCode === 401` | `err.kind === 'auth'` | Also covers 403 |
| `err.kind === 'http' && err.statusCode === 403` | `err.kind === 'auth'` | Same kind as 401 |
| `err.kind === 'http' && err.statusCode === 404` | `err.kind === 'not_found'` | Wrong model name, etc. |
| `err.kind === 'http' && err.statusCode === 400` | `err.kind === 'bad_request'` | Schema/payload errors |

#### Before

```ts
try {
  await client.complete(messages);
} catch (err) {
  if (err instanceof LlmError) {
    // Old: regex or status-code checks
    if (err.kind === 'http' && err.retryable) {
      // handle retryable HTTP error (429, 5xx)
    } else if (err.statusCode === 401 || err.statusCode === 403) {
      // handle auth error
    }
  }
}
```

#### After

```ts
try {
  await client.complete(messages);
} catch (err) {
  if (err instanceof LlmError) {
    // New: branch directly on kind
    if (err.kind === 'rate_limit' || err.kind === 'server_error') {
      // handle retryable HTTP error
    } else if (err.kind === 'auth') {
      // handle 401 / 403
    } else if (err.kind === 'not_found') {
      // handle 404 — likely wrong model name
    } else if (err.kind === 'bad_request') {
      // handle 400 — check your schema / payload
    }
  }
}
```

#### Full taxonomy (v1.0.0)

| Kind | HTTP | Default retryable |
|---|---|---|
| `rate_limit` | 429 | yes |
| `server_error` | 5xx | yes |
| `timeout` | — | yes |
| `stream_stall` | — | no |
| `network` | — | yes |
| `auth` | 401, 403 | no |
| `not_found` | 404 | no |
| `bad_request` | 400 | no |
| `content_filter` | — | no |
| `context_length` | — | no |
| `tool_arguments_invalid` | — | no |
| `structured_parse_failed` | — | no |
| `cancelled` | — | no |
| `http` | unclassified 4xx | no |
| `unknown` | — | yes |

#### Known consumers requiring migration

- **GEOAudit** (`api/server.js`) — uses regex `/429|500|502|503|504|rate.?limit|server.?error/` on error messages. Migrate to `err.kind === 'rate_limit' || err.kind === 'server_error'`.
- **Labs EXP_009** — same regex pattern in `orchestrator.ts`. Will be migrated in the post-adoption brief (`brief-labs-exp009-toolkit-adoption.md`).

---

### Breaking change 2 — `LlmError.kind` is always defined (non-optional)

Previously `LlmError.kind` was typed `LlmErrorKind | undefined`. As of v1.0.0 it is always `LlmErrorKind`. Errors that previously had `kind: undefined` will now have `kind: 'unknown'`.

If your code checks `err.kind !== undefined` before branching, remove that guard.

---

### Note — `openai` SDK and `gpt-5.5` type gap

`openai@6.37.0` (the current pinned version) does not include `gpt-5.5` in the `ChatModel` typed union. The model exists and works at runtime via the `string & {}` escape hatch, but TypeScript autocomplete will not suggest it.

To type-safely target `gpt-5.5`, upgrade `openai` to the first SDK version that adds it to `ChatModel`. Check `npm show openai versions --json` to find that version — it was not available as of 2026-05-13. This constraint applies to the Chat Completions `ChatModel` type only; the Responses API's `ResponsesModel` union has the same gap.

---

### Breaking change 3 — OpenAI Responses API (Phase 2, pending)

The OpenAI provider will migrate from `chat.completions.create` to `responses.create` in v1.0.0 Phase 2. See Phase 2 PR for the full migration note covering:
- Structured output param: `response_format` → `text: { format: ... }`
- Streaming events: `choices[0].delta.content` → `ResponseTextDeltaEvent`
- Tool shape: nested `function` key → flat `FunctionTool`
