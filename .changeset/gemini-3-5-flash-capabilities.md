---
'@diabolicallabs/llm-client': minor
---

feat(capabilities): add gemini-3.5-flash to capability matrix

Registers Google's current GA flagship model (released 2026-05-19) in the
capability lookup table. getModelCapabilities('gemini', 'gemini-3.5-flash')
now returns its full descriptor instead of null.

Context window: 1,048,576 tokens. Max output: 65,536 tokens. Tools, structured
output (response-schema), and multimodal base64 input (image + PDF) supported.
