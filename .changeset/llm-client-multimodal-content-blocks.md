---
"@diabolicallabs/llm-client": minor
---

Add provider-neutral multimodal content blocks (LlmContentBlock) supporting images and PDFs for Anthropic, OpenAI, and Gemini. Widens LlmMessage.content from string to string | LlmContentBlock[]. Adds pre-flight bad_request guards for Perplexity and DeepSeek. Adds mediaInput capability fields to all 25 model rows in the capability matrix.
