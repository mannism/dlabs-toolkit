@AGENTS.md

# Claude Code notes — dlabs-toolkit

Scope rule: if a session starts from this repo, work only on this project. Do not touch other repos unless the Owner explicitly says otherwise.

Fleet rules: `~/.claude/CLAUDE.md`. Orchestration scope: `/Users/mann/Documents/Claude/CLAUDE.md`.

## Persona pointers

- **Sable** — platform architecture, package design, CI/CD, release engineering. Owns the toolkit.
- **Nix** — consumer-side integration patterns when frontend repos adopt toolkit packages.
- **Quinn** — test strategy across packages, type-safety verification.
- **Reid** — naming and brand alignment for any package or surface that exposes brand language.

## Relevant skills

- `/brief` — required for any change touching more than 2 files
- `/hygiene` — periodic audit of orphans, manifest drift
