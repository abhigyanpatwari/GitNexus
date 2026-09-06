import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadNodeWorkspacePackages,
  resolveNodeWorkspaceImport,
} from '../../src/core/ingestion/import-resolvers/node-workspace-packages.js';

/**
 * C3 — a workspace declared BELOW the repo root (keycloak: `js/pnpm-workspace.yaml`).
 * C4 — a package whose `main`/`exports` name build output; the source entry is
 *      discovered from `source`, `publishConfig.source`, or vite `lib.entry`.
 */
describe('nested workspace roots and non-dist entry discovery', () => {
  let dir: string;
  const w = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), s);
  };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-c3c4-'));
    // Root has NO workspace declaration (a Java repo with a JS subtree).
    w('pom.xml', '<project/>');
    w('js/pnpm-workspace.yaml', 'packages:\n  - "libs/*"\n  - "apps/*"\n');
    // C4: dist main + vite lib entry → discover src/main.ts
    w(
      'js/libs/ui-shared/package.json',
      JSON.stringify({
        name: '@keycloak/keycloak-ui-shared',
        main: './dist/keycloak-ui-shared.js',
        module: './dist/keycloak-ui-shared.js',
        types: './dist/keycloak-ui-shared.d.ts',
      }),
    );
    w(
      'js/libs/ui-shared/vite.config.ts',
      `export default defineConfig({ build: { lib: { entry: 'src/main.ts', formats: ['es'] } } });\n`,
    );
    w('js/libs/ui-shared/src/main.ts', 'export const x = 1;\n');
    // `source` field wins when present.
    w(
      'js/libs/with-source/package.json',
      JSON.stringify({ name: '@acme/with-source', main: 'dist/index.js', source: 'src/entry.ts' }),
    );
    w('js/libs/with-source/src/entry.ts', 'export const y = 1;\n');
    // Ambiguous: `source` and vite entry name DIFFERENT existing files → refuse both.
    w(
      'js/libs/ambiguous/package.json',
      JSON.stringify({ name: '@acme/ambiguous', main: 'dist/index.js', source: 'src/a.ts' }),
    );
    w(
      'js/libs/ambiguous/vite.config.ts',
      `export default { build: { lib: { entry: 'src/b.ts' } } };\n`,
    );
    w('js/libs/ambiguous/src/a.ts', 'export const a = 1;\n');
    w('js/libs/ambiguous/src/b.ts', 'export const b = 1;\n');
    // A source `main` is left alone — discovery never runs.
    w(
      'js/apps/admin/package.json',
      JSON.stringify({ name: '@keycloak/admin', main: 'src/index.tsx' }),
    );
    w('js/apps/admin/src/index.tsx', 'export const z = 1;\n');
    // A manifest OUTSIDE the declared workspace is not admitted.
    w(
      'js/examples/demo/package.json',
      JSON.stringify({ name: '@keycloak/demo', main: 'src/index.ts' }),
    );
    // `source` declared but the file does NOT exist on disk; the vite lib
    // entry does. Discovery must fall through to it rather than treating the
    // dangling `source` as a second, disagreeing candidate.
    w(
      'js/libs/source-missing/package.json',
      JSON.stringify({
        name: '@acme/source-missing',
        main: 'dist/index.js',
        source: 'src/does-not-exist.ts',
      }),
    );
    w(
      'js/libs/source-missing/vite.config.ts',
      `export default { build: { lib: { entry: 'src/real.ts' } } };\n`,
    );
    w('js/libs/source-missing/src/real.ts', 'export const real = 1;\n');
    // `source` and `publishConfig.source` name the SAME existing file — two
    // candidate strings, one real target. Must NOT read as ambiguous.
    w(
      'js/libs/dup-source/package.json',
      JSON.stringify({
        name: '@acme/dup-source',
        main: 'dist/index.js',
        source: 'src/shared.ts',
        publishConfig: { source: 'src/shared.ts' },
      }),
    );
    w('js/libs/dup-source/src/shared.ts', 'export const shared = 1;\n');
    // Nothing declared, nothing conventional but BOTH `src/main` and
    // `src/index` exist — the fallback tier has no priority order of its
    // own, so two existing conventional candidates are ambiguous too.
    w(
      'js/libs/both-conventional/package.json',
      JSON.stringify({ name: '@acme/both-conventional' }),
    );
    w('js/libs/both-conventional/src/main.ts', 'export const m = 1;\n');
    w('js/libs/both-conventional/src/index.ts', 'export const i = 1;\n');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('admits packages declared by a nested pnpm-workspace.yaml', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs).not.toBeNull();
    expect([...pkgs!.byName.keys()].sort()).toEqual([
      '@acme/ambiguous',
      '@acme/both-conventional',
      '@acme/dup-source',
      '@acme/source-missing',
      '@acme/with-source',
      '@keycloak/admin',
      '@keycloak/keycloak-ui-shared',
    ]);
    expect(pkgs!.byName.has('@keycloak/demo')).toBe(false);
  });
  it('discovers the vite lib entry when main points at dist', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.get('@keycloak/keycloak-ui-shared')!.entries).toContain(
      'js/libs/ui-shared/src/main',
    );
  });
  it('honours `source` when main points at dist', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.get('@acme/with-source')!.entries).toContain(
      'js/libs/with-source/src/entry',
    );
  });
  it('refuses when two discovered candidates disagree', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const entries = pkgs!.byName.get('@acme/ambiguous')!.entries;
    expect(entries).not.toContain('js/libs/ambiguous/src/a');
    expect(entries).not.toContain('js/libs/ambiguous/src/b');
  });
  it('leaves a source `main` untouched', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs!.byName.get('@keycloak/admin')!.entries[0]).toBe('js/apps/admin/src/index');
  });

  it('falls through to the vite entry when `source` names a file that does not exist on disk', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const entries = pkgs!.byName.get('@acme/source-missing')!.entries;
    expect(entries).toContain('js/libs/source-missing/src/real');
    expect(entries).not.toContain('js/libs/source-missing/src/does-not-exist');
  });

  it('does not treat `source` and `publishConfig.source` naming the SAME file as ambiguous', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const entries = pkgs!.byName.get('@acme/dup-source')!.entries;
    expect(entries).toContain('js/libs/dup-source/src/shared');
  });

  // Declared entries keep precedence over a discovered one (per the code
  // comment: discovered entries are ONLY appended). This is the resolution-
  // time consequence of that ordering, not just an entries-array shape check:
  // if the declared `dist/*.js` happens to exist among the indexed files
  // (e.g. a repo that does not gitignore build output), it is still what a
  // bare `import '@keycloak/keycloak-ui-shared'` resolves to — the
  // discovered `src/main.ts` entry is only reached when the dist file is
  // NOT among the indexed files, which is the common case.
  it('a declared dist entry that exists among the indexed files is still used over the discovered source entry', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const allFilesWithDist = new Set([
      'js/libs/ui-shared/dist/keycloak-ui-shared.js',
      'js/libs/ui-shared/src/main.ts',
    ]);
    expect(resolveNodeWorkspaceImport('@keycloak/keycloak-ui-shared', pkgs, allFilesWithDist)).toBe(
      'js/libs/ui-shared/dist/keycloak-ui-shared.js',
    );
    // Without the dist file indexed (the common case — build output is not
    // checked in), resolution falls through to the discovered source entry.
    const allFilesSourceOnly = new Set(['js/libs/ui-shared/src/main.ts']);
    expect(
      resolveNodeWorkspaceImport('@keycloak/keycloak-ui-shared', pkgs, allFilesSourceOnly),
    ).toBe('js/libs/ui-shared/src/main.ts');
  });

  // `discoverSourceEntries`'s ambiguity refusal only governs ITS OWN
  // candidates (`source` / `publishConfig.source` / vite / its own
  // `src/main`-then-`src/index` fallback). It does NOT reach the older,
  // separate unconditional `src/index` fallback `readManifest` already adds
  // for every package with no `exports` map — so when nothing is declared
  // and BOTH `src/main.ts` and `src/index.ts` exist, discovery contributes
  // NOTHING (refused as ambiguous, `src/main` never appears), but
  // `src/index` still ends up in `entries` anyway, through the unrelated
  // unconditional path. Documented here because it means the "no binding on
  // ambiguity" guarantee is a discovery-local property, not a package-wide one.
  it('an ambiguous discovery still leaves the unconditional src/index fallback standing', async () => {
    const pkgs = await loadNodeWorkspacePackages(dir);
    const entries = pkgs!.byName.get('@acme/both-conventional')!.entries;
    expect(entries).toContain('js/libs/both-conventional/src/index');
    expect(entries).not.toContain('js/libs/both-conventional/src/main');
  });
});

