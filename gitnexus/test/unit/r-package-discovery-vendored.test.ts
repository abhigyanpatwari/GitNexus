/**
 * R package discovery must not treat installed libraries and check output
 * (`renv/`, `packrat/`, `revdep/`, `<pkg>.Rcheck/`) as repository packages.
 *
 * Every test builds a real temporary tree. The skip rule is exact: the near-miss
 * names below must still be searched, because a real package can live in a
 * directory called `renv-tools`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hidesUndiscoveredPackage,
  loadRPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';
import { rQualifierLocality } from '../../src/core/ingestion/languages/r/qualified-call.js';

let tmp: string;
let counter = 0;

const desc = (name: string): string => `Package: ${name}\nVersion: 1.0\n`;

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

async function newRepo(): Promise<string> {
  const root = path.join(tmp, `repo${counter++}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

/** A repository whose own package is `mypkg`, at the root. */
async function rootPackageRepo(): Promise<string> {
  const root = await newRepo();
  await write(root, 'DESCRIPTION', desc('mypkg'));
  await write(root, 'NAMESPACE', 'export(f)\n');
  return root;
}

/** Directory names the rule skips, as a (name, a path inside it that holds a package) pair. */
const VENDORED: readonly (readonly [label: string, dir: string])[] = [
  ['renv', 'renv/library/dplyr'],
  ['packrat', 'packrat/lib/dplyr'],
  ['revdep', 'revdep/library/dplyr'],
  ['.Rcheck', 'mypkg.Rcheck/00_pkg_src/dplyr'],
];

/** Names that resemble the rule but must not be skipped. */
const NEAR_MISSES: readonly string[] = [
  'renv-tools',
  'Renv',
  'RENV',
  'renv2',
  'packrat_old',
  'revdeps',
  'Rcheck',
  'pkg.rcheck',
  'pkg.Rcheck.bak',
  '.Rcheck',
];

describe('R package discovery skips vendored and generated trees', () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-r-vendored-'));
  });
  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('a renv library below the depth limit neither adds a package nor truncates discovery', async () => {
    const root = await rootPackageRepo();
    await write(root, 'renv/library/x86_64-pc-linux-gnu/4.3/dplyr/DESCRIPTION', desc('dplyr'));
    const cfg = await loadRPackageConfig(root);
    expect([...cfg.packages.keys()]).toEqual(['mypkg']);
    expect(cfg.truncated).toBe(false);
  });

  describe.each(VENDORED)('%s directory', (_label, pkgDir) => {
    it('is not searched for packages within the depth limit', async () => {
      const root = await rootPackageRepo();
      await write(root, `${pkgDir}/DESCRIPTION`, desc('dplyr'));
      await write(root, `${pkgDir}/NAMESPACE`, 'export(filter)\n');
      const cfg = await loadRPackageConfig(root);
      expect(cfg.packages.has('dplyr')).toBe(false);
      expect([...cfg.namespaceInfoByPackageDir.keys()]).toEqual(['']);
      expect(cfg.truncated).toBe(false);
    });

    it('is skipped when nested below another directory', async () => {
      const root = await rootPackageRepo();
      await write(root, `analysis/${pkgDir}/DESCRIPTION`, desc('dplyr'));
      const cfg = await loadRPackageConfig(root);
      expect([...cfg.packages.keys()]).toEqual(['mypkg']);
      expect(cfg.truncated).toBe(false);
    });

    it('does not truncate discovery when it lies beyond the depth limit', async () => {
      const root = await rootPackageRepo();
      await write(root, `a/b/c/d/${pkgDir}/DESCRIPTION`, desc('dplyr'));
      const cfg = await loadRPackageConfig(root);
      expect([...cfg.packages.keys()]).toEqual(['mypkg']);
      expect(cfg.truncated).toBe(false);
    });

    it('is not entered by the hidden-package scan', async () => {
      const root = await newRepo();
      await write(root, `${pkgDir}/DESCRIPTION`, desc('dplyr'));
      expect(await hidesUndiscoveredPackage([root], new Set())).toBe(false);
    });
  });

  it('a genuine package beside a vendored tree is still discovered and not displaced by a same-named copy inside it', async () => {
    const root = await rootPackageRepo();
    await write(root, 'packages/dplyr/DESCRIPTION', desc('dplyr'));
    await write(root, 'packages/dplyr/NAMESPACE', 'export(filter)\n');
    for (const [, dir] of VENDORED) await write(root, `${dir}/DESCRIPTION`, desc('dplyr'));
    const cfg = await loadRPackageConfig(root);
    expect([...cfg.packages].sort()).toEqual([
      ['dplyr', 'packages/dplyr'],
      ['mypkg', ''],
    ]);
    expect([...cfg.namespaceInfoByPackageDir.keys()].sort()).toEqual(['', 'packages/dplyr']);
    expect(cfg.truncated).toBe(false);
  });

  it('an installed library package is external for qualifier resolution', async () => {
    const root = await rootPackageRepo();
    await write(root, 'renv/library/x86_64-pc-linux-gnu/4.3/dplyr/DESCRIPTION', desc('dplyr'));
    const cfg = await loadRPackageConfig(root);
    expect(rQualifierLocality('dplyr', cfg, new Set())).toBe('external');
    expect(rQualifierLocality('mypkg', cfg, new Set())).toBe('local');
  });

  describe.each(NEAR_MISSES)('near-miss name %s', (name) => {
    it('is still searched for packages', async () => {
      const root = await rootPackageRepo();
      await write(root, `${name}/DESCRIPTION`, desc('real'));
      await write(root, `${name}/NAMESPACE`, 'export(g)\n');
      const cfg = await loadRPackageConfig(root);
      expect(cfg.packages.get('real')).toBe(name);
      expect(cfg.namespaceInfoByPackageDir.has(name)).toBe(true);
    });

    it('is still searched by the hidden-package scan', async () => {
      const root = await newRepo();
      await write(root, `${name}/DESCRIPTION`, desc('real'));
      expect(await hidesUndiscoveredPackage([root], new Set())).toBe(true);
    });
  });
});
