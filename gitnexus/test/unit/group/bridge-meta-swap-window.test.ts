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
 * #3011 `runGroupImpact` folds that into its truncation fields. So a STALE meta
 * left beside a NEWLY swapped bridge asserts that the new bridge is as complete
 * as the previous sync was — a confident wrong answer about the exact thing this
 * channel exists to make legible.
 *
 * Deleting the old meta before the swap would close that, and is wrong. The
 * rename of the old database is wrapped in a catch that also swallows a FAILED
 * rename — a held read-only handle does this on Windows — so `writeBridge` can
 * throw with the old, perfectly good database still in place. Its metadata would
 * then be gone unrecoverably, and cross-repo impact would answer "we cannot say"
 * for as long as the swap kept failing. That is a working feature destroyed to
 * close a narrow window.
 *
 * So nothing is deleted. `writeBridge` stamps the database's size and mtime into
 * the metadata, and `bridgeMetaMatchesFile` checks the pair still belongs
 * together. This file pins both halves: a stale meta is rejected, and a sync
 * that fails leaves the previous, matching pair intact.
 */

/**
 * `mode` selects which rename fails, and the distinction matters:
 *
 *  - `'all'` models the Windows shape the fix is really about. The old
 *    database's move to `.bak` is itself wrapped in a catch that swallows
 *    failures, so a held read-only handle makes that move fail SILENTLY and the
 *    subsequent `tmp -> bridge.lbug` throw — leaving the old database exactly
 *    where it was, still valid.
 *  - `'final'` fails only the `tmp -> bridge.lbug` step, so the old database has
 *    already been moved aside to `.bak` and no database is in place at all.
 */
const renameMock = vi.hoisted(() => ({ mode: 'none' as 'none' | 'all' | 'final' }));

vi.mock('../../../src/storage/fs-atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/storage/fs-atomic.js')>();
  return {
    ...actual,
    retryRename: async (src: string, dst: string) => {
      const fails =
        renameMock.mode === 'all' || (renameMock.mode === 'final' && dst.endsWith('bridge.lbug'));
      if (fails) throw new Error(`simulated rename failure for ${dst}`);
      return actual.retryRename(src, dst);
    },
  };
});

