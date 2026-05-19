# PR Comprehension Gate

Before merging any PR — especially agent-generated code — the reviewer must answer these questions. Unanswered questions block merge.

## Core Questions (required on every PR)

1. **What does this change do in one sentence?**
2. **What fails silently?** — Identify swallowed errors, empty catches, fire-and-forget patterns
3. **What's the blast radius?** — If this code has a bug, what else breaks?

## Extended Questions (required for this tier)

4. **Why this dependency?** — Every new import/package must have a stated reason
5. **What's cached and why?** — Cache layers, TTLs, invalidation strategy
6. **How are concerns separated?** — Business logic mixed with UI or data access?
7. **What are the failure modes?** — For external calls: what happens on timeout, 429, 500?

## Application

- Agent-generated PRs: include answers in the PR description
- Format: numbered list matching the questions above
- If any gate answer reveals behavior not captured in the module's `manifest.yaml`, update the manifest in this PR.
