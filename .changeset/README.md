# Changesets

This directory contains changesets — small Markdown files that describe changes to packages and drive the automated release process.

## Adding a changeset

```bash
pnpm changeset
```

This starts an interactive prompt. Select the affected packages, choose the bump type (patch / minor / major), and write a human-readable description. The changeset file is committed alongside your code change.

## Release flow

**On pull request:** CI runs lint, typecheck, build, and tests. No publish.

**On merge to `main`:** The `release.yml` workflow reads pending changeset files and:
1. If changesets are present: opens/updates a "Version Packages" PR that bumps versions and updates `CHANGELOG.md` files.
2. If the "Version Packages" PR is merged: publishes changed packages to GitHub Packages and creates GitHub Releases.

## Pre-release channel

To publish a `@next` pre-release:

```bash
pnpm changeset pre enter next
pnpm changeset
pnpm changeset version
pnpm changeset publish
```

Exit pre-release mode when the feature is stable:

```bash
pnpm changeset pre exit
```

## Rules

- Every PR that modifies a package must include a changeset.
- Never manually bump versions in `package.json` — Changesets does this.
- Never manually write `CHANGELOG.md` entries — Changesets does this.
- Breaking changes (major bumps) require a migration guide in the PR description before review.
- For the first six months (~November 2026): additive changes only. No export removals, no breaking signature changes.
