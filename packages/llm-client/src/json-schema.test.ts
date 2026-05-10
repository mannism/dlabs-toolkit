/**
 * Unit tests for src/json-schema.ts
 *
 * Covers:
 *   isZodSchema():
 *     - Zod 4 schema returns true
 *     - Zod 3 schema throws LlmError with upgrade message
 *     - Plain object (non-Zod) returns false
 *     - null / primitive returns false
 *
 *   toProviderSchema():
 *     - 'openai' profile: strips $schema, format, pattern, default; all props in required;
 *       additionalProperties:false recursively; nested objects processed
 *     - 'anthropic' profile: strips $schema only; standard JSON Schema passthrough
 *     - 'gemini' profile: strips $schema, additionalProperties, default; recurses
 *     - Unrepresentable schema (z.function()) throws LlmError with escape-hatch message
 */

import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { isZodSchema, toProviderSchema } from './json-schema.js';
import { LlmError } from './types.js';

// ─── isZodSchema ──────────────────────────────────────────────────────────────

describe('isZodSchema()', () => {
  it('returns true for a Zod 4 schema', () => {
    const schema = z.object({ name: z.string() });
    expect(isZodSchema(schema)).toBe(true);
  });

  it('returns true for a Zod 4 string schema', () => {
    expect(isZodSchema(z.string())).toBe(true);
  });

  it('returns true for a Zod 4 array schema', () => {
    expect(isZodSchema(z.array(z.number()))).toBe(true);
  });

  it('throws LlmError with upgrade message for a Zod 3-shaped object (_def present, _zod absent)', () => {
    // Simulate a Zod 3 schema shape (has _def but not _zod)
    const fakeZod3 = { _def: { typeName: 'ZodObject' }, parse: (d: unknown) => d };
    expect(() => isZodSchema(fakeZod3)).toThrow(LlmError);
    expect(() => isZodSchema(fakeZod3)).toThrow(/Zod 3/);
    expect(() => isZodSchema(fakeZod3)).toThrow(/structuredMode.*prompt/);
  });

  it('returns false for a plain narrow-interface schema object (no _zod, no _def)', () => {
    const narrowSchema = { parse: (d: unknown) => d as { ok: boolean } };
    expect(isZodSchema(narrowSchema)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isZodSchema(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isZodSchema('schema')).toBe(false);
  });

  it('returns false for a plain empty object', () => {
    expect(isZodSchema({})).toBe(false);
  });
});

// ─── toProviderSchema — openai profile ────────────────────────────────────────

describe('toProviderSchema() — openai profile', () => {
  it('produces a flat object schema with all required and no $schema', () => {
    const schema = z.object({ topic: z.string(), count: z.number() });
    const result = toProviderSchema(schema, 'openai');

    expect(result['$schema']).toBeUndefined();
    expect(result['type']).toBe('object');
    expect(result['additionalProperties']).toBe(false);
    // All properties must be in required
    expect(result['required']).toEqual(expect.arrayContaining(['topic', 'count']));
    expect((result['required'] as string[]).length).toBe(2);
  });

  it('forces optional fields into required[]', () => {
    // OpenAI strict does not support truly-optional fields; all must be in required
    const schema = z.object({ a: z.string(), b: z.string().optional() });
    const result = toProviderSchema(schema, 'openai');
    const required = result['required'] as string[];
    expect(required).toContain('a');
    expect(required).toContain('b');
  });

  it('strips format and pattern keywords', () => {
    // z.string().email() emits format:'email' and pattern — both should be stripped
    const schema = z.object({ email: z.string().email() });
    const result = toProviderSchema(schema, 'openai');
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect(props['email']?.['format']).toBeUndefined();
    expect(props['email']?.['pattern']).toBeUndefined();
    expect(props['email']?.['type']).toBe('string');
  });

  it('strips default keyword', () => {
    const schema = z.object({ n: z.number().default(42) });
    const result = toProviderSchema(schema, 'openai');
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect(props['n']?.['default']).toBeUndefined();
  });

  it('recurses into nested objects', () => {
    const schema = z.object({ outer: z.object({ inner: z.string() }) });
    const result = toProviderSchema(schema, 'openai');
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    const outer = props['outer'];
    expect(outer?.['additionalProperties']).toBe(false);
    expect(outer?.['required']).toEqual(['inner']);
  });

  it('handles nullable fields (anyOf with null type)', () => {
    const schema = z.object({ value: z.string().nullable() });
    const result = toProviderSchema(schema, 'openai');
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    // nullable produces anyOf:[{type:string},{type:null}] — both branches preserved
    const valueProp = props['value'];
    expect(valueProp?.['anyOf']).toBeDefined();
  });

  it('handles array of objects with recursive post-processing', () => {
    const schema = z.object({ items: z.array(z.object({ id: z.string() })) });
    const result = toProviderSchema(schema, 'openai');
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    const items = props['items'] as Record<string, unknown>;
    const itemSchema = items['items'] as Record<string, unknown>;
    // Nested object in array items must also have additionalProperties:false
    expect(itemSchema['additionalProperties']).toBe(false);
  });
});

// ─── toProviderSchema — anthropic profile ─────────────────────────────────────

describe('toProviderSchema() — anthropic profile', () => {
  it('strips $schema but preserves the rest of the schema', () => {
    const schema = z.object({ topic: z.string(), bullets: z.array(z.string()) });
    const result = toProviderSchema(schema, 'anthropic');

    expect(result['$schema']).toBeUndefined();
    expect(result['type']).toBe('object');
    // Anthropic does not require all-properties-in-required — optional semantics preserved
    expect(result['required']).toEqual(expect.arrayContaining(['topic', 'bullets']));
    expect(result['additionalProperties']).toBe(false);
  });

  it('preserves nested structure without modification', () => {
    const schema = z.object({ nested: z.object({ value: z.number() }) });
    const result = toProviderSchema(schema, 'anthropic');
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect(props['nested']).toBeDefined();
    expect(props['nested']?.['type']).toBe('object');
  });
});

// ─── toProviderSchema — gemini profile ────────────────────────────────────────

describe('toProviderSchema() — gemini profile', () => {
  it('strips $schema, additionalProperties, and default', () => {
    const schema = z.object({ topic: z.string(), count: z.number().default(1) });
    const result = toProviderSchema(schema, 'gemini');

    expect(result['$schema']).toBeUndefined();
    expect(result['additionalProperties']).toBeUndefined();
    // default inside properties should also be stripped
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    expect(props['count']?.['default']).toBeUndefined();
  });

  it('recurses into nested objects removing additionalProperties', () => {
    const schema = z.object({ outer: z.object({ inner: z.string() }) });
    const result = toProviderSchema(schema, 'gemini');
    const props = result['properties'] as Record<string, Record<string, unknown>>;
    const outer = props['outer'];
    expect(outer?.['additionalProperties']).toBeUndefined();
    expect(outer?.['type']).toBe('object');
  });

  it('uses OpenAPI 3.0 target (no top-level $schema vs draft-2020-12)', () => {
    const schema = z.object({ name: z.string() });
    const result = toProviderSchema(schema, 'gemini');
    // openapi-3.0 target does not emit $schema — confirm it is absent
    expect(result['$schema']).toBeUndefined();
  });
});

// ─── toProviderSchema — error cases ───────────────────────────────────────────

describe('toProviderSchema() — unrepresentable schema throws', () => {
  it('throws LlmError with escape-hatch message for z.function()', () => {
    // z.function() is not representable in JSON Schema
    const schema = z.object({ fn: z.function() });
    expect(() => toProviderSchema(schema, 'openai')).toThrow(LlmError);
    expect(() => toProviderSchema(schema, 'openai')).toThrow(/structuredMode.*prompt/);
  });

  it('thrown LlmError is non-retryable with kind:unknown', () => {
    const schema = z.object({ fn: z.function() });
    try {
      toProviderSchema(schema, 'openai');
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError);
      if (e instanceof LlmError) {
        expect(e.retryable).toBe(false);
        expect(e.kind).toBe('unknown');
      }
    }
  });
});
