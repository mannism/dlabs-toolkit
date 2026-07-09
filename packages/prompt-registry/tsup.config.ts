import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/eval-gate-cli.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,

  // pg is a peerDependency — the registry core only depends on the structural
  // PgPoolLike interface (query + connect). Consumers supply their own pg.Pool
  // instance, same pattern as ioredis in @diabolicallabs/rate-limiter.
  external: ['pg'],
});
