---
'@diabolicallabs/llm-client': minor
---

feat: capability matrix refresh and DeepSeek canonical model rename (2026-10-04).

`getModelCapabilities` gains rows for `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna` and `deepseek-flash`. Limits corrected on existing rows: `claude-opus-4-7` output 128k; `claude-opus-4-6` and `claude-sonnet-4-6` 1M context / 128k output; `claude-haiku-4-5` (both IDs) 64k output (was 8,096); `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4` 1.05M / 128k; `gpt-5.4-pro` and `gpt-5.6-sol/terra/luna` 1.05M context; `gpt-5.4-mini` 400K / 128k; `gemini-3.1-flash-lite` 65,536 output; `deepseek-v4-flash` and `deepseek-v4-pro` 1,048,576 context / 393,216 output.

DeepSeek: the canonical Flash model ID is now `deepseek-flash` (DeepSeek-V4.1-Flash). The client-side retired-model rejection for `deepseek-chat` / `deepseek-reasoner` now names `deepseek-flash` as the replacement (error text change only; behavior is unchanged: still rejected, never auto-remapped). `deepseek-v4-flash` remains accepted upstream as a legacy name and is billed at the new Flash rate ($0.15 / $0.60 / $0.003 per 1M, a change from $0.22 / $0.66 / $0.007; see the `@diabolicallabs/llm-pricing` changeset). Docs and smoke scripts default to `deepseek-flash`. OpenAI long-context pricing (prompts over 272K tokens) now applies to the listed GPT-5.4/5.5/5.6/6 models via the updated pricing table, so computed cost for such prompts rises.
