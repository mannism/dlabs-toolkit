---
"@diabolicallabs/llm-client": minor
---

Add per-call timeout override (`LlmCallOptions.timeoutMs`), caller `AbortSignal` support (`LlmCallOptions.signal`), and per-chunk stream stall detection (`LlmCallOptions.streamStallTimeoutMs`) across all 5 providers (Anthropic, OpenAI, DeepSeek, Perplexity, Gemini). New `LlmError.kind` discriminator: `cancelled | timeout | stream_stall | http | network | unknown`. Gemini uses `Promise.race` with documented socket-leak caveat.
