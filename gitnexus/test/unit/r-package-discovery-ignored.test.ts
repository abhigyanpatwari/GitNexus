/**
 * R package discovery follows the indexer's own ignore rules, and does not mistake an installed
 * library for a repository package.
 *
 * - An installed package's `DESCRIPTION` has a `Built:` field (a source package never does), so a
 *   library checked in under `lib/` or `library/` registers nothing.
 * - The directories the indexer never reads (dot-directories, `vendor`, `build`, ...) are not
 *   searched, and do not spend the hidden-package scan's 5,000-directory budget.
 *
 * Every test builds a real temporary tree.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirSync } from '../helpers/test-db.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRPackageConfig } from '../../src/core/ingestion/languages/r/package-config.js';
import { rQualifierLocality } from '../../src/core/ingestion/languages/r/qualified-call.js';

let tmp: string;
let counter = 0;

const source = (name: string): string => `Package: ${name}\nVersion: 1.0\n`;
const installed = (name: string): string =>
  `Package: ${name}\nVersion: 1.0\nBuilt: R 4.3.1; ; 2023-06-01 10:00:00 UTC; unix\n`;

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

/** A repository whose own package is `mine`, at the root. */
async function newRepo(): Promise<string> {
  const root = path.join(tmp, `repo${counter++}`);
  await write(root, 'DESCRIPTION', source('mine'));
  await write(root, 'NAMESPACE', 'export(f)\n');
  return root;
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-r-ignored-'));
});
afterAll(() => {
  cleanupTempDirSync(tmp);
});

describe('an installed library package is not a repository package', () => {
  it.each([
    ['lib', 'lib/ggplot2'],
    ['library', 'library/dplyr'],
    ['.Rlibs', '.Rlibs/tidyr'],
    ['vendor', 'vendor/purrr'],
    ['build', 'build/stringr'],
    ['a site library', 'site/R/library/cli'],
  ])('registers nothing from %s', async (_label, dir) => {
    const root = await newRepo();
    await write(root, `${dir}/DESCRIPTION`, installed(path.basename(dir)));
    await write(root, `${dir}/NAMESPACE`, 'export(f)\n');
    const cfg = await loadRPackageConfig(root);
    expect([...cfg.packages.keys()]).toEqual(['mine']);
    expect([...cfg.namespaceInfoByPackageDir.keys()]).toEqual(['']);
    expect([...(cfg.packageDirs ?? [])]).toEqual(['']);
    expect(cfg.truncated).toBe(false);
  });

  it('makes the library package external, so its qualified calls are not guessed locally', async () => {
    const root = await newRepo();
    for (const [dir, name] of [
      ['library/dplyr', 'dplyr'],
      ['lib/ggplot2', 'ggplot2'],
      ['.Rlibs/tidyr', 'tidyr'],
      ['vendor/purrr', 'purrr'],
      ['build/stringr', 'stringr'],
    ]) {
      await write(root, `${dir}/DESCRIPTION`, installed(name));
    }
    const cfg = await loadRPackageConfig(root);
    for (const name of ['dplyr', 'ggplot2', 'tidyr', 'purrr', 'stringr']) {
      expect(rQualifierLocality(name, cfg, new Set())).toBe('external');
    }
    expect(rQualifierLocality('mine', cfg, new Set())).toBe('local');
  });

  it('keeps a source package of the same layout: only the Built: field marks an installed one', async () => {
    const root = await newRepo();
    await write(root, 'lib/ggplot2/DESCRIPTION', source('ggplot2'));
    await write(root, 'library/dplyr/DESCRIPTION', installed('dplyr'));
    const cfg = await loadRPackageConfig(root);
    expect([...cfg.packages].sort()).toEqual([
      ['ggplot2', 'lib/ggplot2'],
      ['mine', ''],
    ]);
  });

  it('reads Built: after a byte-order mark and anywhere in the file', async () => {
    const root = await newRepo();
    await write(root, 'lib/a/DESCRIPTION', `﻿Built: R 4.3.1\nPackage: a\n`);
    await write(root, 'lib/b/DESCRIPTION', `Package: b\nTitle: Not Built: here\n`);
    const cfg = await loadRPackageConfig(root);
    expect([...cfg.packages.keys()].sort()).toEqual(['b', 'mine']);
  });

  it('does not let an installed package beyond the depth limit truncate discovery', async () => {
    const root = await newRepo();
    await write(root, 'a/b/c/d/library/dplyr/DESCRIPTION', installed('dplyr'));
    await write(root, 'a/b/c/d/lib/ggplot2/DESCRIPTION', installed('ggplot2'));
    const cfg = await loadRPackageConfig(root);
    expect(cfg.truncated).toBe(false);
  });
});

