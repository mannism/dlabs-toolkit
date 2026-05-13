import { defineConfig } from 'tsup';

export default defineConfig({
  // Entry points — main public API + pool sub-path (v1.2.0)
  entry: ['src/index.ts', 'src/pool/index.ts'],

  // ESM only — no CJS dual-publish (Node ≥20 across all consumers)
  format: ['esm'],
  target: 'node20',

  // Generate .d.ts declaration files for TypeScript consumers
  dts: true,

  // Source maps for stack trace resolution in development
  sourcemap: true,

  // Clean dist/ before each build to prevent stale artefacts
  clean: true,

  // Keep exports named — no default export bundling
  splitting: false,
});
