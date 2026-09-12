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
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
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
    storageResolverCtx.inspectRegisteredStorage.mockImplementationOnce(async (entry: any) => {
      inspectionStarted();
      await releaseInspectionPromise;
      return {
        repoPath: entry.path,
        storagePath: entry.storagePath,
        state: 'missing',
        hasCodeIndexDB: false,
      };
    });

    const validatingRead = listRegisteredRepos({ validate: true });
    await inspectionStartedPromise;
    await registerRepo(repoPath, meta, { name: 'repo', storagePath: replacementStoragePath });
    releaseInspection();

    await expect(validatingRead).resolves.toEqual([]);
    await expect(readRegistry()).resolves.toMatchObject([
      { path: repoPath, storagePath: replacementStoragePath },
    ]);
  });
});
