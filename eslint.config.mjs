// Narrow ESLint config — covers only what Biome cannot handle.
// Specifically: no-floating-promises and no-misused-promises, which require
// type information and are not yet implemented in Biome (as of 2025).
// All other linting is owned by Biome (biome.json).

import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/dist/**', '**/node_modules/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // projectService enables type-aware rules (required for floating-promises)
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      // Prevent unhandled promise rejections — critical for async LLM calls,
      // Redis pipelines, and ingestion fire-and-forget patterns
      '@typescript-eslint/no-floating-promises': 'error',
      // Prevent async functions in non-async positions (event handlers etc.)
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
];

export default config;
