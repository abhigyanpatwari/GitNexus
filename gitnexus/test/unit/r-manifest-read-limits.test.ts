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
import { execFileSync } from 'node:child_process';
import {
  hidesUndiscoveredPackage,
  loadRPackageConfig,
  readManifestFile,
} from '../../src/core/ingestion/languages/r/package-config.js';

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

describe('readManifestFile', () => {
  const dirFor = async (): Promise<string> => fs.mkdtemp(path.join(root, 'rm-'));

  it('reads a file at exactly the cap and keeps a leading byte-order mark', async () => {
    const dir = await dirFor();
    const file = path.join(dir, 'DESCRIPTION');
    const text = '﻿' + 'x'.repeat(4 * 1024 * 1024 - 3);
    await fs.writeFile(file, text);
    expect(Buffer.byteLength(text)).toBe(4 * 1024 * 1024);
    expect(await readManifestFile(file)).toBe(text);
  });

  it('reads an empty file', async () => {
    const dir = await dirFor();
    const file = path.join(dir, 'NAMESPACE');
    await fs.writeFile(file, '');
    expect(await readManifestFile(file)).toBe('');
  });

  it('rejects a file one byte over the cap', async () => {
    const dir = await dirFor();
    const file = path.join(dir, 'NAMESPACE');
    await fs.writeFile(file, OVER_THE_CAP);
    await expect(readManifestFile(file)).rejects.toThrow(/too large/);
  });

  it('rejects a missing file', async () => {
    const dir = await dirFor();
    await expect(readManifestFile(path.join(dir, 'NAMESPACE'))).rejects.toThrow();
  });

  it('rejects a directory, which is not a regular file', async () => {
    const dir = await dirFor();
    await fs.mkdir(path.join(dir, 'NAMESPACE'));
    await expect(readManifestFile(path.join(dir, 'NAMESPACE'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink without following it', async () => {
    const dir = await dirFor();
    const target = path.join(dir, 'target');
    await fs.writeFile(target, 'export(leaked)\n');
    await fs.symlink(target, path.join(dir, 'NAMESPACE'));
    await expect(readManifestFile(path.join(dir, 'NAMESPACE'))).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO without blocking', async () => {
    const dir = await dirFor();
    const fifo = path.join(dir, 'NAMESPACE');
    execFileSync('mkfifo', [fifo]);
    await expect(readManifestFile(fifo)).rejects.toThrow(/not a file/);
  });
});

describe('hidesUndiscoveredPackage manifest reads', () => {
  it('cannot rule a package out when a DESCRIPTION in a skipped subtree is over the cap', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'hide-'));
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.writeFile(
      path.join(dir, 'sub', 'DESCRIPTION'),
      `Package: known\nX: ${OVER_THE_CAP}\n`,
    );
    expect(await hidesUndiscoveredPackage([dir], new Set(['known']))).toBe(true);
  });

  it('rules a known package out when its DESCRIPTION is readable', async () => {
    const dir = await fs.mkdtemp(path.join(root, 'hide-'));
    await fs.mkdir(path.join(dir, 'sub'));
    await fs.writeFile(path.join(dir, 'sub', 'DESCRIPTION'), 'Package: known\n');
    expect(await hidesUndiscoveredPackage([dir], new Set(['known']))).toBe(false);
  });
});
