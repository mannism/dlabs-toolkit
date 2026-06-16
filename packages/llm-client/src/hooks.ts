/**
 * Hook dispatcher for @diabolicallabs/llm-client (v1.5.0+).
 *
 * Implements the run-before-call / run-after-call lifecycle for LlmHooks.
 * Called from client.ts's createClient() wrapper — not called inside providers.
 *
 * Contract:
 *   - runBeforeCall: fires hook.beforeCall, returns resolved messages/options or a skip result.
 *   - runAfterCall: fires hook.afterCall; swallows and logs errors — never throws.
 *   - Both fire once per public method invocation, not per retry attempt.
 *   - beforeCall errors propagate as LlmError({ kind: 'bad_request' }).
 *   - afterCall errors are logged at warn level and dropped.
 */

import { getLogger } from './logger.js';
import type {
  LlmAfterCallContext,
  LlmBeforeCallResult,
  LlmCallContext,
  LlmCallOptions,
  LlmHooks,
  LlmMessage,
  LlmSkipResult,
} from './types.js';
import { LlmError } from './types.js';

// ─── BeforeCall result shapes ────────────────────────────────────────────────

/** Result when beforeCall passes through (no mutation, no skip). */
export interface BeforeCallPassThrough {
  kind: 'passthrough';
  messages: LlmMessage[];
  options: LlmCallOptions | undefined;
}

/** Result when beforeCall provides a pre-built response to return immediately. */
export interface BeforeCallSkip {
  kind: 'skip';
  response: LlmSkipResult;
}

/** Discriminated union returned by runBeforeCall — either pass through with (mutated) args or skip with a cached response. */
export type BeforeCallResult = BeforeCallPassThrough | BeforeCallSkip;

// ─── runBeforeCall ───────────────────────────────────────────────────────────

/**
 * Invoke the beforeCall hook (if configured) and return either a passthrough
 * (with possibly-mutated messages/options) or a skip (with the cached response).
 *
 * Errors thrown by the hook are caught and re-thrown as LlmError({ kind: 'bad_request' }).
 */
export async function runBeforeCall(
  hooks: LlmHooks | undefined,
  ctx: LlmCallContext
): Promise<BeforeCallResult> {
  if (hooks?.beforeCall === undefined) {
    return { kind: 'passthrough', messages: ctx.messages, options: ctx.options };
  }

  let result: LlmBeforeCallResult | undefined;
  try {
    result = await hooks.beforeCall(ctx);
  } catch (err) {
    throw new LlmError({
      message: `[llm-client] beforeCall hook threw: ${err instanceof Error ? err.message : String(err)}`,
      provider: ctx.provider,
      retryable: false,
      kind: 'bad_request',
      cause: err,
    });
  }

  if (result === undefined || result === null) {
    return { kind: 'passthrough', messages: ctx.messages, options: ctx.options };
  }

  if (result.skip !== undefined) {
    return { kind: 'skip', response: result.skip };
  }

  // Apply mutations — fall back to original if not provided
  return {
    kind: 'passthrough',
    messages: result.messages ?? ctx.messages,
    options: result.options ?? ctx.options,
  };
}

// ─── runAfterCall ────────────────────────────────────────────────────────────

/**
 * Invoke the afterCall hook (if configured).
 *
 * Errors thrown by the hook are caught, logged at warn level, and dropped.
 * afterCall must never crash a call that already returned.
 */
export async function runAfterCall(
  hooks: LlmHooks | undefined,
  ctx: LlmAfterCallContext
): Promise<void> {
  if (hooks?.afterCall === undefined) return;

  try {
    await hooks.afterCall(ctx);
  } catch (err) {
    // afterCall errors are dropped to protect callers that already received a response.
    // Route through the pluggable logger so consumers can redirect alongside other diagnostics.
    getLogger().warn('aftercall_hook_error', {
      callType: ctx.request.callType,
      model: ctx.request.model,
      message: `afterCall hook threw (error dropped): ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
