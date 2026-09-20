import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { branchSlug } from '../../src/storage/branch-index.js';
import { INDEX_METADATA_FILE } from '../../src/storage/storage-constants.js';
import {
  listRegisteredRepos,
  registerRepo,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import * as repoManager from '../../src/storage/repo-manager.js';
import { listStaleBranchSlots, removeBranchSlot } from '../../src/storage/stale-branch-slots.js';
import { createTempDir, type TestDBHandle } from '../helpers/test-db.js';

async function writeSlotMeta(dir: string, branch: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, INDEX_METADATA_FILE),
    JSON.stringify({ branch, lastCommit: 'abc', indexedAt: '2026-09-20T00:00:00.000Z' }),
  );
}

describe('listStaleBranchSlots (#3331)', () => {
  let fixture: TestDBHandle;
  let repoPath: string;
  let storagePath: string;

  beforeEach(async () => {
    fixture = await createTempDir();
    repoPath = path.join(fixture.dbPath, 'repo');
    storagePath = path.join(repoPath, '.gitnexus');
    await fs.mkdir(repoPath, { recursive: true });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('classifies a recorded branch with no local head as ref-missing', async () => {
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await writeSlotMeta(dir, 'feature/x');
    await fs.writeFile(path.join(dir, 'blob.bin'), 'x');

    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [{ branch: 'feature/x' }],
      heads: ['main'],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        branch: 'feature/x',
        dir,
        reason: 'ref-missing',
      }),
    ]);
    expect(rows[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('does not classify a recorded branch that is still a local head', async () => {
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await writeSlotMeta(dir, 'feature/x');

    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [{ branch: 'feature/x' }],
      heads: ['main', 'feature/x'],
    });

    expect(rows).toEqual([]);
  });

  it('classifies a leftover directory with no registry row as disk-only', async () => {
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await writeSlotMeta(dir, 'feature/x');

    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [],
      heads: ['main'],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        branch: 'feature/x',
        dir,
        reason: 'disk-only',
      }),
    ]);
  });

  it('does not classify a registry row when the slug path is unreadable', async () => {
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await writeSlotMeta(dir, 'feature/x');
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(dir)) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realStat(target, options);
    });

    try {
      const rows = await listStaleBranchSlots({
        repoPath,
        storagePath,
        branches: [{ branch: 'feature/x' }],
        heads: ['main'],
      });
      expect(rows).toEqual([]);
    } finally {
      statSpy.mockRestore();
    }
  });

  it('classifies a registry row whose directory is gone as registry-only', async () => {
    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [{ branch: 'feature/x' }],
      heads: ['main'],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        branch: 'feature/x',
        dir: null,
        sizeBytes: 0,
        reason: 'registry-only',
      }),
    ]);
  });

  it('does not classify an unreadable leftover directory with no registry row', async () => {
    const dir = path.join(storagePath, 'branches', 'mystery-deadbeef');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, INDEX_METADATA_FILE), '{not-json');

    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [],
      heads: ['main'],
    });

    expect(rows).toEqual([]);
  });

  it('classifies from the recorded name when the slug path exists even if metadata is unreadable', async () => {
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, INDEX_METADATA_FILE), '{not-json');

    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [{ branch: 'feature/x' }],
      heads: ['main'],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        branch: 'feature/x',
        dir,
        reason: 'ref-missing',
      }),
    ]);
  });

  it('tags every known slot heads-unavailable when heads cannot be listed', async () => {
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await writeSlotMeta(dir, 'feature/x');

    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [{ branch: 'feature/x' }],
      heads: null,
    });

    expect(rows).toEqual([
      expect.objectContaining({
        branch: 'feature/x',
        dir,
        reason: 'heads-unavailable',
      }),
    ]);
  });

  it('does not treat the workspace/flat slot as a branch directory', async () => {
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(
      path.join(storagePath, INDEX_METADATA_FILE),
      JSON.stringify({ branch: 'main' }),
    );
    await fs.writeFile(path.join(storagePath, 'parse-cache.json'), '{}');

    const rows = await listStaleBranchSlots({
      repoPath,
      storagePath,
      branches: [],
      heads: ['main'],
    });

    expect(rows).toEqual([]);
  });
});

