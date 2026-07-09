import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PromptEvalGateFailedError } from '../../errors.js';
import { runPromptEvalGate } from '../../eval-gate.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));
const PROMPT_PATH = `${FIXTURES_DIR}/prompts/example-system.md`;
const PASS_SCRIPT = `${FIXTURES_DIR}/eval-scripts/pass.mjs`;
const FAIL_SCRIPT = `${FIXTURES_DIR}/eval-scripts/fail.mjs`;

describe('runPromptEvalGate', () => {
  it('resolves with passed: true when the eval script exits 0', async () => {
    const result = await runPromptEvalGate({
      promptPath: PROMPT_PATH,
      evalScriptPath: PASS_SCRIPT,
      throwOnFailure: false,
    });
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('OK');
  });

  it('throws PromptEvalGateFailedError by default when the eval script exits non-zero', async () => {
    await expect(
      runPromptEvalGate({ promptPath: PROMPT_PATH, evalScriptPath: FAIL_SCRIPT })
    ).rejects.toBeInstanceOf(PromptEvalGateFailedError);
  });

  it('returns a non-throwing result when throwOnFailure: false', async () => {
    const result = await runPromptEvalGate({
      promptPath: PROMPT_PATH,
      evalScriptPath: FAIL_SCRIPT,
      throwOnFailure: false,
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('simulated eval regression');
  });

  it('passes the prompt path via both argv and PROMPT_FILE env var', async () => {
    const result = await runPromptEvalGate({
      promptPath: PROMPT_PATH,
      evalScriptPath: PASS_SCRIPT,
      throwOnFailure: false,
    });
    expect(result.stdout).toContain(PROMPT_PATH);
  });
});
