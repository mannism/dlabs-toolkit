/**
 * Live smoke test for Gemini provider structured() edge cases.
 *
 * Validates that the geminiPostprocess() sentinel injection and stripGeminiSentinel()
 * stripping work correctly for all JSON Schema shapes that previously failed.
 * Covers the brief's Item 1.3 requirement (empty-object OBJECT schema fix).
 *
 * Run from monorepo root:
 *   export $(grep -v '^#' .env | xargs) && npx tsx --tsconfig scripts/tsconfig.json scripts/smoke-gemini-structured.ts
 *
 * Env var: GOOGLE_AI_API_KEY
 *
 * Schemas exercised:
 *   1. Empty OBJECT (would crash Gemini without the sentinel fix)
 *   2. Nested OBJECT with multiple levels
 *   3. Array of OBJECTs
 *   4. Optional fields (union with null / undefined via .optional())
 *   5. Enum values
 *   6. anyOf union
 */

import { z } from 'zod';
import { createClientFromEnv } from '../packages/llm-client/src/index.js';

const MODEL = 'gemini-2.5-flash';

async function runSmoke(): Promise<void> {
  const apiKey = process.env['GOOGLE_AI_API_KEY'];
  if (!apiKey) {
    throw new Error('GOOGLE_AI_API_KEY not set. Source .env before running.');
  }

  console.log('=== Gemini Structured Output Smoke Test ===\n');

  const client = createClientFromEnv('gemini', MODEL);
  let passed = 0;
  let failed = 0;

  // ─── Case 1: Empty OBJECT schema ─────────────────────────────────────────
  // Gemini rejects OBJECT schemas with empty properties:{} — sentinel must be injected.
  console.log('Case 1: Empty OBJECT schema (sentinel injection)');
  try {
    const emptySchema = z.object({});
    const result = await client.structured(
      [
        {
          role: 'user',
          content:
            'Return an empty JSON object. Do not include any fields, just return {}.',
        },
      ],
      emptySchema
    );
    // The sentinel _placeholder must have been stripped before Zod parse
    const keys = Object.keys(result.data as object);
    if (keys.includes('_placeholder')) {
      throw new Error('Sentinel _placeholder leaked into parsed data');
    }
    console.log(`  data: ${JSON.stringify(result.data)}`);
    console.log('  PASS\n');
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${String(e)}\n`);
    failed++;
  }

  // ─── Case 2: Nested OBJECT ───────────────────────────────────────────────
  console.log('Case 2: Nested OBJECT schema');
  try {
    const nestedSchema = z.object({
      person: z.object({
        name: z.string(),
        age: z.number(),
        address: z.object({
          city: z.string(),
          country: z.string(),
        }),
      }),
    });
    const result = await client.structured(
      [
        {
          role: 'user',
          content:
            'Return a JSON object with a person field containing name "Alice", age 30, and address with city "London" and country "UK".',
        },
      ],
      nestedSchema
    );
    if (typeof result.data.person.name !== 'string') {
      throw new Error('Expected person.name to be a string');
    }
    console.log(`  data: ${JSON.stringify(result.data)}`);
    console.log('  PASS\n');
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${String(e)}\n`);
    failed++;
  }

  // ─── Case 3: Array of OBJECTs ────────────────────────────────────────────
  console.log('Case 3: Array of OBJECTs');
  try {
    const arraySchema = z.object({
      items: z.array(
        z.object({
          id: z.number(),
          label: z.string(),
        })
      ),
    });
    const result = await client.structured(
      [
        {
          role: 'user',
          content:
            'Return a JSON object with an items array containing exactly 2 items: {id:1, label:"first"} and {id:2, label:"second"}.',
        },
      ],
      arraySchema
    );
    if (!Array.isArray(result.data.items) || result.data.items.length < 1) {
      throw new Error('Expected non-empty items array');
    }
    console.log(`  data: ${JSON.stringify(result.data)}`);
    console.log('  PASS\n');
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${String(e)}\n`);
    failed++;
  }

  // ─── Case 4: Optional fields ─────────────────────────────────────────────
  console.log('Case 4: Optional fields');
  try {
    const optionalSchema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
      score: z.number(),
    });
    const result = await client.structured(
      [
        {
          role: 'user',
          content:
            'Return a JSON object with name "Bob", no nickname field, and score 42.',
        },
      ],
      optionalSchema
    );
    if (typeof result.data.name !== 'string') {
      throw new Error('Expected name to be a string');
    }
    console.log(`  data: ${JSON.stringify(result.data)}`);
    console.log('  PASS\n');
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${String(e)}\n`);
    failed++;
  }

  // ─── Case 5: Enum values ─────────────────────────────────────────────────
  console.log('Case 5: Enum values');
  try {
    const enumSchema = z.object({
      status: z.enum(['active', 'inactive', 'pending']),
      priority: z.enum(['low', 'medium', 'high']),
    });
    const result = await client.structured(
      [
        {
          role: 'user',
          content:
            'Return a JSON object with status "active" and priority "high".',
        },
      ],
      enumSchema
    );
    if (!['active', 'inactive', 'pending'].includes(result.data.status)) {
      throw new Error(`Invalid status: ${result.data.status}`);
    }
    console.log(`  data: ${JSON.stringify(result.data)}`);
    console.log('  PASS\n');
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${String(e)}\n`);
    failed++;
  }

  // ─── Case 6: anyOf union ─────────────────────────────────────────────────
  console.log('Case 6: anyOf union (string | number)');
  try {
    const unionSchema = z.object({
      result: z.union([z.string(), z.number()]),
      label: z.string(),
    });
    const result = await client.structured(
      [
        {
          role: 'user',
          content:
            'Return a JSON object with result equal to 42 and label "answer".',
        },
      ],
      unionSchema
    );
    console.log(`  data: ${JSON.stringify(result.data)}`);
    console.log('  PASS\n');
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${String(e)}\n`);
    failed++;
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

runSmoke().catch((e: unknown) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
