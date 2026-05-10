---
"@diabolicallabs/llm-client": minor
---

Add native strict structured outputs (v0.4.0). Pass a Zod 4 schema to `structured()` to automatically trigger the strictest native path per provider: OpenAI `json_schema` strict mode, Anthropic tool-use with forced `tool_choice`, Gemini `responseSchema`. DeepSeek and Perplexity remain prompt-only (API limitation) but gain return-shape parity. `LlmStructuredResponse` gains `model` (always present), `id?` (provider request ID), and `citations?` (Perplexity). Opt out per-call with `providerOptions.structuredMode = 'prompt'`.
