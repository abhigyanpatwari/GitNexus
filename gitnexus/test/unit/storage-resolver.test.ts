import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidStoragePathError,
  STORAGE_PATH_ENV,
  STORAGE_ROOT_ENV,
  requireDeletableStoragePath,
  StorageDeletionError,
  defaultStoragePath,
  ensureStoragePathWritable,
  resolveStoragePath,
  storagePathFromRoot,
  validateConfiguredStoragePath,
} from '../../src/storage/storage-resolver.js';

const temporaryPaths: string[] = [];
const savedStoragePath = process.env[STORAGE_PATH_ENV];
const savedStorageRoot = process.env[STORAGE_ROOT_ENV];
const savedHome = process.env.GITNEXUS_HOME;

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryPaths.push(dir);
  return dir;
};

afterEach(async () => {
  if (savedStoragePath === undefined) delete process.env[STORAGE_PATH_ENV];
  else process.env[STORAGE_PATH_ENV] = savedStoragePath;
  if (savedStorageRoot === undefined) delete process.env[STORAGE_ROOT_ENV];
  else process.env[STORAGE_ROOT_ENV] = savedStorageRoot;
  if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = savedHome;
  await Promise.all(
    temporaryPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('storage resolver', () => {
  it('keeps the repository-local default when no override or registration exists', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    delete process.env[STORAGE_PATH_ENV];
    delete process.env[STORAGE_ROOT_ENV];
    process.env.GITNEXUS_HOME = await makeTempDir('gitnexus-storage-resolver-home-');

    expect(resolveStoragePath(repo)).toBe(defaultStoragePath(repo));
  });

  it('uses an explicit complete storage path before a root or registered slot', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    const registered = path.join(home, 'registered-index');
    const explicit = path.join(home, 'explicit-index');
    const root = path.join(home, 'external-root');
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([{ path: repo, storagePath: registered }]),
    );
    process.env[STORAGE_PATH_ENV] = explicit;
    process.env[STORAGE_ROOT_ENV] = root;

    expect(resolveStoragePath(repo)).toBe(explicit);
  });

  it('derives an isolated slot beneath an explicit storage root before the registered slot', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    const registered = path.join(home, 'registered-index');
    const root = path.join(home, 'external-root');
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([{ path: repo, storagePath: registered }]),
    );
    delete process.env[STORAGE_PATH_ENV];
    process.env[STORAGE_ROOT_ENV] = root;

    expect(resolveStoragePath(repo)).toBe(storagePathFromRoot(root, repo));
  });

  it('uses a registered external slot after the explicit override is absent', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    const registered = path.join(home, 'registered-index');
    delete process.env[STORAGE_PATH_ENV];
    delete process.env[STORAGE_ROOT_ENV];
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([{ path: repo, storagePath: registered }]),
    );

    expect(resolveStoragePath(repo)).toBe(registered);
  });

  it('uses a registered external slot when the repository is reached through a symlink', async () => {
    const root = await makeTempDir('gitnexus-storage-resolver-symlink-');
    const repo = path.join(root, 'repo');
    const linkedRepo = path.join(root, 'repo-link');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    const registered = path.join(home, 'registered-index');
    await fs.mkdir(repo);
    await fs.symlink(repo, linkedRepo, process.platform === 'win32' ? 'junction' : 'dir');
    delete process.env[STORAGE_PATH_ENV];
    delete process.env[STORAGE_ROOT_ENV];
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([{ path: repo, storagePath: registered }]),
    );

    expect(resolveStoragePath(linkedRepo)).toBe(registered);
  });

  it.skipIf(process.platform !== 'win32')(
    'matches a registered missing repository through a Windows extended-length path',
    async () => {
      const home = await makeTempDir('gitnexus-storage-resolver-home-');
      const repo = path.join(home, 'removed-repository');
      const registered = path.join(home, 'registered-index');
      delete process.env[STORAGE_PATH_ENV];
      delete process.env[STORAGE_ROOT_ENV];
      process.env.GITNEXUS_HOME = home;
      await fs.writeFile(
        path.join(home, 'registry.json'),
        JSON.stringify([{ path: repo, storagePath: registered }]),
      );

      expect(resolveStoragePath(`\\\\?\\${repo}`)).toBe(registered);
    },
  );

  it('rejects a malformed matching registry row', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-repo-');
    const home = await makeTempDir('gitnexus-storage-resolver-home-');
    delete process.env[STORAGE_PATH_ENV];
    delete process.env[STORAGE_ROOT_ENV];
    process.env.GITNEXUS_HOME = home;
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([null, 1, [], { path: repo, storagePath: 1 }]),
    );

    expect(() => resolveStoragePath(repo)).toThrow(InvalidStoragePathError);
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

  it('allows deletion of a missing or empty repository-local slot', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-delete-repo-');
    const storagePath = defaultStoragePath(repo);
    await fs.mkdir(storagePath, { recursive: true });

    await expect(requireDeletableStoragePath({ path: repo, storagePath })).resolves.toBe(
      storagePath,
    );
  });

  it('rejects a repository-local slot whose metadata belongs to another repository', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-delete-repo-');
    const storagePath = defaultStoragePath(repo);
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(
      path.join(storagePath, 'gitnexus.json'),
      JSON.stringify({ repoPath: path.join(path.dirname(repo), 'other-repo') }),
    );

    await expect(requireDeletableStoragePath({ path: repo, storagePath })).rejects.toBeInstanceOf(
      StorageDeletionError,
    );
  });

  it('requires matching metadata before deleting an external slot', async () => {
    const repo = await makeTempDir('gitnexus-storage-resolver-delete-repo-');
    const storagePath = await makeTempDir('gitnexus-storage-resolver-delete-storage-');
    await fs.writeFile(
      path.join(storagePath, 'gitnexus.json'),
      JSON.stringify({ repoPath: repo, storagePath }),
    );

    await expect(requireDeletableStoragePath({ path: repo, storagePath })).resolves.toBe(
      storagePath,
    );

    await fs.rm(path.join(storagePath, 'gitnexus.json'));
    await expect(requireDeletableStoragePath({ path: repo, storagePath })).rejects.toBeInstanceOf(
      StorageDeletionError,
    );
  });
});
