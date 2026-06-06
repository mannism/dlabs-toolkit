/**
 * Unit tests for types.ts — specifically LlmError, which has runtime behavior.
 *
 * LlmMessage, LlmUsage, LlmResponse, etc. are pure interfaces with no runtime
 * behavior to test — their correctness is enforced at compile time.
 */

import { describe, expect, it } from 'vitest';
import type { LlmContentBlock } from './types.js';
import { LlmError } from './types.js';

describe('LlmError', () => {
  it('is an instance of Error', () => {
    const err = new LlmError({ message: 'test', provider: 'anthropic', retryable: false });
    expect(err).toBeInstanceOf(Error);
  });

  it('has name LlmError', () => {
    const err = new LlmError({ message: 'test', provider: 'openai', retryable: false });
    expect(err.name).toBe('LlmError');
  });

  it('stores provider, statusCode, retryable correctly', () => {
    const err = new LlmError({
      message: 'rate limited',
      provider: 'anthropic',
      statusCode: 429,
      retryable: true,
    });
    expect(err.provider).toBe('anthropic');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('rate limited');
  });

  it('statusCode is undefined when not provided', () => {
    const err = new LlmError({ message: 'network error', provider: 'openai', retryable: true });
    expect(err.statusCode).toBeUndefined();
  });

  it('stores cause', () => {
    const cause = new Error('root cause');
    const err = new LlmError({
      message: 'wrapped',
      provider: 'openai',
      retryable: false,
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it('retryable: false for auth errors', () => {
    const err = new LlmError({
      message: 'Unauthorized',
      provider: 'openai',
      statusCode: 401,
      retryable: false,
    });
    expect(err.retryable).toBe(false);
  });

  it('can be caught as instanceof LlmError after being thrown', () => {
    const err = new LlmError({ message: 'test', provider: 'test', retryable: false });
    let caught: unknown;
    try {
      throw err;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmError);
  });
});

// ─── Multimodal content block types (v4.2.0) ─────────────────────────────────

describe('LlmContentBlock type exports', () => {
  it('LlmContentBlock is importable from the package index (type-level test)', async () => {
    // Dynamic import verifies the module exports correctly at runtime.
    // TypeScript type checking handles the shape — this just confirms the export is present.
    const mod = await import('./index.js');
    // LlmContentBlock is a type-only export; verify the module loads without errors.
    // We also verify LlmError (a value export) as a proxy for the module being valid.
    expect(typeof mod.LlmError).toBe('function');
  });

  it('LlmContentBlock text block can be constructed with correct shape', () => {
    const block: LlmContentBlock = { type: 'text', text: 'Hello' };
    expect(block).toMatchObject({ type: 'text', text: 'Hello' });
  });

  it('LlmContentBlock image.base64 block has correct shape', () => {
    const block: LlmContentBlock = {
      type: 'image',
      source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc123' },
    };
    expect(block).toMatchObject({
      type: 'image',
      source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc123' },
    });
  });

  it('LlmContentBlock document block has correct shape', () => {
    const block: LlmContentBlock = {
      type: 'document',
      source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfbytes' },
    };
    expect(block).toMatchObject({
      type: 'document',
      source: { type: 'base64', mediaType: 'application/pdf' },
    });
  });
});
