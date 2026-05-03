import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live alongside source in src/ — e.g. src/retry.test.ts
    include: ['src/**/*.test.ts'],

    // Exclude integration tests — these run only when TEST_INTEGRATION=1
    // Integration tests live in src/__tests__/integration/
    exclude: ['src/__tests__/integration/**'],

    // Pool: threads for CPU-bound tests (mock-based, no I/O)
    pool: 'threads',
    passWithNoTests: true,

    // Coverage: v8 provider, CI-gated at 80% line coverage
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
