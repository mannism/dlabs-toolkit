---
"@diabolicallabs/agent-sdk": patch
---

chore: remove redundant peerDependency on @diabolicallabs/llm-pricing. agent-sdk's only usage is type-only imports of LlmCost (compiled away at build time). The peer-dep was documentation-grade, not load-bearing. Removing it prevents the Changesets peer-cascade major-bump that fires every time llm-pricing crosses a pre-1.0 minor boundary. Runtime behavior unchanged.
