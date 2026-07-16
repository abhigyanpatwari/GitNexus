import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// Steering policy (#1939, #1945): the committed skill files route gitnexus
// commands through the project-local runner `gitnexus analyze` drops next to the
// index (`node .gitnexus/run.cjs <command>`). That one CLI-neutral command
// resolves the available runner (global `gitnexus` → `pnpm dlx` → `npx`) at call
// time, so the docs make no package-manager assumption. The runner only exists
// after the first analyze, so the cli skill documents a bootstrap path (and the
// npm-11 `node.target is null` npx install-crash escape hatch). When the pnpm
// fallback is shown it must use the pre-`dlx` `--allow-build` position (honored
// since pnpm 10.2); the post-`dlx` position is rejected as a package spec on
// pnpm 10.2–10.13.x.
//
// Pure file reads resolved via path.resolve — deterministic, no host-PATH or
// glob-CWD dependence, so this needs no cross-platform-tests.ts registration.

const GITNEXUS_ROOT = path.resolve(__dirname, '..', '..'); // gitnexus/test/unit -> gitnexus/
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..'); // -> monorepo root

function collectSkillFiles(): string[] {
  const files: string[] = [];
  const projectSkillsRoot = path.join(REPO_ROOT, '.claude', 'skills');

  // Bundled ship source: flat *.md files installSkills() copies to new users.
  const bundled = path.join(GITNEXUS_ROOT, 'skills');
  if (existsSync(bundled)) {
    for (const f of readdirSync(bundled)) {
      if (f.endsWith('.md')) files.push(path.join(bundled, f));
    }
  }

  // Per-skill <name>/SKILL.md copies across the other distribution locations.
  const skillRoots = [
    projectSkillsRoot,
    path.join(projectSkillsRoot, 'gitnexus'),
    path.join(REPO_ROOT, 'gitnexus-claude-plugin', 'skills'),
    path.join(REPO_ROOT, 'gitnexus-cursor-integration', 'skills'),
  ];
  for (const root of skillRoots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (root === projectSkillsRoot && !dir.startsWith('gitnexus-')) {
        continue;
      }
      const skillMd = path.join(root, dir, 'SKILL.md');
      if (existsSync(skillMd)) files.push(skillMd);
    }
  }

  return files;
}

function cliSkillFiles(files: string[]): string[] {
  return files.filter(
    (f) =>
      /gitnexus-cli/.test(path.basename(path.dirname(f))) || path.basename(f) === 'gitnexus-cli.md',
  );
}

describe('skill-file steering (#1939, #1945)', () => {
  const files = collectSkillFiles();

  it('collects skill files from all committed locations (guard is not vacuous)', () => {
    const rels = files.map((f) => path.relative(REPO_ROOT, f));
    expect(rels.some((r) => r.startsWith(`gitnexus${path.sep}skills${path.sep}`))).toBe(true);
    expect(
      rels.some((r) => r.startsWith(path.join('.claude', 'skills', 'gitnexus-cli') + path.sep)),
    ).toBe(true);
    expect(
      rels.some((r) =>
        r.startsWith(path.join('.claude', 'skills', 'gitnexus', 'gitnexus-pdg-query') + path.sep),
      ),
    ).toBe(true);
    expect(
      rels.some((r) => r.startsWith(path.join('gitnexus-claude-plugin', 'skills') + path.sep)),
    ).toBe(true);
    expect(
      rels.some((r) => r.startsWith(path.join('gitnexus-cursor-integration', 'skills') + path.sep)),
    ).toBe(true);
  });

  it('routes EVERY cli skill subcommand through the project-local runner (#1945)', () => {
    // The cli skill demonstrates every subcommand. Each must invoke the
    // CLI-neutral runner `gitnexus analyze` drops next to the index — not a
    // hardcoded package manager — so the docs make no pnpm/npx assumption.
    // Checking each subcommand (not just `analyze`) guards against a regression
    // where status/clean/wiki/list silently revert to `npx gitnexus <sub>`.
    const cli = cliSkillFiles(files);
    expect(cli.length).toBeGreaterThan(0); // guard is not vacuous
    const SUBCOMMANDS = ['analyze', 'status', 'clean', 'wiki', 'list'];
    const offenders: string[] = [];
    for (const f of cli) {
      const text = readFileSync(f, 'utf-8');
      for (const sub of SUBCOMMANDS) {
        if (!new RegExp(`node\\s+\\.gitnexus/run\\.cjs\\s+${sub}\\b`).test(text)) {
          offenders.push(`${path.relative(REPO_ROOT, f)}:${sub}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('documents the not-analyzed-yet / npm-11 bootstrap fallback in the cli skill (#1939)', () => {
    // The runner only exists after the first analyze, so the cli skill must
    // document the bootstrap path (and the npm-11 npx install crash escape
    // hatch): the issue reference plus at least one fallback mechanism.
    const cli = cliSkillFiles(files);
    const offenders = cli.filter((f) => {
      const text = readFileSync(f, 'utf-8');
      const refsIssue = /1939/.test(text);
      const hasFallback =
        /install -g gitnexus/.test(text) || /--allow-build.*dlx gitnexus/.test(text);
      return !(refsIssue && hasFallback);
    });
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);

    // Positive vacuity guard: at least one cli skill must still carry the pnpm
    // pre-`dlx` fallback form, so the npm-11 pnpm path can't silently vanish
    // from every skill while the OR above is satisfied by `install -g` alone.
    const withPnpmFallback = cli.filter((f) =>
      /--allow-build.*dlx gitnexus/.test(readFileSync(f, 'utf-8')),
    );
    expect(withPnpmFallback.length).toBeGreaterThan(0);
  });

  it('routes every stale-index reanalyze hint through the runner, not a raw package manager', () => {
    // Skills that tell the agent to reanalyze a stale index must point at the
    // runner so the package-manager choice is resolved at call time.
    const offenders = files.filter((f) => {
      const text = readFileSync(f, 'utf-8');
      if (!/[Ss]tale/.test(text)) return false; // only skills with a reanalyze hint
      return !/node\s+\.gitnexus\/run\.cjs\s+analyze/.test(text);
    });
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  it('any pnpm fallback uses the pre-`dlx` --allow-build form, never the broken post-`dlx` position', () => {
    // `pnpm dlx --allow-build=…` (flags after `dlx`) is parsed as a package spec
    // and rejected on pnpm 10.2–10.13.x; the flags must precede `dlx` (#1939).
    const postDlxOffenders = files.filter((f) =>
      /pnpm dlx --allow-build/.test(readFileSync(f, 'utf-8')),
    );
    expect(postDlxOffenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });
});
