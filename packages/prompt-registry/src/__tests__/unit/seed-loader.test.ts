import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setPromptRegistryLogger } from '../../logger.js';
import { loadSeedFilesFromDirectory, parseSeedFile } from '../../seed-loader.js';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/prompts', import.meta.url));

describe('parseSeedFile', () => {
  it('parses valid frontmatter + body', async () => {
    const raw = await readFile(`${FIXTURES_DIR}/example-system.md`, 'utf8');
    const entry = parseSeedFile(raw, 'example-system.md');
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe('example-onboarding');
    expect(entry?.type).toBe('system');
    expect(entry?.content).toContain('onboarding assistant');
  });

  it('returns null and logs a warning for a file with no frontmatter', () => {
    const warn = vi.fn();
    setPromptRegistryLogger({ info: vi.fn(), warn, error: vi.fn() });

    const entry = parseSeedFile('just plain text, no frontmatter', 'bad.md');

    expect(entry).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      'PROMPT_SEED_FILE_INVALID',
      expect.objectContaining({ filename: 'bad.md' })
    );

    setPromptRegistryLogger(null);
  });

  it('returns null for frontmatter missing the name field', () => {
    const entry = parseSeedFile('---\ntype: system\n---\nbody text', 'noname.md');
    expect(entry).toBeNull();
  });

  it('returns null for an empty body', () => {
    const entry = parseSeedFile('---\nname: x\n---\n', 'empty.md');
    expect(entry).toBeNull();
  });
});

describe('loadSeedFilesFromDirectory', () => {
  beforeEach(() => {
    setPromptRegistryLogger(null);
  });

  it('loads all valid .md files, skipping malformed ones', async () => {
    const entries = await loadSeedFilesFromDirectory(FIXTURES_DIR);
    expect(entries.some((e) => e.name === 'example-onboarding')).toBe(true);
    // malformed-no-frontmatter.md is present in the fixtures dir but should
    // not produce an entry.
    expect(entries).toHaveLength(1);
  });
});