describe('removeBranchSlot (#3331)', () => {
  let home: TestDBHandle;
  let fixture: TestDBHandle;
  let repoPath: string;
  let storagePath: string;
  let savedHome: string | undefined;

  const metaFor = (branch: string): RepoMeta => ({
    repoPath: '',
    lastCommit: 'abc',
    indexedAt: '2026-09-20T00:00:00.000Z',
    branch,
    stats: { files: 1, nodes: 1 },
  });

  beforeEach(async () => {
    home = await createTempDir();
    fixture = await createTempDir();
    repoPath = path.join(fixture.dbPath, 'repo');
    storagePath = path.join(repoPath, '.gitnexus');
    await fs.mkdir(repoPath, { recursive: true });
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = home.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await fixture.cleanup();
    await home.cleanup();
  });

  it('removes the last slot, drops the registry row, and rmdirs empty branches/', async () => {
    await registerRepo(repoPath, metaFor('main'));
    await registerRepo(repoPath, metaFor('feature/x'), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await writeSlotMeta(dir, 'feature/x');
    await fs.writeFile(path.join(storagePath, 'parse-cache.json'), '{}');

    const result = await removeBranchSlot({
      repoPath,
      storagePath,
      branch: 'feature/x',
      dir,
    });

    expect(result).toEqual({ ok: true, emptiedBranchesDir: true, keptRegistry: false });
    await expect(fs.access(dir)).rejects.toThrow();
    await expect(fs.access(path.join(storagePath, 'branches'))).rejects.toThrow();
    await expect(fs.readFile(path.join(storagePath, 'parse-cache.json'), 'utf8')).resolves.toBe(
      '{}',
    );
    const [entry] = await listRegisteredRepos();
    expect(entry.branches).toBeUndefined();
  });

  it('leaves the other slot and branches/ when two slots exist', async () => {
    await registerRepo(repoPath, metaFor('main'));
    await registerRepo(repoPath, metaFor('feature/x'), { branch: 'feature/x' });
    await registerRepo(repoPath, metaFor('feature/y'), { branch: 'feature/y' });
    const dirX = path.join(storagePath, 'branches', branchSlug('feature/x'));
    const dirY = path.join(storagePath, 'branches', branchSlug('feature/y'));
    await writeSlotMeta(dirX, 'feature/x');
    await writeSlotMeta(dirY, 'feature/y');

    const result = await removeBranchSlot({
      repoPath,
      storagePath,
      branch: 'feature/x',
      dir: dirX,
    });

    expect(result.ok).toBe(true);
    expect(result.emptiedBranchesDir).toBe(false);
    await expect(fs.access(dirY)).resolves.toBeUndefined();
    const [entry] = await listRegisteredRepos();
    expect(entry.branches?.map((row) => row.branch)).toEqual(['feature/y']);
  });

  it('refuses a target outside branches/', async () => {
    await registerRepo(repoPath, metaFor('main'));
    await registerRepo(repoPath, metaFor('feature/x'), { branch: 'feature/x' });
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(path.join(storagePath, 'parse-cache.json'), '{}');

    const result = await removeBranchSlot({
      repoPath,
      storagePath,
      branch: 'feature/x',
      dir: storagePath,
    });

    expect(result.ok).toBe(false);
    expect(result.keptRegistry).toBe(true);
    expect(result.emptiedBranchesDir).toBe(false);
    await expect(fs.readFile(path.join(storagePath, 'parse-cache.json'), 'utf8')).resolves.toBe(
      '{}',
    );
    const [entry] = await listRegisteredRepos();
    expect(entry.branches?.map((row) => row.branch)).toEqual(['feature/x']);
  });

  it('drops a registry-only row without requiring a directory', async () => {
    await registerRepo(repoPath, metaFor('main'));
    await registerRepo(repoPath, metaFor('feature/x'), { branch: 'feature/x' });

    const result = await removeBranchSlot({
      repoPath,
      storagePath,
      branch: 'feature/x',
      dir: null,
    });

    expect(result.ok).toBe(true);
    const [entry] = await listRegisteredRepos();
    expect(entry.branches).toBeUndefined();
  });

  it('keeps the registry row when removeBranchIndex rejects after a successful rm', async () => {
    await registerRepo(repoPath, metaFor('main'));
    await registerRepo(repoPath, metaFor('feature/x'), { branch: 'feature/x' });
    const dir = path.join(storagePath, 'branches', branchSlug('feature/x'));
    await writeSlotMeta(dir, 'feature/x');
    const spy = vi
      .spyOn(repoManager, 'removeBranchIndex')
      .mockRejectedValueOnce(new Error('lock timeout'));

    try {
      const result = await removeBranchSlot({
        repoPath,
        storagePath,
        branch: 'feature/x',
        dir,
      });

      expect(result.ok).toBe(false);
      expect(result.keptRegistry).toBe(true);
      expect(result.emptiedBranchesDir).toBe(false);
      expect(result.error?.message).toBe('lock timeout');
      await expect(fs.access(dir)).rejects.toThrow();
      const [entry] = await listRegisteredRepos();
      expect(entry.branches?.map((row) => row.branch)).toEqual(['feature/x']);
    } finally {
      spy.mockRestore();
    }
  });
});
