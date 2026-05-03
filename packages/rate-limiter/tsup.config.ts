import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,

  // ioredis is a peerDependency — mark external so consumers provide it
  external: ['ioredis'],
});
