#!/usr/bin/env node
/**
 * Demonstrates runPromptEvalGate() against the package's own fixture prompt
 * and fixture eval scripts, in a form suitable as a CI step (acceptance
 * criterion 4: "demonstrated in the package's own CI on a fixture prompt").
 * Run against the built dist/ output — `pnpm build` must run first.
 *
 * Verifies both directions of the gate:
 *   1. pass.mjs against the fixture prompt -> gate must PASS
 *   2. fail.mjs against the fixture prompt -> gate must FAIL (this is the
 *      behavior a CI pipeline relies on to block a bad prompt change)
 *
 * Exits 0 only if both assertions hold — i.e. this script's own exit code
 * demonstrates the gate is wired correctly, not just that it runs.
 */
import { fileURLToPath } from 'node:url';
import { runPromptEvalGate } from '../dist/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PROMPT_PATH = `${HERE}../src/__tests__/fixtures/prompts/example-system.md`;
const PASS_SCRIPT = `${HERE}../src/__tests__/fixtures/eval-scripts/pass.mjs`;
const FAIL_SCRIPT = `${HERE}../src/__tests__/fixtures/eval-scripts/fail.mjs`;

async function main() {
  console.log('[eval-gate-demo] Case 1: eval script that PASSES a fixture prompt...');
  const passResult = await runPromptEvalGate({
    promptPath: PROMPT_PATH,
    evalScriptPath: PASS_SCRIPT,
    throwOnFailure: false,
  });
  if (!passResult.passed) {
    console.error('[eval-gate-demo] FAIL: expected the pass-fixture gate to pass, it did not.');
    process.exitCode = 1;
    return;
  }
  console.log(`[eval-gate-demo] OK — gate passed as expected (${passResult.durationMs}ms)`);

  console.log('[eval-gate-demo] Case 2: eval script that FAILS a fixture prompt (must be blocked)...');
  const failResult = await runPromptEvalGate({
    promptPath: PROMPT_PATH,
    evalScriptPath: FAIL_SCRIPT,
    throwOnFailure: false,
  });
  if (failResult.passed) {
    console.error('[eval-gate-demo] FAIL: expected the fail-fixture gate to be blocked, it passed instead.');
    process.exitCode = 1;
    return;
  }
  console.log(`[eval-gate-demo] OK — gate correctly blocked the failing prompt (exit ${failResult.exitCode})`);

  console.log('[eval-gate-demo] Case 3: runPromptEvalGate() throws by default on failure (CI-step ergonomics)...');
  try {
    await runPromptEvalGate({ promptPath: PROMPT_PATH, evalScriptPath: FAIL_SCRIPT });
    console.error('[eval-gate-demo] FAIL: expected runPromptEvalGate() to throw with default throwOnFailure.');
    process.exitCode = 1;
    return;
  } catch (err) {
    console.log(`[eval-gate-demo] OK — threw as expected: ${err.constructor.name}`);
  }

  console.log('[eval-gate-demo] All eval-gate demonstrations passed.');
}

main().catch((err) => {
  console.error('[eval-gate-demo] unexpected error:', err);
  process.exitCode = 1;
});
