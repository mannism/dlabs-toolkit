/**
 * Named error taxonomy for @diabolicallabs/prompt-registry. Pattern mirrors
 * @diabolicallabs/notion (NotionError + named subclasses) — every error carries
 * a machine-readable `.code` so consumers can branch without parsing message
 * strings, and none ever include raw prompt content or connection secrets.
 */

export class PromptRegistryError extends Error {
  readonly code: string;

  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** get()/rollback() target a (name, type, version) that does not exist in storage. */
export class PromptNotFoundError extends PromptRegistryError {
  constructor(name: string, type: string, version?: number) {
    const target = version === undefined ? `${name}/${type}` : `${name}/${type}@v${version}`;
    super(`Prompt not found: ${target}`, 'prompt_not_found');
  }
}

/**
 * Concurrent publish() calls raced on the same (name, type) and both computed
 * the same next version number. The UNIQUE (prompt_name, prompt_type, version)
 * constraint is the backstop — Postgres rejects the second INSERT with 23505,
 * which the adapter maps to this error. Caller should retry; a retry will see
 * the winning version and compute a fresh next-version number.
 */
export class PromptVersionConflictError extends PromptRegistryError {
  constructor(name: string, type: string) {
    super(
      `Concurrent publish detected for ${name}/${type} — version number collision. Retry the publish() call.`,
      'version_conflict'
    );
  }
}

/** Public API input failed Zod validation. `.details` carries the flattened Zod issue list (safe — schema field names only, never the rejected content itself, since content can be arbitrarily large/sensitive). */
export class PromptValidationError extends PromptRegistryError {
  readonly details: string[];

  constructor(details: string[]) {
    super(`Invalid input: ${details.join('; ')}`, 'validation_error');
    this.details = details;
  }
}

/** The eval-gate helper's eval script exited non-zero, or failed to spawn. */
export class PromptEvalGateFailedError extends PromptRegistryError {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(evalScriptPath: string, exitCode: number | null, stderr: string) {
    super(
      `Prompt eval gate failed: ${evalScriptPath} exited with code ${exitCode}`,
      'eval_gate_failed'
    );
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/** Storage adapter threw during a registry operation. Wraps the underlying driver error as `.cause` without leaking it into `.message` (avoids surfacing raw DB errors — table names, driver internals — to callers that log `.message` directly). */
export class PromptStorageError extends PromptRegistryError {
  constructor(operation: string, cause: unknown) {
    super(`Storage adapter error during ${operation}`, 'storage_error', cause);
  }
}
