---
'@diabolicallabs/llm-client': major
---

BREAKING CHANGE: `LlmTool.inputSchema` type changed from `{ parse(d): unknown }` to `LlmToolSchema` discriminated union.

The old bare `{ parse: fn }` shape now throws `LlmError({ kind: 'tool_schema_invalid' })` at runtime with a migration message. Previously, a bare `{ parse: fn }` object would silently serialize to `{}` (functions strip in JSON.stringify), causing Anthropic to reject the tool call with a 400 error.

## Migration

**Zod schema:**
```ts
// Before
{ parse: (d) => mySchema.parse(d) }

// After
{ kind: 'zod', schema: z.object({ ... }) }
```

**JSON Schema + optional validation:**
```ts
// Before (the labs exp_009 workaround)
Object.assign({ parse: (d) => d }, t.parameters)

// After
{ kind: 'jsonSchema', schema: { type: 'object', ... }, validate?: fn }
```

**JSON Schema, no validation:**
```ts
{ kind: 'jsonSchema', schema: { type: 'object', ... } }
```

Worked example: see `labs/exp_009` adapters (brief-llm-client-v5-tool-schema-migration).

## New additions
- `LlmToolSchema` type — exported from package root
- `tool_schema_invalid` error kind (not retryable) — thrown when `inputSchema` has no recognized `kind` field
- All four providers updated with exhaustive `switch` on `kind`; TypeScript will error if a third `kind` is added without updating the switch
