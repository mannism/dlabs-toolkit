/**
 * Error normalization tests for Anthropic, OpenAI, and Gemini providers.
 *
 * These tests use the real SDK error classes (no vi.mock) to verify that
 * SDK errors are correctly normalized to LlmError.
 * This exercises the guarded instanceof branches that cannot be reached when
 * the SDK modules are mocked in other test files.
 *
 * Note: Anthropic and OpenAI SDKs use APIError as their base (not APIStatusError).
 * Gemini's public API exports ApiError (lowercase 'a') with status: number (always defined).
 */

import Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '@google/genai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../types.js';
import { normalizeAnthropicError } from './anthropic.js';
import { normalizeDeepSeekError } from './deepseek.js';
import { normalizeGeminiError } from './gemini.js';
import { normalizeOpenAIError } from './openai.js';
import { normalizePerplexityError } from './perplexity.js';

describe('normalizeAnthropicError — real Anthropic SDK error classes', () => {
  it('maps Anthropic.APIError 429 to retryable LlmError', () => {
    // This exercises the `typeof Anthropic.APIError === 'function' && instanceof` branch
    const apiErr = Anthropic.APIError.generate(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
      'Rate limited',
      new Headers()
    );
    const result = normalizeAnthropicError(apiErr);
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
    const result = normalizeAnthropicError(apiErr);
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
    const result = normalizeAnthropicError(apiErr);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('maps Anthropic.APIConnectionError to retryable LlmError with no statusCode', () => {
    const connErr = new Anthropic.APIConnectionError({
      message: 'Connection refused',
    });
    const result = normalizeAnthropicError(connErr);
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
    expect(normalizeAnthropicError(llmErr)).toBe(llmErr);
  });

  it('falls through to normalizeThrownError for plain Error', () => {
    const plainErr = new Error('network problem');
    const result = normalizeAnthropicError(plainErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('anthropic');
  });
});

describe('normalizeOpenAIError — real OpenAI SDK error classes', () => {
  it('maps OpenAI.APIError 429 to retryable LlmError', () => {
    const apiErr = OpenAI.APIError.generate(
      429,
      { error: { message: 'Rate limited', type: 'tokens', code: null, param: null } },
      'Rate limited',
      new Headers()
    );
    const result = normalizeOpenAIError(apiErr);
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
    const result = normalizeOpenAIError(apiErr);
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
    const result = normalizeOpenAIError(apiErr);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('maps OpenAI.APIConnectionError to retryable LlmError with no statusCode', () => {
    const connErr = new OpenAI.APIConnectionError({
      message: 'Connection refused',
    });
    const result = normalizeOpenAIError(connErr);
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
    expect(normalizeOpenAIError(llmErr)).toBe(llmErr);
  });

  it('falls through to normalizeThrownError for plain Error', () => {
    const plainErr = new Error('unexpected');
    const result = normalizeOpenAIError(plainErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('openai');
  });

  it('maps OpenAI.APIError with undefined status to non-retryable LlmError', () => {
    // status === undefined is possible for an APIError subclass that is NOT an APIConnectionError
    // (which is always retryable). APIError.generate(undefined) produces APIConnectionError, so
    // we use Object.create to construct an APIError instance that bypasses the APIConnectionError
    // check. Exercises the else branch at lines 85-86 in openai.ts.
    const apiErr = Object.create(OpenAI.APIError.prototype) as InstanceType<typeof OpenAI.APIError>;
    Object.assign(apiErr, { status: undefined, message: 'no status code available' });
    const result = normalizeOpenAIError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('openai');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBeUndefined();
  });
});

describe('normalizeGeminiError — real @google/genai ApiError class', () => {
  it('maps ApiError 429 to retryable LlmError', () => {
    // ApiError is publicly exported and directly constructable
    const apiErr = new ApiError({ status: 429, message: 'Rate limited' });
    const result = normalizeGeminiError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('gemini');
    expect(result.statusCode).toBe(429);
    expect(result.retryable).toBe(true);
  });

  it('maps ApiError 401 to non-retryable LlmError', () => {
    const apiErr = new ApiError({ status: 401, message: 'Unauthorized' });
    const result = normalizeGeminiError(apiErr);
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('maps ApiError 500 to retryable LlmError', () => {
    const apiErr = new ApiError({ status: 500, message: 'Internal server error' });
    const result = normalizeGeminiError(apiErr);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('maps ApiError 503 to retryable LlmError', () => {
    const apiErr = new ApiError({ status: 503, message: 'Service unavailable' });
    const result = normalizeGeminiError(apiErr);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(503);
  });

  it('maps plain network Error to retryable LlmError via normalizeThrownError', () => {
    // Simulate ECONNRESET — arrives as plain Error with .code
    const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const result = normalizeGeminiError(netErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('gemini');
    expect(result.retryable).toBe(true);
  });

  it('passes through LlmError unchanged', () => {
    const llmErr = new LlmError({
      message: 'already wrapped',
      provider: 'gemini',
      retryable: false,
    });
    expect(normalizeGeminiError(llmErr)).toBe(llmErr);
  });
});

describe('normalizePerplexityError — OpenAI SDK error classes (same hierarchy as OpenAI/DeepSeek provider)', () => {
  it('maps OpenAI.APIError 429 to retryable LlmError with perplexity provider', () => {
    const apiErr = OpenAI.APIError.generate(
      429,
      { error: { message: 'Rate limited', type: 'tokens', code: null, param: null } },
      'Rate limited',
      new Headers()
    );
    const result = normalizePerplexityError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('perplexity');
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
    const result = normalizePerplexityError(apiErr);
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('maps OpenAI.APIError 500 to retryable LlmError with perplexity provider', () => {
    const apiErr = OpenAI.APIError.generate(
      500,
      { error: { message: 'Internal error', type: 'server_error', code: null, param: null } },
      'Internal error',
      new Headers()
    );
    const result = normalizePerplexityError(apiErr);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBe(500);
  });

  it('maps OpenAI.APIConnectionError to retryable LlmError with no statusCode', () => {
    const connErr = new OpenAI.APIConnectionError({ message: 'Connection refused' });
    const result = normalizePerplexityError(connErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  it('passes through LlmError unchanged', () => {
    const llmErr = new LlmError({
      message: 'already wrapped',
      provider: 'perplexity',
      retryable: false,
    });
    expect(normalizePerplexityError(llmErr)).toBe(llmErr);
  });

  it('maps OpenAI.APIError with undefined status to non-retryable LlmError with perplexity provider', () => {
    const apiErr = Object.create(OpenAI.APIError.prototype) as InstanceType<typeof OpenAI.APIError>;
    Object.assign(apiErr, { status: undefined, message: 'no status code available' });
    const result = normalizePerplexityError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('perplexity');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBeUndefined();
  });
});

describe('normalizeDeepSeekError — OpenAI SDK error classes (same hierarchy as OpenAI provider)', () => {
  it('maps OpenAI.APIError 429 to retryable LlmError with deepseek provider', () => {
    const apiErr = OpenAI.APIError.generate(
      429,
      { error: { message: 'Rate limited', type: 'tokens', code: null, param: null } },
      'Rate limited',
      new Headers()
    );
    const result = normalizeDeepSeekError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('deepseek');
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
    const result = normalizeDeepSeekError(apiErr);
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBe(401);
  });

  it('maps OpenAI.APIConnectionError to retryable LlmError with no statusCode', () => {
    const connErr = new OpenAI.APIConnectionError({ message: 'Connection refused' });
    const result = normalizeDeepSeekError(connErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.retryable).toBe(true);
    expect(result.statusCode).toBeUndefined();
  });

  it('passes through LlmError unchanged', () => {
    const llmErr = new LlmError({
      message: 'already wrapped',
      provider: 'deepseek',
      retryable: false,
    });
    expect(normalizeDeepSeekError(llmErr)).toBe(llmErr);
  });

  it('maps OpenAI.APIError with undefined status to non-retryable LlmError with deepseek provider', () => {
    // Exercises the else branch (deepseek.ts lines 95-96) where status is undefined.
    // See normalizeOpenAIError test above for why Object.create is used here.
    const apiErr = Object.create(OpenAI.APIError.prototype) as InstanceType<typeof OpenAI.APIError>;
    Object.assign(apiErr, { status: undefined, message: 'no status code available' });
    const result = normalizeDeepSeekError(apiErr);
    expect(result).toBeInstanceOf(LlmError);
    expect(result.provider).toBe('deepseek');
    expect(result.retryable).toBe(false);
    expect(result.statusCode).toBeUndefined();
  });
});
