/**
 * JSON Schema conversion utilities for @diabolicallabs/llm-client structured outputs.
 *
 * Exports:
 *   isZodSchema(s)            — runtime Zod 4 detection via the `_zod` internal marker.
 *                               Throws a clear "upgrade to Zod 4" error if a Zod 3 schema
 *                               is passed. Returns false for any non-Zod value.
 *   toProviderSchema(schema, profile)
 *                             — Converts a Zod 4 schema to a provider-specific JSON Schema.
 *                               Profiles: 'openai' | 'anthropic' | 'gemini'.
 *                               Uses Zod 4's built-in z.toJSONSchema() — no external dep.
 *                               Throws LlmError (kind:'unknown', retryable:false) when the
 *                               schema contains unrepresentable features. Callers can opt out
 *                               by passing providerOptions.structuredMode = 'prompt'.
 *
 * Profile post-processors:
 *   openai    — Removes $schema, strips format/pattern/default/examples, moves all
 *               properties into required[] (OpenAI strict requires every property listed),
 *               ensures additionalProperties:false recursively.
 *   anthropic — Removes $schema only. Anthropic's tool input_schema accepts standard
 *               JSON Schema; no further transformation needed.
 *   gemini    — Removes $schema and additionalProperties/default/examples. Inline $ref
 *               is not expected from Zod 4 output with unrepresentable:'throw', so no
 *               $ref flattening is needed in practice.
 *
 * v0.4.0 addition.
 */

import { z } from 'zod';
import { LlmError } from './types.js';

/** Target provider profile for JSON Schema post-processing in toProviderSchema(). */
export type SchemaProfile = 'openai' | 'anthropic' | 'gemini';

/**
 * Loose JSON Schema node type for internal post-processing and test assertions.
 * We use an interface with known fields typed explicitly — this allows Biome's
 * useLiteralKeys rule to pass while satisfying TypeScript's
 * noPropertyAccessFromIndexSignature constraint (no index signature here).
 * Exported for use in unit tests.
 */
export interface JsonNode {
  $schema?: unknown;
  type?: unknown;
  properties?: Record<string, JsonNode>;
  required?: string[];
  additionalProperties?: unknown;
  format?: unknown;
  pattern?: unknown;
  default?: unknown;
  examples?: unknown;
  items?: JsonNode | unknown;
  anyOf?: JsonNode[];
  oneOf?: JsonNode[];
  allOf?: JsonNode[];
  prefixItems?: JsonNode[];
  // Catch-all for other JSON Schema keywords we pass through unchanged
  [key: string]: unknown;
}

/**
 * Runtime Zod 4 schema detector.
 *
 * Zod 4 schemas have a `_zod` property (object) that is absent in Zod 3.
 * Zod 3 schemas have a `_def` property instead.
 *
 * Returns true only for Zod 4 schemas that also expose a `parse` function
 * (the minimum interface needed for defense-in-depth validation).
 *
 * Throws LlmError if a Zod 3 schema is detected — never silently falls through
 * to prompt mode, so callers see a clear upgrade message rather than a silent
 * capability downgrade.
 */
export function isZodSchema(s: unknown): s is z.ZodType {
  if (typeof s !== 'object' || s === null) return false;

  const hasZod4Marker = '_zod' in s && typeof (s as { _zod: unknown })._zod === 'object';
  const hasZod3Marker = '_def' in s;

  if (hasZod3Marker && !hasZod4Marker) {
    throw new LlmError({
      message:
        'llm-client: detected a Zod 3 schema. Upgrade to Zod 4 to use strict structured-output mode, or pass providerOptions.structuredMode = "prompt" to keep the v0.3.0 prompt-only path.',
      provider: 'llm-client',
      retryable: false,
      kind: 'unknown',
    });
  }

  if (!hasZod4Marker) return false;

  // Guard: must also have a parse function (the narrow interface used by structured()).
  // Cast through unknown to avoid TS2352 overlap error on the _zod-marked type.
  return typeof (s as unknown as { parse: unknown }).parse === 'function';
}

