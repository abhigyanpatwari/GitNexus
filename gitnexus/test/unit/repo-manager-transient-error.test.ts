/**
 * Regression test for listRegisteredRepos({ validate: true }) bare catch bug.
 *
 * BEFORE FIX: bare catch {} dropped entries on ANY fs.access error (EIO, EAGAIN,
 * EACCES, etc.) and persisted the pruned list → registry wiped to [].
 *
 * AFTER FIX: only prune on ENOENT/ENOTDIR (index genuinely gone). Transient I/O
 * errors keep the entry alive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
  registerRepo,
  listRegisteredRepos,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockMeta: any = {
  repoPath: '',
  lastCommit: 'abc1234',
  indexedAt: '2026-06-09T12:00:00.000Z',
  stats: { files: 1, nodes: 1 },
};

describe('listRegisteredRepos({ validate: true }) — transient error safety (#2121)', () => {
  let tmpHome: { dbPath: string; cleanup: () => Promise<void> };
  let tmpRepo: { dbPath: string; cleanup: () => Promise<void> };
  let savedGitnexusHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-transient-home-');
    tmpRepo = await createTempDir('gitnexus-transient-repo-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('ENOENT prunes the entry (index genuinely removed)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);

    // registerRepo writes the registry entry but doesn't create .gitnexus/meta.json.
    // That's done by analyze. Create it so the entry passes validation initially.
    const metaPath = path.join(tmpRepo.dbPath, '.gitnexus', 'meta.json');
    await fs.mkdir(path.dirname(metaPath), { recursive: true });
    await fs.writeFile(metaPath, JSON.stringify(mockMeta));

    const before = await listRegisteredRepos({ validate: true });
    expect(before).toHaveLength(1);

    // Delete meta.json to simulate genuinely removed index
    await fs.unlink(metaPath);

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(0);
  });

  it('ENOTDIR prunes the entry (structural removal)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    // Replace .gitnexus dir with a regular file — fs.access(path/meta.json)
    // throws ENOTDIR because .gitnexus is now a file, not a directory
    const dotGitnexus = path.join(tmpRepo.dbPath, '.gitnexus');
    await fs.rm(dotGitnexus, { recursive: true, force: true });
    await fs.writeFile(dotGitnexus, 'not-a-dir');

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(0);
  });

  it('EACCES keeps the entry (transient permission error)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    // Mock fs.access to throw EACCES — simulates NFS hiccup or temp permission
    const originalAccess = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr.includes('.gitnexus') && pStr.includes('meta.json')) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (originalAccess as any).call(fs, p, mode);
    });

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe(before[0].name);
  });

  it('EIO keeps the entry (transient I/O error)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    const originalAccess = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr.includes('.gitnexus') && pStr.includes('meta.json')) {
        const err = new Error('input/output error') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      return (originalAccess as any).call(fs, p, mode);
    });

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(1);
  });

  it('EAGAIN keeps the entry (resource temporarily unavailable)', async () => {
    await registerRepo(tmpRepo.dbPath, mockMeta);
    const before = await listRegisteredRepos();
    expect(before).toHaveLength(1);

    const originalAccess = fs.access;
    vi.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      const pStr = typeof p === 'string' ? p : p.toString();
      if (pStr.includes('.gitnexus') && pStr.includes('meta.json')) {
        const err = new Error('resource temporarily unavailable') as NodeJS.ErrnoException;
        err.code = 'EAGAIN';
        throw err;
      }
      return (originalAccess as any).call(fs, p, mode);
    });

    const after = await listRegisteredRepos({ validate: true });
    expect(after).toHaveLength(1);
  });
});
