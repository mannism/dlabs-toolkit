/**
 * Manifest hygiene — structural test (brief-hygiene-manifest-structural-test.md,
 * 2026-09-14).
 *
 * Adapted from brand-compliance-saas's tests/structure/manifests.test.ts
 * (PR #201) — that repo is a single-app `src/`-rooted layout; dlabs-toolkit
 * is a pnpm/Turborepo monorepo with manifests at each package's own
 * manifest.yaml under packages/ (10 packages, not a recursive `src/**` walk).
 * File-discovery and
 * MODULES.md-parity logic are adapted for that layout below;
 * required-field/sentinel-detection logic (findSentinelPaths, isNonEmpty)
 * is ported close to verbatim.
 *
 * Exists because the 2026-09-14 hygiene audit
 * (proj-plan/dlabs-toolkit/research/jo-hygiene-audit-2026-09-14.md, Track B)
 * found no CI-enforced test verifying manifest YAML validity, required-field
 * presence, or MODULES.md parity — this class of drift would otherwise only
 * be caught at the next manual audit cycle. All 10 manifests pass today; this
 * is prevention, not remediation.
 *
 * Required-field scope: manifest-schema.md
 * (/Users/mann/Claude/manifest-schema.md) lists `notes` as a top-level Schema
 * Field alongside name/purpose/owner/status/depends_on/depended_on_by/exports.
 * Unlike brand-compliance-saas's version (which carves `notes` out of
 * REQUIRED_FIELDS for a repo-specific historical reason — see that file's own
 * header), all 10 dlabs-toolkit manifests already carry non-empty `notes` per
 * the audit, so `notes` is included here from the start with no carve-out.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
// esModuleInterop is off repo-wide (tsconfig.base.json) — js-yaml has no
// default export under that setting, so import the namespace.
import * as yaml from 'js-yaml';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();

/** Required top-level fields per manifest-schema.md — see file header. */
const REQUIRED_FIELDS = [
  'name',
  'purpose',
  'owner',
  'status',
  'depends_on',
  'depended_on_by',
  'exports',
  'notes',
] as const;

const SENTINEL_VALUES = new Set(['TODO', '_(populate)_']);

/**
 * `depends_on` / `depended_on_by` are list fields where an empty list is a
 * legitimate value — a zero-runtime-dependency package (e.g. secrets) or a
 * package with no live consumers yet (e.g. secrets, notifier-core's
 * depends_on) is not a hygiene violation. manifest-schema.md requires the
 * *key* to be present (so the field isn't silently omitted), not that the
 * list be non-empty. This diverges from the reference implementation's
 * blanket isNonEmpty check on every REQUIRED_FIELDS entry: 2 of dlabs-toolkit's
 * 10 manifests (packages/secrets, packages/notifier-core) legitimately have
 * one or both of these as `[]`, and brief-hygiene-manifest-structural-test.md
 * AC6 requires all 10 to pass unmodified — see PRESENCE_ONLY_FIELDS below.
 */
const PRESENCE_ONLY_FIELDS = new Set<(typeof REQUIRED_FIELDS)[number]>([
  'depends_on',
  'depended_on_by',
]);

/** For depends_on / depended_on_by: key must exist and hold an array (possibly empty). */
function isPresentList(value: unknown): boolean {
  return Array.isArray(value);
}

/**
 * Finds every packages/<pkg>/manifest.yaml, returning paths relative to the
 * repo root (POSIX-separated). Scoped to the pnpm-workspace.yaml `packages/*`
 * glob (this repo's only qualifying-module location) rather than a recursive
 * `src/**` walk — dlabs-toolkit has no manifests outside `packages/*`.
 */
function findManifestFiles(): string[] {
  const packagesRoot = join(REPO_ROOT, 'packages');
  const entries = readdirSync(packagesRoot, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesRoot, entry.name, 'manifest.yaml');
    if (existsSync(manifestPath)) {
      results.push(relative(REPO_ROOT, manifestPath).split(sep).join('/'));
    }
  }
  return results.sort();
}

/**
 * Recursively walks a parsed manifest value and collects every path whose
 * string value is EXACTLY a sentinel ("TODO" or "_(populate)_") — not a
 * substring match, so a legitimate sentence that happens to contain the
 * word "TODO" would not false-positive.
 */
function findSentinelPaths(value: unknown, path: string): string[] {
  if (typeof value === 'string') {
    return SENTINEL_VALUES.has(value.trim()) ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findSentinelPaths(item, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) =>
      findSentinelPaths(v, path ? `${path}.${key}` : key)
    );
  }
  return [];
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