describe('workspace root discovery depth cap (WORKSPACE_ROOT_MAX_DEPTH = 4)', () => {
  let dir: string;
  const w = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), s);
  };
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('finds a workspace root exactly at depth 4, but not one at depth 5', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-c3-depth-'));
    // No root workspace declaration.
    w('README.md', '# root\n');
    // depth 4: a/b/c/d/pnpm-workspace.yaml (d is the 4th directory level).
    w('a/b/c/d/pnpm-workspace.yaml', 'packages:\n  - "pkgs/*"\n');
    w('a/b/c/d/pkgs/at-depth-4/package.json', JSON.stringify({ name: '@depth/four' }));
    w('a/b/c/d/pkgs/at-depth-4/index.ts', 'export const x = 1;\n');
    // depth 5: a/b/c/d/e/pnpm-workspace.yaml — one level too deep to be found.
    w('a/b/c/d/e/pnpm-workspace.yaml', 'packages:\n  - "pkgs/*"\n');
    w('a/b/c/d/e/pkgs/at-depth-5/package.json', JSON.stringify({ name: '@depth/five' }));
    w('a/b/c/d/e/pkgs/at-depth-5/index.ts', 'export const y = 1;\n');

    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs).not.toBeNull();
    expect(pkgs!.byName.has('@depth/four')).toBe(true);
    expect(pkgs!.byName.has('@depth/five')).toBe(false);
  });
});

describe('a nested `package.json` "workspaces" field (not pnpm-workspace.yaml) is also found as a root', () => {
  let dir: string;
  const w = (p: string, s: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), s);
  };
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  it('admits packages declared by a nested package.json "workspaces" array', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-c3-pkgjson-root-'));
    w('go.mod', 'module example.com/root\n');
    // Nested JS workspace root declared via `package.json`'s `workspaces`
    // field rather than a pnpm-workspace.yaml — the OTHER of the three
    // spellings `readWorkspacePatternsAt` merges, exercised here at a non-root directory.
    w(
      'frontend/package.json',
      JSON.stringify({ name: 'frontend-root', private: true, workspaces: ['packages/*'] }),
    );
    w('frontend/packages/ui/package.json', JSON.stringify({ name: '@fe/ui' }));
    w('frontend/packages/ui/index.ts', 'export const x = 1;\n');
    // Outside the nested workspace's own pattern scope — must not be admitted.
    w('frontend/other/package.json', JSON.stringify({ name: '@fe/other' }));

    const pkgs = await loadNodeWorkspacePackages(dir);
    expect(pkgs).not.toBeNull();
    expect(pkgs!.byName.has('@fe/ui')).toBe(true);
    expect(pkgs!.byName.has('@fe/other')).toBe(false);
  });
});
