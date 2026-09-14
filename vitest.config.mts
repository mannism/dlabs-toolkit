import { defineConfig } from 'vitest/config';

// Root-level vitest suite for repo-wide structural/hygiene tests — distinct
// from each package's own vitest.config.ts (which scope to that package's
// src/**/*.test.ts). Turborepo's "test" task is defined per-workspace-package
// (packages/*) per turbo.json, so a repo-root test file is invisible to
// `turbo run test` — this config + the root "test:structure" script is how
// it gets wired into `pnpm run test` instead. See
// brief-hygiene-manifest-structural-test.md AC5.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
  },
});
