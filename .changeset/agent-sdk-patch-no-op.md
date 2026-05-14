---
"@diabolicallabs/agent-sdk": patch
---

chore: peer dep range disjunction (`^0.1.0 || ^0.2.0`) for `@diabolicallabs/llm-pricing`. Pure manifest tweak — no API change, no behavior change. Explicit patch entry to override the default major-bump cascade that fires when a peer-dep pre-1.0 minor boundary is crossed.
