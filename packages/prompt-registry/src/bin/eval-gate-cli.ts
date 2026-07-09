#!/usr/bin/env node
/**
 * CLI wrapper around runPromptEvalGate() for wiring directly into a
 * consumer's CI pipeline as a shell step, no code required:
 *
 *   prompt-registry-eval-gate <promptPath> <evalScriptPath> [timeoutMs]
 *
 * Exit code mirrors the eval script's verdict: 0 on pass, 1 on failure or
 * misuse (missing args, eval script failed to spawn).
 */
import { runPromptEvalGate } from '../eval-gate.js';

async function main(): Promise<void> {
  const [promptPath, evalScriptPath, timeoutArg] = process.argv.slice(2);

  if (!promptPath || !evalScriptPath) {
    console.error('Usage: prompt-registry-eval-gate <promptPath> <evalScriptPath> [timeoutMs]');
    process.exitCode = 1;
    return;
  }

  try {
    const result = await runPromptEvalGate({
      promptPath,
      evalScriptPath,
      throwOnFailure: false,
      ...(timeoutArg ? { timeoutMs: Number.parseInt(timeoutArg, 10) } : {}),
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (!result.passed) {
      console.error(
        `[prompt-registry-eval-gate] FAILED (exit ${result.exitCode}, ${result.durationMs}ms)`
      );
      process.exitCode = 1;
      return;
    }

    console.log(`[prompt-registry-eval-gate] PASSED (${result.durationMs}ms)`);
  } catch (err) {
    console.error(
      '[prompt-registry-eval-gate] eval script failed to spawn:',
      err instanceof Error ? err.message : err
    );
    process.exitCode = 1;
  }
}

void main();
