---
"@diabolicallabs/llm-client": minor
---

Add optional `detail` field to image content blocks. OpenAI mapper threads it through (`'auto'` default unchanged); Gemini and Anthropic mappers ignore it. Closes the `detail: "high"` gap from the raw-SDK migration.
