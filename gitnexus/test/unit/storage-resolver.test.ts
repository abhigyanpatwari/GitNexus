import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidStoragePathError,
  defaultStoragePath,
  ensureStoragePathWritable,
  resolveStoragePath,
  validateConfiguredStoragePath,
} from '../../src/storage/storage-resolver.js';

const temporaryPaths: string[] = [];
const savedStoragePath = process.env.GITNEXUS_STORAGE_PATH;
const savedHome = process.env.GITNEXUS_HOME;

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(dir);
  return dir;
};

afterEach(async () => {
  if (savedStoragePath === undefined) delete process.env.GITNEXUS_STORAGE_PATH;
  else process.env.GITNEXUS_STORAGE_PATH = savedStoragePath;
  if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = savedHome;
  await Promise.all(
    temporaryPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('storage resolver', () => {
  it('keeps the repository-local default when no override or registration exists', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    delete process.env.GITNEXUS_STORAGE_PATH;
    process.env.GITNEXUS_HOME = await makeTempDir('gitnexus-storage-resolver-home-');

    expect(resolveStoragePath(repo)).toBe(defaultStoragePath(repo));
  });

  it('uses an explicit absolute slot before the registered slot', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    const registered = path.join(home, 'registered-index');
    const explicit = path.join(home, 'explicit-index');
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([{ path: repo, storagePath: registered }]),
    );
    process.env.GITNEXUS_STORAGE_PATH = explicit;

    expect(resolveStoragePath(repo)).toBe(explicit);
  });

  it('uses a registered external slot after the explicit override is absent', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    const registered = path.join(home, 'registered-index');
    delete process.env.GITNEXUS_STORAGE_PATH;
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([{ path: repo, storagePath: registered }]),
    );

    expect(resolveStoragePath(repo)).toBe(registered);
  });

  it('ignores malformed registry rows and falls back to the local layout', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    delete process.env.GITNEXUS_STORAGE_PATH;
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([null, 1, [], { path: repo, storagePath: 1 }]),
    );

    expect(resolveStoragePath(repo)).toBe(defaultStoragePath(repo));
  });

  it.each(['', 'relative/index', `bad\0index`])(
    'rejects invalid configured storage path %j',
    (value) => {
      expect(() => validateConfiguredStoragePath(value)).toThrow(InvalidStoragePathError);
    },
  );

  it('creates independent external slots and verifies they are writable', async () => {
    const root = await makeTempDir('gitnexus-storage-resolver-slots-');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');

    await Promise.all([ensureStoragePathWritable(first), ensureStoragePathWritable(second)]);

    await expect(fs.stat(first)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
    await expect(fs.stat(second)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it('fails before analysis when the target names a file instead of a writable directory', async () => {
    const root = await makeTempDir('gitnexus-storage-resolver-file-');
    const target = path.join(root, 'not-a-directory');
    await fs.writeFile(target, 'not a directory');

    await expect(ensureStoragePathWritable(target)).rejects.toThrow();
  });
});
