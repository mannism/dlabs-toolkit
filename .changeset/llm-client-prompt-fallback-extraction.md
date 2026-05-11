---
"@diabolicallabs/llm-client": patch
---

fix(llm-client): robust JSON extraction in structured() prompt-fallback

Replaces naïve fence-strip + JSON.parse with a single-pass balanced-brace
extractor (extractJsonBlock) that correctly handles:

- JSON in fences with trailing prose (Perplexity citation notes — the GEOAudit
  Advanced audit failure from 2026-05-11)
- Preamble prose before the fence
- No closing fence (model truncation)
- Braces/brackets inside double-quoted string values
- <think>...</think> reasoning blocks (sonar-reasoning-pro and similar)

All four prompt-fallback paths (Anthropic structuredPromptFallback, OpenAI
structuredPromptFallback, Gemini structuredPromptFallback, Perplexity structured)
now share parseJsonOrThrow from src/extract-json.ts. On extraction failure the
error message includes a ≥500-char raw content slice (head 300 + tail 200 for
long responses) instead of the previous 200-char head-only slice.
