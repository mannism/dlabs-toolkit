import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],

  // ESM only
  format: ['esm'],
  target: 'node20',

  // Generate .d.ts for TypeScript consumers
  dts: true,

  sourcemap: true,
  clean: true,
  splitting: false,

  // @diabolicallabs/llm-client is a workspace dep — mark as external
  // so tsup does not bundle it. Consumers install it separately.
  external: ['@diabolicallabs/llm-client'],
});
