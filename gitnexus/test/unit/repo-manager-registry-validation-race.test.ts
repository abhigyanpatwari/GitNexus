import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';

const storageResolverCtx = vi.hoisted(() => ({
  inspectRegisteredStorage: vi.fn(),
}));

vi.mock('../../src/storage/storage-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/storage-resolver.js')>()),
  inspectRegisteredStorage: storageResolverCtx.inspectRegisteredStorage,
}));

import {
  listRegisteredRepos,
  readRegistry,
  registerRepo,
  type RegistryEntry,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import type { StorageInspection } from '../../src/storage/storage-resolver.js';
import { createTempDir } from '../helpers/test-db.js';

describe('listRegisteredRepos validation persistence', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-registry-atomic-home-');
    tmpRepo = await createTempDir('gitnexus-registry-atomic-repo-a-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    storageResolverCtx.inspectRegisteredStorage.mockReset();
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
    await tmpRepo.cleanup();
  });

  it('does not prune a concurrent re-registration into a different storage slot', async () => {
    const repoPath = tmpRepo.dbPath;
    const staleStoragePath = path.join(tmpHome.dbPath, 'stale-slot');
    const replacementStoragePath = path.join(tmpHome.dbPath, 'replacement-slot');
    const registryPath = path.join(tmpHome.dbPath, 'registry.json');
    const meta: RepoMeta = {
      repoPath,
      storagePath: replacementStoragePath,
      lastCommit: 'abc1234',
      indexedAt: '2026-09-05T00:00:00.000Z',
      stats: { files: 1, nodes: 1 },
    };
    await fs.writeFile(
      registryPath,
      JSON.stringify([
        {
          name: 'repo',
          path: repoPath,
          storagePath: staleStoragePath,
          indexedAt: meta.indexedAt,
          lastCommit: meta.lastCommit,
        },
      ]),
    );

    let inspectionStarted!: () => void;
    let releaseInspection!: () => void;
    const inspectionStartedPromise = new Promise<void>((resolve) => {
      inspectionStarted = resolve;
    });
    const releaseInspectionPromise = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    storageResolverCtx.inspectRegisteredStorage.mockImplementationOnce(
      async (entry: RegistryEntry) => {
        inspectionStarted();
        await releaseInspectionPromise;
        return {
          repoPath: entry.path,
          storagePath: entry.storagePath,
          state: 'missing',
          hasCodeIndexDB: false,
        };
      },
    );

    const validatingRead = listRegisteredRepos({ validate: true });
    try {
      await inspectionStartedPromise;
      await registerRepo(repoPath, meta, { name: 'repo', storagePath: replacementStoragePath });
      releaseInspection();

      await expect(validatingRead).resolves.toEqual([]);
      await expect(readRegistry()).resolves.toMatchObject([
        { path: repoPath, storagePath: replacementStoragePath },
      ]);
    } finally {
      releaseInspection();
      await validatingRead.catch(() => undefined);
    }
  });

  it.each(['updated', 'unchanged'] as const)(
    'keeps a concurrent same-slot re-registration with %s metadata',
    async (metadata) => {
      const repoPath = tmpRepo.dbPath;
      const storagePath = path.join(repoPath, '.gitnexus');
      const meta: RepoMeta = {
        repoPath,
        storagePath,
        lastCommit: 'initial-commit',
        indexedAt: '2026-09-05T00:00:00.000Z',
        stats: { files: 1, nodes: 1 },
      };
      await registerRepo(repoPath, meta, { name: 'repo', storagePath });

      let inspectionStarted!: () => void;
      let releaseInspection!: () => void;
      const started = new Promise<void>((resolve) => {
        inspectionStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseInspection = resolve;
      });
      storageResolverCtx.inspectRegisteredStorage
        .mockResolvedValue({
          repoPath,
          storagePath,
          state: 'owned',
          hasCodeIndexDB: true,
        } satisfies StorageInspection)
        .mockImplementationOnce(async (): Promise<StorageInspection> => {
          inspectionStarted();
          await released;
          return { repoPath, storagePath, state: 'missing', hasCodeIndexDB: false };
        });

      const validatingRead = listRegisteredRepos({ validate: true });
      try {
        await started;
        const replacement =
          metadata === 'updated'
            ? { ...meta, lastCommit: 'rebuilt-commit', indexedAt: '2026-09-06T00:00:00.000Z' }
            : meta;
        await registerRepo(repoPath, replacement, { name: 'repo', storagePath });
        releaseInspection();

        await expect(validatingRead).resolves.toEqual([]);
        await expect(readRegistry()).resolves.toMatchObject([
          {
            path: repoPath,
            storagePath,
            lastCommit: replacement.lastCommit,
            indexedAt: replacement.indexedAt,
          },
        ]);
      } finally {
        releaseInspection();
        await validatingRead.catch(() => undefined);
      }
    },
  );

  it('still persists pruning when the registered storage remains missing', async () => {
    const repoPath = tmpRepo.dbPath;
    const storagePath = path.join(repoPath, '.gitnexus');
    await registerRepo(repoPath, {
      repoPath,
      lastCommit: 'initial-commit',
      indexedAt: '2026-09-05T00:00:00.000Z',
      stats: { files: 1, nodes: 1 },
    });
    storageResolverCtx.inspectRegisteredStorage.mockResolvedValue({
      repoPath,
      storagePath,
      state: 'missing',
      hasCodeIndexDB: false,
    } satisfies StorageInspection);

    await expect(listRegisteredRepos({ validate: true })).resolves.toEqual([]);
    await expect(readRegistry()).resolves.toEqual([]);
  });

  it.each([
    { label: 'owned', state: 'owned', hasCodeIndexDB: true },
    {
      label: 'temporarily unreadable',
      state: 'invalid_storage',
      hasCodeIndexDB: false,
      reason: 'EIO: Storage directory could not be inspected.',
    },
    {
      label: 'empty with a transient database error',
      state: 'empty',
      hasCodeIndexDB: false,
      reason: 'EIO: LadybugDB directory could not be inspected.',
    },
  ] satisfies Array<
    Pick<StorageInspection, 'state' | 'hasCodeIndexDB' | 'reason'> & { label: string }
  >)(
    'does not rewrite the registry when the candidate becomes $label',
    async ({ label: _label, ...inspection }) => {
      const repoPath = tmpRepo.dbPath;
      const storagePath = path.join(repoPath, '.gitnexus');
      const registryPath = path.join(tmpHome.dbPath, 'registry.json');
      const original = JSON.stringify([{ name: 'repo', path: repoPath, storagePath }]);
      // Compact formatting makes an otherwise identical atomic rewrite visible.
      await fs.writeFile(registryPath, original);
      storageResolverCtx.inspectRegisteredStorage
        .mockResolvedValue({ repoPath, storagePath, ...inspection } satisfies StorageInspection)
        .mockResolvedValueOnce({
          repoPath,
          storagePath,
          state: 'missing',
          hasCodeIndexDB: false,
        } satisfies StorageInspection);

      await expect(listRegisteredRepos({ validate: true })).resolves.toEqual([]);
      expect(await fs.readFile(registryPath, 'utf8')).toBe(original);
    },
  );

  it('keeps an initially empty slot when its database inspection failed transiently', async () => {
    const repoPath = tmpRepo.dbPath;
    const storagePath = path.join(repoPath, '.gitnexus');
    const registryPath = path.join(tmpHome.dbPath, 'registry.json');
    const entry = { name: 'repo', path: repoPath, storagePath };
    const original = JSON.stringify([entry]);
    await fs.writeFile(registryPath, original);
    storageResolverCtx.inspectRegisteredStorage.mockResolvedValue({
      repoPath,
      storagePath,
      state: 'empty',
      hasCodeIndexDB: false,
      reason: 'EIO: LadybugDB directory could not be inspected.',
    } satisfies StorageInspection);

    await expect(listRegisteredRepos({ validate: true })).resolves.toEqual([entry]);
    expect(await fs.readFile(registryPath, 'utf8')).toBe(original);
  });

  it.each(['corrupt', 'deleted'] as const)(
    'does not overwrite a registry that becomes %s during validation',
    async (change) => {
      const repoPath = tmpRepo.dbPath;
      const storagePath = path.join(repoPath, '.gitnexus');
      const registryPath = path.join(tmpHome.dbPath, 'registry.json');
      const corrupt = '{"truncated":';
      await fs.writeFile(
        registryPath,
        JSON.stringify([{ name: 'repo', path: repoPath, storagePath }]),
      );
      storageResolverCtx.inspectRegisteredStorage.mockImplementation(
        async (): Promise<StorageInspection> => {
          if (change === 'corrupt') await fs.writeFile(registryPath, corrupt);
          else await fs.rm(registryPath, { force: true });
          return { repoPath, storagePath, state: 'missing', hasCodeIndexDB: false };
        },
      );

      await expect(listRegisteredRepos({ validate: true })).resolves.toEqual([]);
      if (change === 'corrupt') expect(await fs.readFile(registryPath, 'utf8')).toBe(corrupt);
      else await expect(fs.access(registryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('preserves an unrelated registration completed during validation', async () => {
    const repoPath = tmpRepo.dbPath;
    const storagePath = path.join(repoPath, '.gitnexus');
    const addedRepoPath = path.join(tmpHome.dbPath, 'new-repo');
    const registryPath = path.join(tmpHome.dbPath, 'registry.json');
    await fs.writeFile(
      registryPath,
      JSON.stringify([{ name: 'gone', path: repoPath, storagePath }]),
    );
    storageResolverCtx.inspectRegisteredStorage
      .mockResolvedValue({
        repoPath,
        storagePath,
        state: 'missing',
        hasCodeIndexDB: false,
      } satisfies StorageInspection)
      .mockImplementationOnce(async (): Promise<StorageInspection> => {
        await registerRepo(
          addedRepoPath,
          {
            repoPath: addedRepoPath,
            lastCommit: 'new-commit',
            indexedAt: '2026-09-06T00:00:00.000Z',
            stats: { files: 1, nodes: 1 },
          },
          { name: 'new-repo' },
        );
        return { repoPath, storagePath, state: 'missing', hasCodeIndexDB: false };
      });

    await expect(listRegisteredRepos({ validate: true })).resolves.toEqual([]);
    const persisted = await readRegistry();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ name: 'new-repo', path: addedRepoPath });
  });
});
