/**
 * Type-only stubs for providers not yet implemented.
 *
 * Perplexity — later week (internal tooling, separate decision)
 *
 * All stubs throw a clear "not yet implemented" LlmError.
 * They are registered in the factory so the switch statement is exhaustive
 * and unknown provider values are caught at runtime with a useful message.
 */

import type { LlmClient, LlmClientConfig, LlmStreamChunk } from '../types.js';
import { LlmError } from '../types.js';

/**
 * Returns an AsyncGenerator that immediately rejects when iterated.
 * Implemented without generator syntax to avoid Biome's useYield lint rule —
 * a throw-only generator has no meaningful yield, which Biome correctly flags.
 * The returned object satisfies the AsyncGenerator<LlmStreamChunk> interface contract.
 */
function rejectingStream(err: LlmError): AsyncGenerator<LlmStreamChunk> {
  const rejected = Promise.reject<IteratorResult<LlmStreamChunk>>(err);
  // Attach a no-op catch so Node does not emit an unhandledRejection warning
  // before the caller consumes the generator via for-await-of.
  rejected.catch(() => undefined);
  return {
    next: () => rejected,
    return: () => Promise.resolve({ value: undefined, done: true as const }),
    throw: () => Promise.reject(err),
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
}

function notImplemented(provider: string): LlmClient {
  const err = new LlmError({
    message: `[dlabs-toolkit] Provider '${provider}' is not yet implemented. Anthropic, OpenAI, Gemini, and DeepSeek are available; Perplexity ships in a later week.`,
    provider,
    retryable: false,
  });

  // Return an object that throws on any method call.
  // The error is pre-constructed so stack traces point to the factory call site,
  // not the method call site — easier to debug misconfigured providers.
  return {
    get config(): LlmClientConfig {
      throw err;
    },
    complete: () => Promise.reject(err),
    stream: () => rejectingStream(err),
    structured: () => Promise.reject(err),
  };
}

/** Perplexity provider stub — later week. */
export function createPerplexityProvider(config: LlmClientConfig): LlmClient {
  void config;
  return notImplemented('perplexity');
}
