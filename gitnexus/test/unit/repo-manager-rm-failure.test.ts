/**
 * rm-failure paths for adoptFlatBranchLabel (#2364 review F4).
 * Separate from repo-manager.test.ts: Vitest cannot vi.spyOn ESM namespace
 * exports of fs/promises; a delegating vi.mock is required for mock rejects
 * (same split as repo-manager-ensure-ignore-readonly.test.ts, #1549).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

const fsCtx = vi.hoisted(() => ({
  rmMock: vi.fn(),
  realRm: null as ((...args: unknown[]) => Promise<unknown>) | null,
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const d = actual.default;
  fsCtx.realRm = d.rm.bind(d);
  fsCtx.rmMock.mockImplementation((...args) => fsCtx.realRm!(...args));
  return {
    default: new Proxy(d, {
      get(target, prop) {
        if (prop === 'rm') return fsCtx.rmMock;
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

import fs from 'fs/promises';
import {
  adoptFlatBranchLabel,
  registerRepo,
  listRegisteredRepos,
  getStoragePaths,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { _captureLogger } from '../../src/core/logger.js';
import { createTempDir } from '../helpers/test-db.js';

describe('adoptFlatBranchLabel — rm failure keeps the branch summary (#2364 F4)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  const metaFor = (branch: string, lastCommit: string): RepoMeta => ({
    repoPath: '',
    lastCommit,
    indexedAt: '2026-07-03T12:00:00.000Z',
    branch,
    stats: { files: 1, nodes: 1 },
  });

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-rm-failure-home-');
    tmpRepo = await createTempDir('gitnexus-rm-failure-repo-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    fsCtx.rmMock.mockClear();
    fsCtx.rmMock.mockImplementation((...args) => fsCtx.realRm!(...args));
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
    await tmpRepo.cleanup();
  });

  it('keeps the summary, warns with the errno, and still restamps the label on EBUSY', async () => {
    await registerRepo(tmpRepo.dbPath, metaFor('main', 'aaa1111'));
    await registerRepo(tmpRepo.dbPath, metaFor('feature/x', 'bbb2222'), { branch: 'feature/x' });
    const { metaPath } = getStoragePaths(tmpRepo.dbPath, 'feature/x');
    await saveMeta(path.dirname(metaPath), metaFor('feature/x', 'bbb2222'));

    const cap = _captureLogger();
    fsCtx.rmMock.mockRejectedValueOnce(Object.assign(new Error('mock busy'), { code: 'EBUSY' }));
    try {
      await adoptFlatBranchLabel(tmpRepo.dbPath, 'feature/x');
    } finally {
      cap.restore();
    }

    const [entry] = await listRegisteredRepos();
    // The informational label still restamps…
    expect(entry.branch).toBe('feature/x');
    // …but the summary survives so `clean --branch` can still target the dir…
    expect(entry.branches?.map((b) => b.branch)).toEqual(['feature/x']);
    // …which is still on disk.
    await expect(fs.access(path.dirname(metaPath))).resolves.toBeUndefined();
    expect(
      cap
        .records()
        .some(
          (r) =>
            r.level === 40 &&
            r.code === 'EBUSY' &&
            typeof r.path === 'string' &&
            String(r.msg ?? '').includes('clean --branch'),
        ),
    ).toBe(true);
  });

  it('a later adopt retries the rm and drops the summary once the dir is gone', async () => {
    await registerRepo(tmpRepo.dbPath, metaFor('main', 'aaa1111'));
    await registerRepo(tmpRepo.dbPath, metaFor('feature/x', 'bbb2222'), { branch: 'feature/x' });
    const { metaPath } = getStoragePaths(tmpRepo.dbPath, 'feature/x');
    await saveMeta(path.dirname(metaPath), metaFor('feature/x', 'bbb2222'));

    fsCtx.rmMock.mockRejectedValueOnce(Object.assign(new Error('mock busy'), { code: 'EBUSY' }));
    await adoptFlatBranchLabel(tmpRepo.dbPath, 'feature/x');
    // Retry with the real rm restored: cleanup completes.
    await adoptFlatBranchLabel(tmpRepo.dbPath, 'feature/x');

    const [entry] = await listRegisteredRepos();
    expect(entry.branch).toBe('feature/x');
    expect(entry.branches).toBeUndefined();
    await expect(fs.access(path.dirname(metaPath))).rejects.toThrow();
  });

  it('treats a never-materialized sub-index as gone (summary dropped, idempotent)', async () => {
    await registerRepo(tmpRepo.dbPath, metaFor('main', 'aaa1111'));
    await registerRepo(tmpRepo.dbPath, metaFor('feature/x', 'bbb2222'), { branch: 'feature/x' });
    // No saveMeta for the sub-index: nothing on disk, force:true rm is a no-op.

    await adoptFlatBranchLabel(tmpRepo.dbPath, 'feature/x');

    const [entry] = await listRegisteredRepos();
    expect(entry.branch).toBe('feature/x');
    expect(entry.branches).toBeUndefined();
  });
});
