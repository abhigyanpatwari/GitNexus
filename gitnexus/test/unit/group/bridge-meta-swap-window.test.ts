import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { makeContract } from './fixtures.js';

/**
 * `writeBridge` replaces `bridge.lbug` and writes `meta.json` as two separate
 * operations, so there is a window between them that an interrupted or failing
 * sync stops inside. Which way that window fails is a correctness decision, not
 * a detail.
 *
 * `meta.json` records which repos the sync could not account for, and since
 * #3011 `runGroupImpact` folds that into its truncation fields. So a STALE
 * meta left beside a NEWLY swapped bridge asserts that the new bridge is as
 * complete as the previous sync was — a confident wrong answer about the exact
 * thing this channel exists to make legible. An ABSENT meta is read as unknown
 * provenance and reported as a floor, which is merely conservative.
 *
 * The write path therefore removes the old meta BEFORE the swap. This file
 * pins that ordering by failing the swap itself: if the removal were moved
 * after the rename (or dropped), the previous sync's meta would survive here.
 */

const renameMock = vi.hoisted(() => ({ failOn: '' }));

vi.mock('../../../src/storage/fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/storage/fs-atomic.js')>();
  return {
    ...actual,
    retryRename: async (src: string, dst: string) => {
      if (renameMock.failOn && dst.endsWith(renameMock.failOn)) {
        throw new Error(`simulated rename failure for ${dst}`);
      }
      return actual.retryRename(src, dst);
    },
  };
});

const { writeBridge, readBridgeMeta } = await import('../../../src/core/group/bridge-db.js');

const input = (unreadableRepos?: string[]) => ({
  contracts: [makeContract()],
  crossLinks: [],
  repoSnapshots: {},
  missingRepos: [],
  ...(unreadableRepos ? { unreadableRepos } : {}),
});

describe('writeBridge meta.json swap window', () => {
  let groupDir: string;

  beforeEach(async () => {
    renameMock.failOn = '';
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bridge-window-'));
  });

  afterEach(async () => {
    renameMock.failOn = '';
    await fsp.rm(groupDir, { recursive: true, force: true });
  });

  it('leaves no metadata behind when the database swap fails', async () => {
    // A complete previous sync, so the meta on disk says "nothing unreadable".
    await writeBridge(groupDir, input());
    const seeded = await readBridgeMeta(groupDir);

    // The next sync fails at the moment it replaces the database file.
    renameMock.failOn = 'bridge.lbug';
    await expect(writeBridge(groupDir, input(['svc/users']))).rejects.toThrow('simulated rename');

    const after = await readBridgeMeta(groupDir);

    expect(seeded.version).toBeGreaterThan(0);
    // The seeded meta must NOT have survived. If it had, an impact query
    // against whatever bridge is now on disk would read "complete" from a
    // previous run's measurement.
    expect(after.version).toBe(0);
    await expect(fsp.access(path.join(groupDir, 'meta.json'))).rejects.toThrow();
  });

  it('records the new metadata when the swap succeeds', async () => {
    // The control: removing the old meta early must not cost the happy path
    // its metadata, which a fix that only deleted would.
    await writeBridge(groupDir, input());

    await writeBridge(groupDir, input(['svc/users']));

    const after = await readBridgeMeta(groupDir);
    expect(after.version).toBeGreaterThan(0);
    expect(after.unreadableRepos).toEqual(['svc/users']);
  });
});
