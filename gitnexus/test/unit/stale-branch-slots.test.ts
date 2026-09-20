import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { branchSlug } from '../../src/storage/branch-index.js';
import { INDEX_METADATA_FILE } from '../../src/storage/storage-constants.js';
import { listStaleBranchSlots } from '../../src/storage/stale-branch-slots.js';
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
