/**
 * Repo-file seed loader — admin-standard §S7: "prompt source-of-truth files
 * stay in the repo as seeds, served from DB at runtime." Parses YAML-ish
 * frontmatter `.md` files into SeedPromptEntry records for registry.seed().
 *
 * Frontmatter format (matches the FitCheckerApp reference implementation —
 * see README.md migration guide):
 *
 *   ---
 *   name: onboarding
 *   type: system
 *   ---
 *   You are a helpful assistant...
 *
 * `type` is optional in the frontmatter (defaults to DEFAULT_PROMPT_TYPE).
 * Files that fail to parse are skipped with a warn-level log — a malformed
 * seed file must never crash a deploy's seed step; it should surface loudly
 * in logs and let the admin fix the file on their own schedule.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getLogger } from './logger.js';
import type { SeedPromptEntry } from './types.js';
import { DEFAULT_PROMPT_TYPE } from './types.js';

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  const normalized = raw.replace(/\r\n/g, '\n');
  const match = normalized.match(FRONTMATTER_PATTERN);
  if (!match) return null;

  const [, frontmatter, body] = match;
  const meta: Record<string, string> = {};
  for (const line of (frontmatter ?? '').split('\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) meta[key] = value;
  }

  return { meta, body: (body ?? '').replace(/\n+$/, '') };
}

/**
 * Parses one prompt markdown file's raw text into a SeedPromptEntry.
 * Returns null (and logs PROMPT_SEED_FILE_INVALID) if the file lacks valid
 * frontmatter or a `name` field.
 */
export function parseSeedFile(raw: string, filename: string): SeedPromptEntry | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    getLogger().warn('PROMPT_SEED_FILE_INVALID', { filename, reason: 'missing_frontmatter' });
    return null;
  }

  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, string>
  const name = parsed.meta['name'];
  if (!name) {
    getLogger().warn('PROMPT_SEED_FILE_INVALID', { filename, reason: 'missing_name' });
    return null;
  }

  if (!parsed.body.trim()) {
    getLogger().warn('PROMPT_SEED_FILE_INVALID', { filename, reason: 'empty_body' });
    return null;
  }

  const entry: SeedPromptEntry = {
    name,
    // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, string>
    type: parsed.meta['type'] ?? DEFAULT_PROMPT_TYPE,
    content: parsed.body,
  };
  // biome-ignore lint/complexity/useLiteralKeys: TS noPropertyAccessFromIndexSignature requires bracket access on Record<string, string>
  if (parsed.meta['changeNotes']) entry.changeNotes = parsed.meta['changeNotes'];
  return entry;
}

/**
 * Reads every `.md` file in `dir` and parses it into a SeedPromptEntry.
 * Files that fail to parse are skipped (logged, not thrown) — see module doc.
 * Pass the result directly to registry.seed().
 */
export async function loadSeedFilesFromDirectory(dir: string): Promise<SeedPromptEntry[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const entries: SeedPromptEntry[] = [];

  for (const file of files) {
    const raw = await readFile(join(dir, file), 'utf8');
    const entry = parseSeedFile(raw, file);
    if (entry) entries.push(entry);
  }

  return entries;
}
