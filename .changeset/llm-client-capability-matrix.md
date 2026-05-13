---
"@diabolicallabs/llm-client": minor
---

feat(llm-client): provider capability matrix — getModelCapabilities() (Wave 3a §3.2)

Adds `getModelCapabilities(provider, model): ModelCapabilities | null` — a static lookup
that returns capability flags for any supported provider+model combination:

- `contextWindow`, `maxOutputTokens` — token limits
- `streaming`, `tools`, `parallelTools` — call surface support
- `promptCache` — `'ephemeral'` for Anthropic; `null` for all others
- `structuredOutput` — `'tool-use'` | `'json-schema'` | `'response-schema'` | `null`
- `responseIds` — `'provider'` | `'synthesized'` (Gemini synthesizes UUID v7-style IDs)
- `streamStructured` — `false` for Gemini and Perplexity

Returns `null` for unknown models (never throws). Covers all five providers and all models
in the DEFAULT_PRICING_TABLE. Versioned at `CAPABILITIES_VERSIONED_AT: '2026-05-13'`.