/**
 * Convert a Zod 4 schema to a provider-specific JSON Schema object.
 *
 * Throws LlmError if:
 *   - z.toJSONSchema throws (unrepresentable feature: z.function(), z.lazy(), etc.)
 *   - Profile post-processing encounters an unexpected structure
 *
 * Callers that need to avoid the throw can opt out by passing
 * providerOptions.structuredMode = 'prompt' before calling structured().
 */
export function toProviderSchema(schema: z.ZodType, profile: SchemaProfile): JsonNode {
  // Gemini uses OpenAPI 3.0 dialect; OpenAI and Anthropic use JSON Schema draft-2020-12.
  const target: 'openapi-3.0' | 'draft-2020-12' =
    profile === 'gemini' ? 'openapi-3.0' : 'draft-2020-12';

  let json: JsonNode;
  try {
    json = z.toJSONSchema(schema, {
      target,
      unrepresentable: 'throw',
      cycles: 'throw',
    }) as JsonNode;
  } catch (e) {
    throw new LlmError({
      message: `llm-client: schema is not representable for ${profile} strict mode — ${(e as Error).message}. Pass providerOptions.structuredMode = 'prompt' to fall back to prompt-only mode.`,
      provider: profile,
      retryable: false,
      kind: 'unknown',
      cause: e,
    });
  }

  if (profile === 'openai') return openAIStrictPostprocess(json);
  if (profile === 'gemini') return geminiPostprocess(json);
  // Anthropic: just remove $schema
  return anthropicPostprocess(json);
}

// ─── OpenAI Structured Outputs post-processor ────────────────────────────────

/**
 * Transforms a JSON Schema into OpenAI Structured Outputs-compatible form.
 *
 * OpenAI strict mode requirements:
 *   1. No $schema keyword (top-level)
 *   2. Every property key listed in `required` (optional fields not supported — all props required)
 *   3. additionalProperties: false on every object node (Zod 4 already sets this, but enforce recursively)
 *   4. No `format`, `pattern`, `default`, `examples` keywords (stripped silently)
 *   5. Nested objects: rules apply recursively
 *
 * Reference: https://platform.openai.com/docs/guides/structured-outputs/supported-schemas
 */
function openAIStrictPostprocess(node: unknown): JsonNode {
  if (typeof node !== 'object' || node === null) {
    return node as JsonNode;
  }

  if (Array.isArray(node)) {
    return node.map(openAIStrictPostprocess) as unknown as JsonNode;
  }

  const src = node as JsonNode;
  const obj: JsonNode = { ...src };

  // Strip top-level $schema and unsupported keywords
  delete obj.$schema;
  delete obj.format;
  delete obj.pattern;
  delete obj.default;
  delete obj.examples;

  // Object nodes: enforce required contains all properties, additionalProperties:false
  if (obj.type === 'object' && obj.properties !== undefined) {
    const props = obj.properties;
    const allKeys = Object.keys(props);

    // All properties must be listed in required (OpenAI strict requirement)
    obj.required = allKeys;
    obj.additionalProperties = false;

    // Recurse into property schemas
    const processedProps: Record<string, JsonNode> = {};
    for (const key of allKeys) {
      processedProps[key] = openAIStrictPostprocess(props[key]);
    }
    obj.properties = processedProps;
  }

  // Recurse into array items
  if (obj.items !== undefined) {
    obj.items = openAIStrictPostprocess(obj.items);
  }

  // Recurse into anyOf / oneOf / allOf
  if (Array.isArray(obj.anyOf)) {
    obj.anyOf = obj.anyOf.map(openAIStrictPostprocess);
  }
  if (Array.isArray(obj.oneOf)) {
    obj.oneOf = obj.oneOf.map(openAIStrictPostprocess);
  }
  if (Array.isArray(obj.allOf)) {
    obj.allOf = obj.allOf.map(openAIStrictPostprocess);
  }

  // Recurse into prefixItems (tuple types)
  if (Array.isArray(obj.prefixItems)) {
    obj.prefixItems = obj.prefixItems.map(openAIStrictPostprocess);
  }

  return obj;
}

// ─── Anthropic post-processor ─────────────────────────────────────────────────

/**
 * Minimal post-processing for Anthropic tool input_schema.
 * Anthropic accepts standard JSON Schema; only the $schema keyword is removed
 * since it is not part of the tool input_schema contract.
 */
