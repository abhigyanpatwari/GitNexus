/**
 * Which directories the workspace ADMITS as packages (#2953 review).
 *
 * Reading manifests is not the same as trusting them. An earlier draft
 * registered every `package.json` the repo-wide scan found, which recreates the
 * false-positive half of #2953 from a different source: an app importing
 * registry package `foo` binds to an excluded fixture or example that happens
 * to declare `name: "foo"`. This repository is itself the example —
 * `test/fixtures/**` declares `@repo/utils` among others.
 *
 * So the boundary is the workspace declaration, and these arms are about where
 * it is read from and what it admits.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNodeWorkspacePackages } from '../../src/core/ingestion/import-resolvers/node-workspace-packages.js';

const roots: string[] = [];

/** Write a throwaway repo from a `relativePath -> contents` map. */
function repo(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ws-'));
  roots.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

const pkg = (name: string): string => JSON.stringify({ name, main: 'src/index.ts' });

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace boundary', () => {
  it('admits a package the pnpm globs declare', async () => {
    const root = repo({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'package.json': JSON.stringify({ name: 'root', private: true }),
      'packages/utils/package.json': pkg('@repo/utils'),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.has('@repo/utils')).toBe(true);
  });

  it('refuses a package outside those globs', async () => {
    const root = repo({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'package.json': JSON.stringify({ name: 'root', private: true }),
      'packages/utils/package.json': pkg('@repo/utils'),
      // A fixture or example. Declares a name, is not a workspace member.
      'examples/demo/package.json': pkg('lodash'),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.has('@repo/utils')).toBe(true);
    // The pointed case: an app importing registry `lodash` must not bind here.
    expect(packages?.byName.has('lodash')).toBe(false);
  });

  it('reads npm/yarn `workspaces` from the root manifest', async () => {
    const root = repo({
      'package.json': JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
      'apps/web/package.json': pkg('@repo/web'),
      'vendored/copy/package.json': pkg('@repo/vendored'),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.has('@repo/web')).toBe(true);
    expect(packages?.byName.has('@repo/vendored')).toBe(false);
  });

  it('reads the yarn object form', async () => {
    const root = repo({
      'package.json': JSON.stringify({ name: 'root', workspaces: { packages: ['apps/*'] } }),
      'apps/web/package.json': pkg('@repo/web'),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.has('@repo/web')).toBe(true);
  });

  it('honours a `!` exclusion', async () => {
    const root = repo({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "!packages/internal"\n',
      'package.json': JSON.stringify({ name: 'root' }),
      'packages/utils/package.json': pkg('@repo/utils'),
      'packages/internal/package.json': pkg('@repo/internal'),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.has('@repo/utils')).toBe(true);
    expect(packages?.byName.has('@repo/internal')).toBe(false);
  });

  it('matches `**` across segments', async () => {
    const root = repo({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/**"\n',
      'package.json': JSON.stringify({ name: 'root' }),
      'packages/group/nested/package.json': pkg('@repo/nested'),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.has('@repo/nested')).toBe(true);
  });

  it('admits only the root when the repo declares no workspace', async () => {
    const root = repo({
      'package.json': pkg('just-one-package'),
      // A nested manifest in a repo with no workspace declaration is not a
      // member of anything — which is exactly this repository's own shape, and
      // why its `test/fixtures/**` manifests must not register.
      'test/fixtures/thing/package.json': pkg('@repo/utils'),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.has('just-one-package')).toBe(true);
    expect(packages?.byName.has('@repo/utils')).toBe(false);
  });

  it('gives a package with a root-less `exports` map no root entries', async () => {
    // The loader half of the rule: when `exports` is present it is the whole
    // interface, so `main` and the conventional `src/index` fallback must not
    // be offered for the bare package name.
    const root = repo({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'package.json': JSON.stringify({ name: 'root' }),
      'packages/inner/package.json': JSON.stringify({
        name: '@repo/inner',
        main: 'src/index.ts',
        exports: { './nest': './src/nest.ts' },
      }),
    });

    const packages = await loadNodeWorkspacePackages(root);
    const inner = packages?.byName.get('@repo/inner');

    expect(inner?.entries).toEqual([]);
    expect(inner?.subpathExports.get('nest')).toEqual(['packages/inner/src/nest']);
  });

  it('keeps legacy and conventional root entries when there is no `exports`', async () => {
    const root = repo({
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'package.json': JSON.stringify({ name: 'root' }),
      'packages/utils/package.json': JSON.stringify({ name: '@repo/utils', main: 'src/index.ts' }),
    });

    const packages = await loadNodeWorkspacePackages(root);

    expect(packages?.byName.get('@repo/utils')?.entries).toContain('packages/utils/src/index');
  });

  it('returns null when the repo has no manifest at all', async () => {
    const root = repo({ 'src/main.ts': 'export const x = 1;\n' });

    expect(await loadNodeWorkspacePackages(root)).toBeNull();
  });
});