const { writeBridge, readBridgeMeta, bridgeMetaMatchesFile } =
  await import('../../../src/core/group/bridge-db.js');

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
    renameMock.mode = 'none';
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bridge-window-'));
  });

  afterEach(async () => {
    renameMock.mode = 'none';
    await fsp.rm(groupDir, { recursive: true, force: true });
  });

  it('keeps the previous metadata when the database swap fails, and it still matches', async () => {
    // The regression this file exists for. An earlier version of the fix deleted
    // meta.json before the swap; because the old-database rename is inside a
    // catch that swallows failures, `writeBridge` can throw with that database
    // still in place — and the metadata describing it already destroyed.
    await writeBridge(groupDir, input([]));
    const seeded = await readBridgeMeta(groupDir);

    // Every rename fails, so the old database never moves: this is the shape a
    // held handle produces on Windows.
    renameMock.mode = 'all';
    await expect(writeBridge(groupDir, input(['svc/users']))).rejects.toThrow('simulated rename');

    const after = await readBridgeMeta(groupDir);

    // Nothing was lost: the previous sync's measurement survives...
    expect(after.version).toBe(seeded.version);
    expect(after.generatedAt).toBe(seeded.generatedAt);
    expect(after.unreadableRepos).toEqual([]);
    // ...and it still describes the database that is actually on disk, so
    // cross-repo impact keeps answering from it instead of degrading to a floor
    // until some future sync happens to succeed.
    await expect(bridgeMetaMatchesFile(groupDir, after)).resolves.toBe(true);
  });

  it('reports no match when the swap moved the database aside and then failed', async () => {
    // The other failure shape: the old database reached `.bak` and the new one
    // never arrived, so there is no `bridge.lbug` for the surviving metadata to
    // describe. Rejecting is correct here — `ensureBridgeReady` fails loudly on
    // the absent database anyway, which is a better answer than a silent floor.
    await writeBridge(groupDir, input([]));
    const seeded = await readBridgeMeta(groupDir);

    renameMock.mode = 'final';
    await expect(writeBridge(groupDir, input(['svc/users']))).rejects.toThrow('simulated rename');

    const after = await readBridgeMeta(groupDir);

    expect(after.generatedAt).toBe(seeded.generatedAt);
    await expect(bridgeMetaMatchesFile(groupDir, after)).resolves.toBe(false);
  });

  it('rejects metadata that describes a different database', async () => {
    // The other half: the stale-meta-beside-a-new-bridge window. Simulated by
    // replacing the database underneath a metadata file that was written for
    // the previous one — which is the state a sync interrupted between the swap
    // and the metadata write leaves behind.
    await writeBridge(groupDir, input([]));
    const stale = await readBridgeMeta(groupDir);

    const dbPath = path.join(groupDir, 'bridge.lbug');
    const bytes = await fsp.readFile(dbPath);
    await fsp.writeFile(dbPath, Buffer.concat([bytes, Buffer.from([0])]));

    await expect(bridgeMetaMatchesFile(groupDir, stale)).resolves.toBe(false);
  });

  it('cannot verify metadata that carries no stamp, and does not reject it', async () => {
    // Back-compat: a bridge written before the stamp existed is unverifiable,
    // not stale. Failing those closed would mark every pre-existing bridge
    // incomplete — a repo-wide regression traded for a narrow window.
    await writeBridge(groupDir, input([]));
    const meta = await readBridgeMeta(groupDir);
    const legacy = { ...meta };
    delete legacy.bridgeSize;
    delete legacy.bridgeMtimeMs;

    await expect(bridgeMetaMatchesFile(groupDir, legacy)).resolves.toBe(true);
  });

  it('rejects a stamp when the database is gone entirely', async () => {
    await writeBridge(groupDir, input([]));
    const meta = await readBridgeMeta(groupDir);
    await fsp.rm(path.join(groupDir, 'bridge.lbug'), { force: true });

    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(false);
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

describe('bridgeMetaMatchesFile with a half-written stamp', () => {
  let groupDir: string;

  beforeEach(async () => {
    renameMock.mode = 'none';
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bridge-partial-'));
  });

  afterEach(async () => {
    renameMock.mode = 'none';
    await fsp.rm(groupDir, { recursive: true, force: true });
  });

  /**
   * A stamp is a PAIR. Either both halves describe the database beside them or
   * the metadata cannot vouch for it at all.
   *
   * The absent-stamp branch exists for metadata written before stamping, which
   * is a benign, known state. A metadata file carrying exactly one half is not
   * that: something wrote a stamp and did not finish, which is the very
   * condition the stamp was added to detect. Accepting it — as an `undefined`
   * check joined by `||` did — hands back "verified" for the one shape that
   * most deserves suspicion.
   */
  const seedStamped = async (): Promise<void> => {
    await writeBridge(groupDir, input([]));
  };

  const rewriteMeta = async (mutate: (m: Record<string, unknown>) => void): Promise<void> => {
    const metaPath = path.join(groupDir, 'meta.json');
    const raw = JSON.parse(await fsp.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    mutate(raw);
    await fsp.writeFile(metaPath, JSON.stringify(raw, null, 2));
  };

  it('rejects metadata carrying a size but no mtime', async () => {
    await seedStamped();
    await rewriteMeta((m) => {
      delete m.bridgeMtimeMs;
    });
    const meta = await readBridgeMeta(groupDir);
    expect(meta.bridgeSize).toBeTypeOf('number');
    expect(meta.bridgeMtimeMs).toBeUndefined();
    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(false);
  });

  it('rejects metadata carrying an mtime but no size', async () => {
    await seedStamped();
    await rewriteMeta((m) => {
      delete m.bridgeSize;
    });
    const meta = await readBridgeMeta(groupDir);
    expect(meta.bridgeMtimeMs).toBeTypeOf('number');
    expect(meta.bridgeSize).toBeUndefined();
    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(false);
  });

  it('still accepts metadata carrying neither half, which is the legacy shape', async () => {
    await seedStamped();
    await rewriteMeta((m) => {
      delete m.bridgeSize;
      delete m.bridgeMtimeMs;
    });
    const meta = await readBridgeMeta(groupDir);
    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(true);
  });

  it('control: a fully stamped pair written together still matches', async () => {
    await seedStamped();
    const meta = await readBridgeMeta(groupDir);
    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(true);
  });
});
