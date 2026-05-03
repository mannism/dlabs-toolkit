/**
 * Factory functions for LlmClient.
 * Stubs for Week 1 scaffold — full provider implementations ship in Week 2.
 * The stubs are typed correctly so consumers can import and reference the
 * types without building against unimplemented code.
 */

import type { LlmClient, LlmClientConfig } from './types.js';

/**
 * Create an LlmClient for the given provider and config.
 * Week 2 will implement the full provider dispatch.
 */
export function createClient(_config: LlmClientConfig): LlmClient {
  throw new Error(
    '[dlabs-toolkit] createClient is not yet implemented. Implementation ships Week 2.'
  );
}

/**
 * Convenience: create an LlmClient from environment variables.
 * Reads ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_AI_API_KEY / DEEPSEEK_API_KEY
 * based on the provider argument.
 * Week 2 will implement the full env-var resolution.
 */
export function createClientFromEnv(
  provider: LlmClientConfig['provider'],
  model: string,
  _overrides?: Partial<Omit<LlmClientConfig, 'provider' | 'model' | 'apiKey'>>
): LlmClient {
  throw new Error(
    `[dlabs-toolkit] createClientFromEnv is not yet implemented (provider: ${provider}, model: ${model}). Implementation ships Week 2.`
  );
}
