/**
 * Error normalisation tests for Anthropic and OpenAI providers.
 *
 * These tests use the real SDK error classes (no vi.mock) to verify that
 * Anthropic.APIError and OpenAI.APIError are correctly normalised to LlmError.
 * This exercises the guarded instanceof branches that cannot be reached when
 * the SDK modules are mocked in other test files.
 *
 * Note: Both SDKs use APIError as their base (not APIStatusError).
 * Subclasses: RateLimitError (429), AuthenticationError (401), etc.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../types.js';
import { normaliseAnthropicError } from './anthropic.js';
import { normaliseOpenAIError } from './openai.js';

describe('normaliseAnthropicError — real Anthropic SDK error classes', () => {
  it('maps Anthropic.APIError 429 to retryable LlmError', () => {
    // This exercises the `typeof Anthropic.APIError === 'function' && instanceof` branch
    const apiErr = Anthropic.APIError.generate(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
      'Rate limited',
      new Headers()
    );
    const result = normaliseAnthropicError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('anthropic');
    expect(result.statusCode).toBe(429);
    expect(result.retryable).toBe(true);
  });

  it('maps Anthropic.APIError 401 to non-retryable LlmError', () => {
    const apiErr = Anthropic.APIError.generate(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'Unauthorized' } },
      'Unauthorized',
      new Headers()
    );
    const result = normaliseAnthropicError(apiErr);
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('maps Anthropic.APIError 500 to retryable LlmError', () => {
    const apiErr = Anthropic.APIError.generate(
      500,
      { type: 'error', error: { type: 'internal_server_error', message: 'Server error' } },
      'Internal server error',
      new Headers()
    );
    const result = normaliseAnthropicError(apiErr);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('maps Anthropic.APIConnectionError to retryable LlmError with no statusCode', () => {
    const connErr = new Anthropic.APIConnectionError({
      message: 'Connection refused',
    });
    const result = normaliseAnthropicError(connErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  it('passes through LlmError unchanged', () => {
    const llmErr = new LlmError({
      message: 'already wrapped',
      provider: 'anthropic',
      retryable: false,
    });
    expect(normaliseAnthropicError(llmErr)).toBe(llmErr);
  });

  it('falls through to normaliseThrownError for plain Error', () => {
    const plainErr = new Error('network problem');
    const result = normaliseAnthropicError(plainErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('anthropic');
  });
});

describe('normaliseOpenAIError — real OpenAI SDK error classes', () => {
  it('maps OpenAI.APIError 429 to retryable LlmError', () => {
    const apiErr = OpenAI.APIError.generate(
      429,
      { error: { message: 'Rate limited', type: 'tokens', code: null, param: null } },
      'Rate limited',
      new Headers()
    );
    const result = normaliseOpenAIError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('openai');
    expect(result.statusCode).toBe(429);
    expect(result.retryable).toBe(true);
  });

  it('maps OpenAI.APIError 401 to non-retryable LlmError', () => {
    const apiErr = OpenAI.APIError.generate(
      401,
      {
        error: { message: 'Unauthorized', type: 'invalid_request_error', code: null, param: null },
      },
      'Unauthorized',
      new Headers()
    );
    const result = normaliseOpenAIError(apiErr);
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('maps OpenAI.APIError 500 to retryable LlmError', () => {
    const apiErr = OpenAI.APIError.generate(
      500,
      { error: { message: 'Internal error', type: 'server_error', code: null, param: null } },
      'Internal error',
      new Headers()
    );
    const result = normaliseOpenAIError(apiErr);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('maps OpenAI.APIConnectionError to retryable LlmError with no statusCode', () => {
    const connErr = new OpenAI.APIConnectionError({
      message: 'Connection refused',
    });
    const result = normaliseOpenAIError(connErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  it('passes through LlmError unchanged', () => {
    const llmErr = new LlmError({
      message: 'already wrapped',
      provider: 'openai',
      retryable: false,
    });
    expect(normaliseOpenAIError(llmErr)).toBe(llmErr);
  });

  it('falls through to normaliseThrownError for plain Error', () => {
    const plainErr = new Error('unexpected');
    const result = normaliseOpenAIError(plainErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('openai');
  });
});
