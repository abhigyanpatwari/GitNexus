/**
 * Final-review fixes on workspace-package discovery:
 *  - B2: an `exports` map with no `"."` (rootless) refuses the bare specifier —
 *    discovery must not manufacture a `src/index` root entry for it.
 *  - M6: nested workspace roots are gated by the outer scope; an outer
 *    `!exclusion` keeps binding under a nested root; starter/fixture roots
 *    (`examples/`, `fixtures/`, `templates/`, `samples/`) are never roots.
 *  - M9: the package map is memoised per repo root within a process and can be
 *    invalidated explicitly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadNodeWorkspacePackages,
  invalidateNodeWorkspacePackages,
  resolveNodeWorkspaceImport,
} from '../../src/core/ingestion/import-resolvers/node-workspace-packages.js';
import { _captureLogger } from '../../src/core/logger.js';

function mkRepo(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const w = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), s);
  };
  return { dir, w };
}
const rm = (dir: string) =>
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

describe('B2 — rootless `exports` refuses the bare specifier', () => {
  let dir: string;
  beforeAll(() => {
    const r = mkRepo('gn-b2-');
    dir = r.dir;
    r.w('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    // exports with only a subpath, no main: bare `@repo/subonly` does not resolve in Node.
    r.w(
      'packages/subonly/package.json',
      JSON.stringify({ name: '@repo/subonly', exports: { './feature': './src/feature.ts' } }),
    );
    r.w('packages/subonly/src/feature.ts', 'export const f = 1;\n');
    r.w('packages/subonly/src/index.ts', 'export const trap = 1;\n');
    // exports subpath-only PLUS a build-output main: Node ignores `main` when
    // `exports` exists, so the root is still refused.
    r.w(
      'packages/submain/package.json',
      JSON.stringify({
        name: '@repo/submain',
        main: './dist/index.js',
        exports: { './feature': './src/feature.ts' },
      }),
    );
    r.w('packages/submain/src/feature.ts', 'export const f = 1;\n');
    r.w('packages/submain/src/index.ts', 'export const trap = 1;\n');
    // exports WITH a root: resolves as before.
    r.w(
      'packages/rooted/package.json',
      JSON.stringify({ name: '@repo/rooted', exports: { '.': './src/index.ts' } }),
    );
    r.w('packages/rooted/src/index.ts', 'export const ok = 1;\n');
    // exports as a bare STRING — Node's shorthand for `{".": "<string>"}`. The
    // walker's `currentSubpath === ''` default treats a top-level string as the
    // root export directly.
    r.w(
      'packages/stringform/package.json',
      JSON.stringify({ name: '@repo/stringform', exports: './src/index.ts' }),
    );
    r.w('packages/stringform/src/index.ts', 'export const ok = 1;\n');
    // exports declaring ONLY a subpath PATTERN (`"./*"`), no `"."` at all. Same
    // rootless rule as `subonly` — the pattern populates `subpathExports`, the
    // bare specifier still refuses.
    r.w(
      'packages/patternonly/package.json',
      JSON.stringify({ name: '@repo/patternonly', exports: { './*': './src/*.ts' } }),
    );
    r.w('packages/patternonly/src/anything.ts', 'export const a = 1;\n');
    r.w('packages/patternonly/src/index.ts', 'export const trap = 1;\n');
  });
  afterAll(() => rm(dir));

  it('a subpath-only exports map yields no root entry (no src/index edge)', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs).not.toBeNull();
    expect(pkgs!.byName.get('@repo/subonly')?.entries).toEqual([]);
    expect(pkgs!.byName.get('@repo/submain')?.entries).toEqual([]);
    // The subpath the map DOES declare still resolves.
    // Entries are extension-less stems.
    expect(pkgs!.byName.get('@repo/subonly')?.subpathExports.get('feature')).toEqual([
      'packages/subonly/src/feature',
    ]);
  });

  it('a `"."` export still resolves the root', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.get('@repo/rooted')?.entries).toEqual(['packages/rooted/src/index']);
  });

  it('a string-form `exports` (Node shorthand for `{".": "..."}`) resolves the root', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.get('@repo/stringform')?.entries).toEqual([
      'packages/stringform/src/index',
    ]);
  });

  it('a pattern-only `exports` (`"./*"`, no `"."`) does NOT fabricate a root — bare specifier still refuses', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const pkg = pkgs!.byName.get('@repo/patternonly');
    expect(pkg).toBeDefined();
    // No root entry manufactured — this is the same rootless refusal as `subonly`.
    expect(pkg!.entries).toEqual([]);
    // The pattern itself IS recorded (so `@repo/patternonly/anything` still
    // resolves) — the refusal is scoped to the bare specifier only.
    expect(pkg!.subpathExports.get('*')).toEqual(['packages/patternonly/src/*']);
    expect(
      resolveNodeWorkspaceImport(
        '@repo/patternonly/anything',
        pkgs,
        new Set(['packages/patternonly/src/anything.ts']),
      ),
    ).toBe('packages/patternonly/src/anything.ts');
  });

  it('none of the rootless refusals are recorded as ambiguous — a refusal is silent, not a warning', async () => {
    const cap = _captureLogger();
    try {
      invalidateNodeWorkspacePackages(dir);
      await loadNodeWorkspacePackages(dir);
    } finally {
      cap.restore();
    }
    const text = cap.text();
    // The ONLY ambiguity warning this module ever emits names "candidate
    // source entries" (discoverSourceEntries) — must never fire for a
    // rootlessExports package, since discovery is skipped entirely for them.
    expect(text.includes('candidate source entries')).toBe(false);
  });
});

describe('M6 — nested workspace roots are gated by the outer scope', () => {
  let dir: string;
  beforeAll(() => {
    const r = mkRepo('gn-m6-');
    dir = r.dir;
    r.w(
      'package.json',
      JSON.stringify({ name: 'root', workspaces: ['packages/*', '!packages/legacy'] }),
    );
    r.w('packages/real/package.json', JSON.stringify({ name: '@repo/real', main: 'src/index.ts' }));
    r.w('packages/real/src/index.ts', 'export const real = 1;\n');
    // Excluded subtree that re-declares a workspace of its own: must stay out.
    r.w(
      'packages/legacy/package.json',
      JSON.stringify({ name: '@repo/legacy', workspaces: ['libs/*'] }),
    );
    r.w(
      'packages/legacy/libs/old/package.json',
      JSON.stringify({ name: '@repo/old', main: 'src/index.ts' }),
    );
    r.w('packages/legacy/libs/old/src/index.ts', 'export const old = 1;\n');
    // A starter under examples/ carrying `workspaces`: never a root.
    r.w(
      'examples/starter/package.json',
      JSON.stringify({ name: 'starter', workspaces: ['apps/*'] }),
    );
    r.w(
      'examples/starter/apps/web/package.json',
      JSON.stringify({ name: '@repo/real', main: 'src/index.ts' }),
    );
    r.w('examples/starter/apps/web/src/index.ts', 'export const fake = 1;\n');
    // A nested root that IS admitted by the outer scope (packages/*): its members count.
    r.w(
      'packages/nested/package.json',
      JSON.stringify({ name: '@repo/nested', workspaces: ['inner/*'] }),
    );
    r.w(
      'packages/nested/inner/leaf/package.json',
      JSON.stringify({ name: '@repo/leaf', main: 'src/index.ts' }),
    );
    r.w('packages/nested/inner/leaf/src/index.ts', 'export const leaf = 1;\n');
  });
  afterAll(() => rm(dir));

  it('an outer `!exclusion` keeps binding under a nested root inside the excluded subtree', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.has('@repo/legacy')).toBe(false);
    expect(pkgs!.byName.has('@repo/old')).toBe(false);
  });

  it('an examples/ starter never becomes a root, so its name collision cannot outrank the real package', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.get('@repo/real')?.dir).toBe('packages/real');
    expect(pkgs!.byName.has('starter')).toBe(false);
    for (const pkg of pkgs!.byName.values()) expect(pkg.dir.startsWith('examples/')).toBe(false);
  });

  it('a nested root admitted by the outer scope contributes its members', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.get('@repo/leaf')?.dir).toBe('packages/nested/inner/leaf');
    expect(pkgs!.byName.get('@repo/leaf')?.entries).toContain(
      'packages/nested/inner/leaf/src/index',
    );
  });
});

describe('M9 — per-repo memo', () => {
  let dir: string;
  beforeAll(() => {
    const r = mkRepo('gn-m9-');
    dir = r.dir;
    r.w('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    r.w('packages/a/package.json', JSON.stringify({ name: '@repo/a', main: 'src/index.ts' }));
    r.w('packages/a/src/index.ts', 'export const a = 1;\n');
  });
  afterAll(() => rm(dir));

  it('returns the same map for the same root until invalidated', async () => {
    invalidateNodeWorkspacePackages(dir);
    const first = await loadNodeWorkspacePackages(dir);
    const second = await loadNodeWorkspacePackages(dir);
    expect(second).toBe(first);
    // A package added after the first scan is invisible until invalidation…
    fs.mkdirSync(path.join(dir, 'packages/b/src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'packages/b/package.json'),
      JSON.stringify({ name: '@repo/b', main: 'src/index.ts' }),
    );
    fs.writeFileSync(path.join(dir, 'packages/b/src/index.ts'), 'export const b = 1;\n');
    expect((await loadNodeWorkspacePackages(dir))!.byName.has('@repo/b')).toBe(false);
    // …and visible after it.
    invalidateNodeWorkspacePackages(dir);
    expect((await loadNodeWorkspacePackages(dir))!.byName.has('@repo/b')).toBe(true);
    expect(typeof resolveNodeWorkspaceImport).toBe('function');
  });
});

describe('M6 — the outer exclusion covers a nested root declared via pnpm-workspace.yaml too', () => {
  // Same shape as the "M6" describe block above (`packages/legacy` re-declares
  // its own workspace and must stay excluded), but the nested declaration is
  // the OTHER of the two spellings `readWorkspacePatternsAt` merges —
  // `pnpm-workspace.yaml` rather than `package.json`'s `workspaces` field —
  // exercising the gate against the spelling `findWorkspaceRoots` treats
  // identically for "declares a workspace" but differently for `admits()`.
  let dir: string;
  beforeAll(() => {
    const r = mkRepo('gn-m6-yaml-');
    dir = r.dir;
    r.w(
      'package.json',
      JSON.stringify({ name: 'root', workspaces: ['packages/*', '!packages/legacy'] }),
    );
    r.w(
      'packages/real/package.json',
      JSON.stringify({ name: '@repo/real2', main: 'src/index.ts' }),
    );
    r.w('packages/real/src/index.ts', 'export const real = 1;\n');
    // Excluded subtree whose OWN workspace is declared via pnpm-workspace.yaml.
    r.w('packages/legacy/package.json', JSON.stringify({ name: '@repo/legacy2' }));
    r.w('packages/legacy/pnpm-workspace.yaml', 'packages:\n  - "libs/*"\n');
    r.w(
      'packages/legacy/libs/old/package.json',
      JSON.stringify({ name: '@repo/old2', main: 'src/index.ts' }),
    );
    r.w('packages/legacy/libs/old/src/index.ts', 'export const old = 1;\n');
  });
  afterAll(() => rm(dir));

  it('the pnpm-workspace.yaml-declared nested root inside the excluded subtree is NOT admitted', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs).not.toBeNull();
    // The excluded package.json itself (packages/legacy) is also outside the
    // outer scope, independent of its own nested declaration.
    expect(pkgs!.byName.has('@repo/legacy2')).toBe(false);
    expect(pkgs!.byName.has('@repo/old2')).toBe(false);
    expect(pkgs!.byName.get('@repo/real2')?.dir).toBe('packages/real');
  });
});

describe('M6 — name collision: the root package always wins over an admitted nested duplicate', () => {
  // `admits(scope, '')` is unconditionally true (`if (dir === '') return true`)
  // — the repo root is always itself a package, workspace or not. The BFS in
  // `loadNodeWorkspacePackagesUncached` visits shallower directories first
  // (queue is depth-ordered), so when the ROOT package and a nested workspace
  // member declare the SAME name, "first declaration wins" must mean the root,
  // not the shallowest scanned nested match. Documented behavior, not a
  // "correct" resolution in any package-manager sense — pnpm/npm would refuse
  // to install two packages with the same name at all. What matters here is
  // that GitNexus's own winner is deterministic and repeatable.
  let dir: string;
  beforeAll(() => {
    const r = mkRepo('gn-m6-collide-');
    dir = r.dir;
    r.w(
      'package.json',
      JSON.stringify({
        name: '@repo/dup',
        private: true,
        workspaces: ['packages/*'],
        // `exports: {"."}` keeps `entries` to exactly this one declared stem —
        // `main` alone would also pull in the always-appended conventional
        // fallbacks (`src/index`, `index`, `lib/index`), which would make the
        // "exactly one entry, the root's" assertion below false positive-prone.
        exports: { '.': './root-src/index.ts' },
      }),
    );
    r.w('root-src/index.ts', 'export const rootWins = 1;\n');
    // A nested, admitted package reusing the SAME name as the root.
    r.w(
      'packages/dupnested/package.json',
      JSON.stringify({ name: '@repo/dup', main: 'src/index.ts' }),
    );
    r.w('packages/dupnested/src/index.ts', 'export const nestedLoses = 1;\n');
  });
  afterAll(() => rm(dir));

  it('the root package (shallowest, dir === "") wins the name collision, deterministically', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs).not.toBeNull();
    const winner = pkgs!.byName.get('@repo/dup');
    expect(winner).toBeDefined();
    expect(winner!.dir).toBe('');
    expect(winner!.entries).toEqual(['root-src/index']);
    // Repeated scans (memo invalidated each time) keep picking the same winner.
    invalidateNodeWorkspacePackages(dir);
    const second = await loadNodeWorkspacePackages(dir);
    expect(second!.byName.get('@repo/dup')?.dir).toBe('');
  });
});
