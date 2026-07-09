#!/usr/bin/env node
// Postbuild step: mark the CLI entry executable. tsup does not preserve the
// executable bit, and npm's `bin` mechanism requires it on POSIX systems.
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../dist/bin/eval-gate-cli.js', import.meta.url));
chmodSync(target, 0o755);
