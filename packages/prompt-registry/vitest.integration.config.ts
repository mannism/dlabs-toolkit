import { defineConfig } from 'vitest/config';

// Separate config for the Postgres round-trip integration suite. Not part of
// the default `vitest run` (turbo `test` task) — requires DATABASE_URL
// pointed at a disposable Postgres instance. Run locally via:
//   docker run -d --rm -p 5433:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=prompt_registry_test postgres:16-alpine
//   DATABASE_URL=postgres://postgres:test@localhost:5433/prompt_registry_test pnpm test:integration
export default defineConfig({
  test: {
    include: ['src/__tests__/integration/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