describe('manifest hygiene — every packages/*/manifest.yaml', () => {
  const manifestFiles = findManifestFiles();

  it('finds at least one manifest (guards against a vacuous pass)', () => {
    expect(manifestFiles.length).toBeGreaterThan(0);
  });

  it('parses every manifest as valid YAML', () => {
    const failures: string[] = [];
    for (const file of manifestFiles) {
      try {
        yaml.load(readFileSync(join(REPO_ROOT, file), 'utf8'));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${file}: ${message.split('\n')[0]}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every required field is present and non-empty on every manifest', () => {
    const failures: string[] = [];
    for (const file of manifestFiles) {
      let parsed: unknown;
      try {
        parsed = yaml.load(readFileSync(join(REPO_ROOT, file), 'utf8'));
      } catch {
        // Already reported by the parse test above — skip here to avoid
        // a duplicate, less-specific failure message for the same file.
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') {
        failures.push(`${file}: does not parse to an object`);
        continue;
      }
      const doc = parsed as Record<string, unknown>;
      for (const field of REQUIRED_FIELDS) {
        const ok = PRESENCE_ONLY_FIELDS.has(field)
          ? isPresentList(doc[field])
          : isNonEmpty(doc[field]);
        if (!ok) {
          failures.push(`${file}: missing or empty required field "${field}"`);
        }
      }
      // manifest-schema.md: depends_on entries each carry a `why` field,
      // depended_on_by entries each carry a `how` field. Only object-shaped
      // entries are checked (bare-string entries, none currently present,
      // are left alone — matches the reference implementation).
      if (Array.isArray(doc['depends_on'])) {
        doc['depends_on'].forEach((item: unknown, i: number) => {
          if (
            item !== null &&
            typeof item === 'object' &&
            !isNonEmpty((item as Record<string, unknown>)['why'])
          ) {
            failures.push(`${file}: depends_on[${i}] missing "why"`);
          }
        });
      }
      if (Array.isArray(doc['depended_on_by'])) {
        doc['depended_on_by'].forEach((item: unknown, i: number) => {
          if (
            item !== null &&
            typeof item === 'object' &&
            !isNonEmpty((item as Record<string, unknown>)['how'])
          ) {
            failures.push(`${file}: depended_on_by[${i}] missing "how"`);
          }
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it('no value anywhere in any manifest equals a TODO or _(populate)_ sentinel', () => {
    const failures: string[] = [];
    for (const file of manifestFiles) {
      let parsed: unknown;
      try {
        parsed = yaml.load(readFileSync(join(REPO_ROOT, file), 'utf8'));
      } catch {
        continue;
      }
      const hits = findSentinelPaths(parsed, '');
      for (const hit of hits) {
        failures.push(`${file}: sentinel value at "${hit}"`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every packages/*/manifest.yaml has a corresponding MODULES.md row', () => {
    const modulesMd = readFileSync(join(REPO_ROOT, 'MODULES.md'), 'utf8');
    const missing = manifestFiles.filter((file) => !modulesMd.includes(file));
    expect(missing).toEqual([]);
  });

  it('every MODULES.md packages/*/manifest.yaml link target exists on disk', () => {
    const modulesMd = readFileSync(join(REPO_ROOT, 'MODULES.md'), 'utf8');
    // Scoped to packages/<pkg>/manifest.yaml relative-path targets only —
    // MODULES.md also carries a non-package link (the "Schema:" line points
    // at an external https:// URL), so a generic "every markdown link
    // target must exist on disk" regex would false-positive on that line.
    // This is the file-discovery/parity adaptation point called out in
    // brief-hygiene-manifest-structural-test.md — the reference
    // implementation's generic link regex doesn't directly port.
    const linkRe = /\[`[^`]+`\]\((packages\/[^/]+\/manifest\.yaml)\)/g;
    const brokenLinks: string[] = [];
    const foundTargets: string[] = [];
    // Reassignment is its own statement (not inside the while condition) to
    // satisfy biome's lint/suspicious/noAssignInExpressions rule.
    let match: RegExpExecArray | null = linkRe.exec(modulesMd);
    while (match) {
      const target = match[1] as string;
      foundTargets.push(target);
      if (!existsSync(join(REPO_ROOT, target))) {
        brokenLinks.push(target);
      }
      match = linkRe.exec(modulesMd);
    }
    // Guard against a regex/format change silently emptying this check.
    expect(foundTargets.length).toBeGreaterThan(0);
    expect(brokenLinks).toEqual([]);
  });
});
