/**
 * `loadRPackageConfig` reads DESCRIPTION and NAMESPACE from the analysed repository. Both are
 * read only as regular files listed by the directory read (a symlink is never followed), and
 * neither is read beyond a size cap, because they are not source files and the walker's cap does
 * not cover them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadRPackageConfig } from '../../src/core/ingestion/languages/r/package-config.js';

let root: string;
let counter = 0;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-r-manifest-'));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A fresh repository holding the package `pk` with the given DESCRIPTION. */
async function repoWith(description = 'Package: pk\nVersion: 0.1.0\n'): Promise<string> {
  const repo = path.join(root, `repo${String(counter++)}`);
  await fs.mkdir(path.join(repo, 'R'), { recursive: true });
  await fs.writeFile(path.join(repo, 'DESCRIPTION'), description);
  return repo;
}

const OVER_THE_CAP = 'x'.repeat(4 * 1024 * 1024 + 1);

describe('R manifest reads', () => {
  it('reads an ordinary NAMESPACE', async () => {
    const repo = await repoWith();
    await fs.writeFile(path.join(repo, 'NAMESPACE'), 'export(pub)\n');
    const info = (await loadRPackageConfig(repo)).namespaceInfoByPackageDir.get('');
    expect(info?.hasNamespaceFile).toBe(true);
    expect([...(info?.namedExports ?? [])]).toEqual(['pub']);
  });

  it.skipIf(process.platform === 'win32')('does not follow a NAMESPACE symlink', async () => {
    const repo = await repoWith();
    const outside = path.join(root, 'outside-namespace');
    await fs.writeFile(outside, 'export(leaked)\n');
    await fs.symlink(outside, path.join(repo, 'NAMESPACE'));
    const config = await loadRPackageConfig(repo);
    expect(config.packages.get('pk')).toBe('');
    expect(config.namespaceInfoByPackageDir.has('')).toBe(false);
  });

  it('does not read a NAMESPACE over the cap', async () => {
    const repo = await repoWith();
    await fs.writeFile(path.join(repo, 'NAMESPACE'), OVER_THE_CAP);
    const config = await loadRPackageConfig(repo);
    expect(config.packages.get('pk')).toBe('');
    expect(config.namespaceInfoByPackageDir.has('')).toBe(false);
  });

  it('does not read a DESCRIPTION over the cap, and says discovery may be incomplete', async () => {
    const repo = await repoWith(`Package: pk\nDescription: ${OVER_THE_CAP}\n`);
    await fs.writeFile(path.join(repo, 'NAMESPACE'), 'export(pub)\n');
    const config = await loadRPackageConfig(repo);
    expect(config.packages.size).toBe(0);
    expect(config.truncated).toBe(true);
  });
});
