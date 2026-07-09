/**
 * CI eval-gate helper — given a changed prompt file and an eval script,
 * spawns the eval script and fails (non-zero) if the script fails. This is
 * the "gate prompt changes on an evaluation script" half of the admin
 * standard's prompt lifecycle: publish() can persist any syntactically valid
 * prompt text, but a CI step wired to runPromptEvalGate() is what stops a
 * regression from ever reaching publish() in an automated pipeline.
 *
 * This package does not prescribe what an eval script checks (that's product
 * -specific — golden-output diffing, a judge-model rubric, a regex smoke
 * test). The contract is only: the eval script receives the prompt file path
 * as argv[2] and PROMPT_FILE env var, and its exit code is the gate's verdict.
 *
 * See src/__tests__/unit/eval-gate.test.ts and
 * src/__tests__/fixtures/eval-scripts/{pass,fail}.mjs for the fixture
 * demonstration referenced in the package's own CI (scripts/eval-gate-demo.mjs).
 */

import { spawn } from 'node:child_process';
import { PromptEvalGateFailedError } from './errors.js';

export interface EvalGateOptions {
  /** Path to the prompt file whose content changed — passed to the eval script. */
  promptPath: string;
  /** Path to an executable eval script (node script, shell script, etc.). */
  evalScriptPath: string;
  /** Working directory for the spawned process. Defaults to process.cwd(). */
  cwd?: string;
  /** Kill the eval script and fail the gate if it runs longer than this. Default 60_000ms. */
  timeoutMs?: number;
  /**
   * When true (default), a failing eval script throws PromptEvalGateFailedError
   * — the natural mode for a CI step (`await runPromptEvalGate(...)` un-caught
   * fails the pipeline). Set false to get a non-throwing EvalGateResult instead.
   */
  throwOnFailure?: boolean;
}

export interface EvalGateResult {
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Runs `evalScriptPath` against `promptPath` and reports pass/fail based on
 * exit code. The eval script is invoked with `node` if it ends in .mjs/.js/.cjs,
 * otherwise executed directly (shell scripts must be chmod +x).
 */
export async function runPromptEvalGate(options: EvalGateOptions): Promise<EvalGateResult> {
  const {
    promptPath,
    evalScriptPath,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    throwOnFailure = true,
  } = options;

  const isNodeScript = /\.(mjs|js|cjs)$/.test(evalScriptPath);
  const command = isNodeScript ? process.execPath : evalScriptPath;
  const args = isNodeScript ? [evalScriptPath, promptPath] : [promptPath];

  const started = Date.now();

  const result = await new Promise<EvalGateResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PROMPT_FILE: promptPath },
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      resolve({
        passed: code === 0,
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });

  if (!result.passed && throwOnFailure) {
    throw new PromptEvalGateFailedError(evalScriptPath, result.exitCode, result.stderr);
  }

  return result;
}
