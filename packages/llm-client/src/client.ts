/**
 * Factory functions for LlmClient.
 *
 * createClient — dispatches to the correct provider implementation.
 * createClientFromEnv — convenience wrapper that reads API keys from env vars.
 *
 * Provider dispatch:
 *   'anthropic'  → fully implemented (Week 2)
 *   'openai'     → fully implemented (Week 2)
 *   'gemini'     → fully implemented (Week 3)
 *   'deepseek'   → fully implemented (Week 3)
 *   'perplexity' → fully implemented (Week 5) — search-grounded, citations, providerOptions
 */

import { createAnthropicProvider } from './providers/anthropic.js';
import { createDeepSeekProvider } from './providers/deepseek.js';
import { createGeminiProvider } from './providers/gemini.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createPerplexityProvider } from './providers/perplexity.js';
import type { LlmClient, LlmClientConfig } from './types.js';
import { LlmError } from './types.js';

/**
 * Create an LlmClient for the given provider and config.
 * Dispatches to the provider-specific implementation.
 * All five providers are fully implemented.
 */
export function createClient(config: LlmClientConfig): LlmClient {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider(config);

    case 'openai':
      return createOpenAIProvider(config);

    case 'gemini':
      return createGeminiProvider(config);

    case 'deepseek':
      return createDeepSeekProvider(config);

    case 'perplexity':
      return createPerplexityProvider(config);

    default: {
      // TypeScript exhaustiveness check — if a new provider is added to the union
      // without a case here, this will be a compile-time error.
      const _exhaustive: never = config.provider;
      throw new LlmError({
        message: `[dlabs-toolkit] Unknown provider: ${String(_exhaustive)}`,
        provider: String(_exhaustive),
        retryable: false,
      });
    }
  }
}

/**
 * Convenience: create an LlmClient from environment variables.
 *
 * Reads API keys from the environment based on provider:
 *   anthropic  → ANTHROPIC_API_KEY
 *   openai     → OPENAI_API_KEY
 *   gemini     → GOOGLE_AI_API_KEY
 *   deepseek   → DEEPSEEK_API_KEY
 *   perplexity → PERPLEXITY_API_KEY — recommended default model: 'sonar'
 *
 * Throws LlmError if the required env var is not set.
 */
export function createClientFromEnv(
  provider: LlmClientConfig['provider'],
  model: string,
  overrides?: Partial<Omit<LlmClientConfig, 'provider' | 'model' | 'apiKey'>>
): LlmClient {
  const apiKey = resolveApiKey(provider);
  return createClient({ provider, model, apiKey, ...overrides });
}

/** Read the API key for a given provider from environment variables. */
function resolveApiKey(provider: LlmClientConfig['provider']): string {
  const envVarMap: Record<LlmClientConfig['provider'], string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GOOGLE_AI_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    perplexity: 'PERPLEXITY_API_KEY',
  };

  const envVar = envVarMap[provider];
  const apiKey = process.env[envVar];

  if (apiKey === undefined || apiKey.trim() === '') {
    throw new LlmError({
      message: `[dlabs-toolkit] ${envVar} is not set. Set this environment variable to use the ${provider} provider.`,
      provider,
      retryable: false,
    });
  }

  return apiKey;
}
