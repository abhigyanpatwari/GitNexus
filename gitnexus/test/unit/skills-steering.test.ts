import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// Regression guard (#1939): the committed skill files an agent loads alongside
// the generated freshness line must not steer users to `npx gitnexus analyze`
// (the npm-11 arborist install-crash path). The freshness command uses the pnpm
// pre-`dlx` `--allow-build` form, honored since pnpm 10.2 — the post-`dlx`
// position is rejected as a package spec on pnpm 10.2–10.13.x.
//
// Pure file reads resolved via path.resolve — deterministic, no host-PATH or
// glob-CWD dependence, so this needs no cross-platform-tests.ts registration.

const GITNEXUS_ROOT = path.resolve(__dirname, '..', '..'); // gitnexus/test/unit -> gitnexus/
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..'); // -> monorepo root

function collectSkillFiles(): string[] {
  const files: string[] = [];

  // Bundled ship source: flat *.md files installSkills() copies to new users.
  const bundled = path.join(GITNEXUS_ROOT, 'skills');
  if (existsSync(bundled)) {
    for (const f of readdirSync(bundled)) {
      if (f.endsWith('.md')) files.push(path.join(bundled, f));
    }
  }

  // Per-skill <name>/SKILL.md copies across the other distribution locations.
  const skillRoots = [
    path.join(REPO_ROOT, '.claude', 'skills', 'gitnexus'),
    path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills'),
    path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills'),
  ];
  for (const root of skillRoots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const skillMd = path.join(root, dir, 'SKILL.md');
      if (existsSync(skillMd)) files.push(skillMd);
    }
  }

  return files;
}

describe('skill-file steering (#1939)', () => {
  const files = collectSkillFiles();

  it('collects skill files from all four committed locations (guard is not vacuous)', () => {
    const rels = files.map((f) => path.relative(REPO_ROOT, f));
    expect(rels.some((r) => r.startsWith(`gitnexus${path.sep}skills${path.sep}`))).toBe(true);
    expect(
      rels.some((r) => r.startsWith(path.join('.claude', 'skills', 'gitnexus') + path.sep)),
    ).toBe(true);
    expect(
      rels.some((r) => r.startsWith(path.join('gitnexus-claude-plugin', 'skills') + path.sep)),
    ).toBe(true);
    expect(
      rels.some((r) => r.startsWith(path.join('gitnexus-cursor-integration', 'skills') + path.sep)),
    ).toBe(true);
  });

  it('no committed skill file steers users to `npx gitnexus analyze`', () => {
    const offenders = files.filter((f) =>
      /npx\s+gitnexus\s+analyze/.test(readFileSync(f, 'utf-8')),
    );
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('uses the pnpm pre-`dlx` --allow-build form, never the broken post-`dlx` position', () => {
    // `pnpm dlx --allow-build=…` (flags after `dlx`) is parsed as a package spec
    // and rejected on pnpm 10.2–10.13.x; the flags must precede `dlx` (#1939).
    const postDlxOffenders = files.filter((f) =>
      /pnpm dlx --allow-build/.test(readFileSync(f, 'utf-8')),
    );
    expect(postDlxOffenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);

    // …and the canonical pre-`dlx` freshness command is actually present (guard
    // is not vacuous: at least the cli/guide/exploring skills carry it).
    const PRE_DLX =
      'pnpm --allow-build=@ladybugdb/core --allow-build=gitnexus --allow-build=tree-sitter dlx gitnexus@latest analyze';
    const withFreshness = files.filter((f) => readFileSync(f, 'utf-8').includes(PRE_DLX));
    expect(withFreshness.length).toBeGreaterThan(0);
  });
});
