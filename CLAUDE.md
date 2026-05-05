# dlabs-toolkit — Project Scope Notes

## Overview

Shared platform infrastructure for the Diabolical Labs and Diana Ismail project fleet. Monorepo of independently-versioned TypeScript packages consumed by multiple repos. See `README.md` for current status and `proj-plan/dlabs-toolkit/briefs/brief-platform.md` for architecture.

## Team

- **Sable** — Platform architecture, package design, CI/CD, release engineering. Owns the toolkit.
- **Nix** — Consumer-side integration patterns when frontend repos adopt toolkit packages.
- **Quinn** — Test strategy across packages; type-safety verification.
- **Reid** — Naming and brand alignment for any package or surface that exposes brand language.

## Conventions

- **TypeScript strict.** No `any`, no implicit `any`, no unused locals/params.
- **ESM-only.** Modern Node (≥20) and modern bundlers only. No CJS dual-publish.
- **US English in docs, code identifiers, and copy.** Per `/Users/mann/Documents/Claude/decisions.md` (2026-05-04): dlabs-toolkit and `@diabolicallabs` packages are commercial-surface infrastructure, not personal-brand. Use `normalize`, `serialize`, `color`, `behavior`, `analyze` etc. — not `normalise`, `serialise`, `colour`, `behaviour`, `analyse`. Applies to function names, variable names, JSDoc, error messages, READMEs, and all public API surface.
- **Independent versioning per package** via Changesets (or equivalent — confirm in platform brief). Semver discipline mandatory.
- **No package ships without tests.** Quinn audits.
- **Manifest files** per global manifest schema (`/Users/mann/Documents/Claude/manifest-schema.md`) — Sable creates and maintains for each package.

## Brand and Legal

- **Published under:** Diabolical Labs (Diana Ismail's sole proprietor trade name).
- **Copyright footer:** "© Diabolical Labs" for package metadata; "© Diana Ismail trading as Diabolical Labs" for any contract-grade artefact.
- **License:** TBD pending Reid's brand-architecture pass and Owner decision. Default state (no LICENSE file) = all rights reserved.

## Where Things Live

- **Platform brief and design docs:** `/Users/mann/Documents/Claude/proj-plan/dlabs-toolkit/`
- **Briefs:** `proj-plan/dlabs-toolkit/briefs/`
- **Research:** `proj-plan/dlabs-toolkit/research/`
- **Decisions affecting other repos:** `/Users/mann/Documents/Claude/decisions.md`

## Related

- Agent Spend Dashboard (first commercial consumer): `proj-plan/agent-spend-dashboard/`
- Experiential Brief Generator (private, commercial): `proj-plan/experiential-brief-generator/`
- Brand architecture pass (Reid): `proj-plan/research/reid-brand-architecture.md`
