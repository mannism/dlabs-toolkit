---
"@diabolicallabs/llm-client": minor
---

Add CJS `require` exports condition for Node ≥22.12 consumers.

Previously the `exports` map declared only an `"import"` condition, causing `ERR_PACKAGE_PATH_NOT_EXPORTED` for any CJS-mode runtime (tsx workers, Next.js loaders without `serverExternalPackages`) that resolves the package via `require()` semantics.

The `"require"` condition now points to the same ESM `dist/index.js` and `dist/pool/index.js` files. Node ≥22.12 natively supports `require(esm)` for ESM files with no top-level `await` — no dual build is needed. The `engines.node` floor is raised to `>=22.12.0` to match this requirement honestly.

**Downstream note:** brand-compliance-saas BullMQ workers (`tsx src/workers/…`) are unblocked by this change. If you have a pnpm patch for `@diabolicallabs/llm-client@6.0.0` in place as a bridge, remove it after upgrading to this version.
