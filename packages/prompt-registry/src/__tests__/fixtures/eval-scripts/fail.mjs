#!/usr/bin/env node
// Fixture eval script for the eval-gate CI demonstration: always exits 1,
// simulating a prompt regression caught by an eval rubric.
console.error('fail.mjs: simulated eval regression — prompt failed the rubric');
process.exit(1);
