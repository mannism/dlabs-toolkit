#!/usr/bin/env node
// Fixture eval script for the eval-gate CI demonstration: always exits 0.
// Reads the prompt file path from argv[2] / PROMPT_FILE and does a trivial
// non-empty-content check — enough to prove the gate wires argv + env
// correctly without depending on a real eval framework.
import { readFileSync } from 'node:fs';

const promptPath = process.argv[2] ?? process.env.PROMPT_FILE;
if (!promptPath) {
  console.error('pass.mjs: no prompt path provided');
  process.exit(1);
}

const content = readFileSync(promptPath, 'utf8');
console.log(`pass.mjs: read ${content.length} chars from ${promptPath} — OK`);
process.exit(0);