function anthropicPostprocess(node: JsonNode): JsonNode {
  const obj: JsonNode = { ...node };
  delete obj.$schema;
  return obj;
}

// ─── Gemini post-processor ────────────────────────────────────────────────────

/**
 * Transforms a JSON Schema (OpenAPI 3.0 target) into Gemini responseSchema form.
 *
 * Gemini responseSchema requirements:
 *   1. No $schema keyword
 *   2. No additionalProperties (Gemini's SDK doesn't accept it in responseSchema)
 *   3. No default or examples keywords
 *   4. Recursive — nested objects and arrays must be cleaned too
 *   5. No $ref — Zod 4 with cycles:'throw' prevents cycles, so $ref should not appear
 *
 * Gemini-specific constraint (Item 1.3):
 *   OBJECT schemas with empty `properties: {}` are rejected by the Gemini API.
 *   When detected, a sentinel property `_placeholder` is injected. The sentinel
 *   must be stripped from the response before Zod parse — see stripGeminiSentinel().
 *
 * Reference: https://ai.google.dev/api/generate-content#v1beta.GenerationConfig.response_schema
 */
function geminiPostprocess(node: unknown): JsonNode {
  if (typeof node !== 'object' || node === null) {
    return node as JsonNode;
  }

  if (Array.isArray(node)) {
    return node.map(geminiPostprocess) as unknown as JsonNode;
  }

  const src = node as JsonNode;
  const obj: JsonNode = { ...src };

  // Remove unsupported keywords
  delete obj.$schema;
  delete obj.additionalProperties;
  delete obj.default;
  delete obj.examples;

  // Recurse into object properties, then inject sentinel for empty OBJECT schemas.
  // Gemini rejects OBJECT type with empty properties:{} — inject _placeholder so the
  // API accepts the schema, then strip it from the response before Zod parse.
  if (obj.type === 'object') {
    if (obj.properties !== undefined) {
      const props = obj.properties;
      const processedProps: Record<string, JsonNode> = {};
      for (const key of Object.keys(props)) {
        processedProps[key] = geminiPostprocess(props[key]);
      }
      if (Object.keys(processedProps).length === 0) {
        // Empty properties — inject sentinel property
        // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket notation on Record<string, T>
        processedProps['_placeholder'] = { type: 'string', description: '_placeholder sentinel' };
      }
      obj.properties = processedProps;
    } else {
      // No properties at all — add empty object and then inject sentinel
      obj.properties = {
        _placeholder: { type: 'string', description: '_placeholder sentinel' },
      };
    }
  } else if (obj.properties !== undefined) {
    // Non-object node with properties (shouldn't happen but recurse defensively)
    const props = obj.properties;
    const processedProps: Record<string, JsonNode> = {};
    for (const key of Object.keys(props)) {
      processedProps[key] = geminiPostprocess(props[key]);
    }
    obj.properties = processedProps;
  }

  // Recurse into array items
  if (obj.items !== undefined) {
    obj.items = geminiPostprocess(obj.items);
  }

  // Recurse into anyOf / oneOf / allOf
  if (Array.isArray(obj.anyOf)) {
    obj.anyOf = obj.anyOf.map(geminiPostprocess);
  }
  if (Array.isArray(obj.oneOf)) {
    obj.oneOf = obj.oneOf.map(geminiPostprocess);
  }
  if (Array.isArray(obj.allOf)) {
    obj.allOf = obj.allOf.map(geminiPostprocess);
  }

  return obj;
}

/**
 * Strip `_placeholder` sentinel properties injected by geminiPostprocess to satisfy
 * Gemini's empty-object constraint. Call this on parsed JSON before Zod parse.
 *
 * The sentinel may appear at any depth — recurse. No-op for non-object/array values.
 * Exported for use in gemini.ts structured() and withTools() paths.
 */
export function stripGeminiSentinel(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;

  if (Array.isArray(value)) {
    return value.map(stripGeminiSentinel);
  }

  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key === '_placeholder') continue;
    result[key] = stripGeminiSentinel(obj[key]);
  }
  return result;
}