describe('directories the indexer ignores are not searched', () => {
  it.each(['vendor', 'build', 'dist', 'lib64', 'node_modules', 'fixtures', '.hidden', '.Rlibs'])(
    'a source package under %s is not a repository package',
    async (dir) => {
      const root = await newRepo();
      await write(root, `${dir}/pkg/DESCRIPTION`, source('inner'));
      const cfg = await loadRPackageConfig(root);
      expect([...cfg.packages.keys()]).toEqual(['mine']);
      expect(cfg.truncated).toBe(false);
    },
  );

  it('searches an ordinary directory that has the same package (control)', async () => {
    const root = await newRepo();
    await write(root, 'packages/pkg/DESCRIPTION', source('inner'));
    const cfg = await loadRPackageConfig(root);
    expect(cfg.packages.get('inner')).toBe('packages/pkg');
  });

  it.each(['vendor', 'build', '.cache'])(
    'an ignored tree of 5,200 directories below the depth limit does not truncate discovery (%s)',
    async (dir) => {
      const root = await newRepo();
      const big = path.join(root, 'a', 'b', 'c', 'd', dir);
      await fs.mkdir(big, { recursive: true });
      await Promise.all(
        Array.from({ length: 5200 }, (_, i) => fs.mkdir(path.join(big, `d${String(i)}`))),
      );
      const cfg = await loadRPackageConfig(root);
      expect(cfg.truncated).toBe(false);
    },
    30000,
  );

  it('does truncate when the same 5,200 directories are not ignored (control)', async () => {
    const root = await newRepo();
    const big = path.join(root, 'a', 'b', 'c', 'd', 'zzz');
    await fs.mkdir(big, { recursive: true });
    await Promise.all(
      Array.from({ length: 5200 }, (_, i) => fs.mkdir(path.join(big, `d${String(i)}`))),
    );
    const cfg = await loadRPackageConfig(root);
    expect(cfg.truncated).toBe(true);
  }, 30000);
});

/**
 * The documented discovery bounds, pinned with literals. The walk reads the root, then
 * directories to depth 3, and stops after 200 directories; a skipped subtree is scanned once more
 * for a package the walk missed.
 */
describe('discovery bounds', () => {
  const nest = (depth: number): string =>
    Array.from({ length: depth }, (_, i) => `x${String(i)}`).join('/');

  it('finds a package at depth 3', async () => {
    const root = await newRepo();
    await write(root, `${nest(3)}/DESCRIPTION`, source('deep'));
    const cfg = await loadRPackageConfig(root);
    expect(cfg.packages.get('deep')).toBe('x0/x1/x2');
    expect(cfg.truncated).toBe(false);
  });

  it('does not find a package at depth 4, and says discovery is incomplete', async () => {
    const root = await newRepo();
    await write(root, `${nest(4)}/DESCRIPTION`, source('deep'));
    const cfg = await loadRPackageConfig(root);
    expect(cfg.packages.has('deep')).toBe(false);
    expect(cfg.truncated).toBe(true);
  });

  /** `fillers` empty directories that sort before the one holding the package. */
  async function withFillers(fillers: number) {
    const root = await newRepo();
    for (let i = 0; i < fillers; i++) {
      await fs.mkdir(path.join(root, `filler${String(i).padStart(3, '0')}`));
    }
    await write(root, 'zz_hidden/DESCRIPTION', source('hidden'));
    return loadRPackageConfig(root);
  }

  it('finds a package after 198 directories (the root is the 1st of 200 scanned)', async () => {
    const cfg = await withFillers(198);
    expect(cfg.packages.get('hidden')).toBe('zz_hidden');
    expect(cfg.truncated).toBe(false);
  });

  it('does not find it after 199 directories, and says discovery is incomplete', async () => {
    const cfg = await withFillers(199);
    expect(cfg.packages.has('hidden')).toBe(false);
    expect(cfg.truncated).toBe(true);
  });
});
