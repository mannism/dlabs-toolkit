#!/usr/bin/env node
/**
 * sync-bundled.mjs
 *
 * Regenerates packages/llm-pricing/src/table.ts from pricing/table.json.
 *
 * Run after every edit to table.json — commit both files together.
 *
 * Usage:
 *   node pricing/sync-bundled.mjs          # regenerate table.ts
 *   node pricing/sync-bundled.mjs --check  # exit 1 if table.ts is out of date
 *
 * The generated file is byte-for-byte reproducible: same table.json → same table.ts.
 * CI can run --check to guard against accidental drift.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const JSON_PATH = resolve(ROOT, 'pricing', 'table.json');
const TS_PATH = resolve(ROOT, 'packages', 'llm-pricing', 'src', 'table.ts');

// ─── Load + validate minimal shape ──────────────────────────────────────────

const raw = readFileSync(JSON_PATH, 'utf8');
const data = JSON.parse(raw);

const REQUIRED_PROVIDERS = ['anthropic', 'openai', 'gemini', 'deepseek', 'perplexity'];
for (const p of REQUIRED_PROVIDERS) {
  if (typeof data[p] !== 'object' || data[p] === null) {
    console.error(`sync-bundled: table.json is missing required provider "${p}"`);
    process.exit(1);
  }
}
if (typeof data.versionedAt !== 'string') {
  console.error('sync-bundled: table.json is missing "versionedAt" field');
  process.exit(1);
}

// ─── Code generation ─────────────────────────────────────────────────────────

/**
 * Serialize a string as a single-quoted TypeScript string literal (Biome style).
 * Escapes single quotes inside the string.
 */
function toTsString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Serialize a JS value to a TypeScript literal.
 * - strings: single-quoted (Biome style)
 * - numbers: as-is
 * - booleans: as-is
 * - null: null
 * - objects: key: value, pairs (sorted for determinism)
 * - arrays: not expected in pricing data; treated as JSON
 */
function toTsLiteral(value, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);

  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return toTsString(value);
  if (Array.isArray(value)) return JSON.stringify(value);

  // Object — sort keys for determinism
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return '{}';
  const pairs = keys.map((k) => {
    const v = toTsLiteral(value[k], indent + 2);
    return `${inner}${toTsKey(k)}: ${v},`;
  });
  return `{\n${pairs.join('\n')}\n${pad}}`;
}

/**
 * Serialize an object key. Unquoted if it's a valid JS identifier,
 * single-quoted otherwise (model IDs with hyphens need quoting).
 */
function toTsKey(key) {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : toTsString(key);
}

/** Render a single provider block as a TypeScript object literal. */
function renderProvider(providerName, models, baseIndent) {
  const pad = ' '.repeat(baseIndent);
  const modelPad = ' '.repeat(baseIndent + 2);
  const fieldPad = ' '.repeat(baseIndent + 4);

  const modelKeys = Object.keys(models).sort();
  const modelBlocks = modelKeys.map((modelId) => {
    const pricing = models[modelId];
    const fields = Object.keys(pricing).sort();
    const fieldLines = fields.map((f) => {
      return `${fieldPad}${toTsKey(f)}: ${toTsLiteral(pricing[f], baseIndent + 4)},`;
    });
    return `${modelPad}${toTsKey(modelId)}: {\n${fieldLines.join('\n')}\n${modelPad}},`;
  });

  return `${pad}${providerName}: {\n${modelBlocks.join('\n')}\n${pad}},`;
}

// Build the full table literal
const providerBlocks = REQUIRED_PROVIDERS.map((p) =>
  renderProvider(p, data[p], 2)
).join('\n\n');

const generated = `\
/**
 * Default pricing table for @diabolicallabs/llm-pricing.
 *
 * AUTO-GENERATED — do not edit directly.
 * Source of truth: pricing/table.json
 * Regenerate: node pricing/sync-bundled.mjs
 *
 * Data sourced from Tom's Wave 2a pricing snapshot (2026-05-13).
 * Confidence: High for Anthropic, Gemini, DeepSeek, Perplexity (first-party docs).
 *             Medium for OpenAI (primary pricing page 403'd; cross-referenced from
 *             pricepertoken.com + devtk.ai + OpenRouter — all consistent).
 *
 * All prices are USD per 1 million tokens.
 *
 * Maintenance: edit pricing/table.json + run node pricing/sync-bundled.mjs.
 * See pricing/README.md for the full refresh workflow.
 *
 * IMPORTANT: deepseek-v4-pro has a 75% promotional discount active through 2026-05-31.
 * Post-discount rates will be approx 4x current. See verifiedAt + sourceUrl.
 */

import type { PricingTable } from './types.js';

export const DEFAULT_PRICING_TABLE: PricingTable = {
  versionedAt: ${toTsString(data.versionedAt)},

${providerBlocks}
};
`;

// ─── Check mode ──────────────────────────────────────────────────────────────

const checkMode = process.argv.includes('--check');

if (checkMode) {
  let current;
  try {
    current = readFileSync(TS_PATH, 'utf8');
  } catch {
    console.error('sync-bundled --check: table.ts does not exist');
    process.exit(1);
  }

  const generatedHash = createHash('sha256').update(generated).digest('hex');
  const currentHash = createHash('sha256').update(current).digest('hex');

  if (generatedHash !== currentHash) {
    console.error(
      'sync-bundled --check: FAIL — packages/llm-pricing/src/table.ts is out of date.\n' +
      'Run: node pricing/sync-bundled.mjs\n' +
      'Then commit both pricing/table.json and packages/llm-pricing/src/table.ts together.'
    );
    process.exit(1);
  }

  console.log('sync-bundled --check: OK — table.ts matches table.json');
  process.exit(0);
}

// ─── Write ────────────────────────────────────────────────────────────────────

writeFileSync(TS_PATH, generated, 'utf8');
console.log(`sync-bundled: wrote ${TS_PATH}`);
console.log(`sync-bundled: versionedAt = ${data.versionedAt}`);
