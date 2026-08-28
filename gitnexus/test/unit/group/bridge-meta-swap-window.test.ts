import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { makeContract } from './fixtures.js';
import { BRIDGE_SCHEMA_VERSION } from '../../../src/core/group/bridge-schema.js';

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

const { writeBridge, readBridgeMeta, bridgeMetaMatchesFile, closeAllCachedBridges } =
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

  it('accepts metadata that carries no stamp but was written after its database', async () => {
    // Back-compat: a bridge written before the stamp existed carries no stamp
    // to check, and failing those closed would mark every pre-existing bridge
    // incomplete — a repo-wide regression traded for a narrow window. It is
    // still paired to a database, though: `writeBridge` renames the database in
    // and writes the metadata after, so this pair's write order is intact and
    // that is what it is judged on.
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

describe('bridgeMetaMatchesFile pairs an unstamped meta by write order', () => {
  /**
   * A metadata file with no stamp cannot answer "is this the database I was
   * written for?" from its own contents. It is not silent, though: a successful
   * `writeBridge` renames the database into place and THEN writes the metadata,
   * so `meta.mtime >= db.mtime` holds for every pair written together —
   * including pairs written by builds that predate stamping, which is the whole
   * reason those are not simply failed closed.
   *
   * A database strictly NEWER than the metadata beside it inverts that order,
   * and the only way to reach it is a swap whose metadata write did not land.
   *
   * This is a heuristic on write order, not proof of provenance, so these cases
   * set both timestamps explicitly with `fsp.utimes`. Nothing here sleeps and
   * nothing waits for a filesystem to tick: the separation is written, not
   * hoped for, so the same verdict comes back on a 1-second-granularity
   * filesystem as on a nanosecond one.
   */
  let groupDir: string;

  /** Fixed, whole-second instants — exactly representable on any filesystem. */
  const WRITTEN_AT = new Date('2026-01-01T00:00:00.000Z');
  const TEN_SECONDS_LATER = new Date('2026-01-01T00:00:10.000Z');

  beforeEach(async () => {
    renameMock.mode = 'none';
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bridge-unstamped-'));
  });

  afterEach(async () => {
    renameMock.mode = 'none';
    await closeAllCachedBridges();
    await fsp.rm(groupDir, { recursive: true, force: true });
  });

  /**
   * Produce the legacy shape from a real bridge: a database written by
   * `writeBridge` with metadata beside it that carries no stamp, exactly as a
   * build from before stamping left it.
   */
  const seedUnstamped = async (): Promise<void> => {
    await writeBridge(groupDir, input([]));
    const metaPath = path.join(groupDir, 'meta.json');
    const raw = JSON.parse(await fsp.readFile(metaPath, 'utf-8')) as Record<string, unknown>;
    delete raw.bridgeSize;
    delete raw.bridgeMtimeMs;
    await fsp.writeFile(metaPath, JSON.stringify(raw, null, 2));
  };

  const setMtimes = async (db: Date | null, meta: Date | null): Promise<void> => {
    if (db) await fsp.utimes(path.join(groupDir, 'bridge.lbug'), db, db);
    if (meta) await fsp.utimes(path.join(groupDir, 'meta.json'), meta, meta);
  };

  it('accepts an unstamped pair whose two files share a timestamp', async () => {
    // The coarse-filesystem case: both writes land in the same tick, so the
    // order they happened in is no longer visible. Equality is the pair being
    // written together as far as anything can tell, and rejecting it would fail
    // every legacy bridge on a 1-second-granularity filesystem.
    await seedUnstamped();
    await setMtimes(WRITTEN_AT, WRITTEN_AT);
    const meta = await readBridgeMeta(groupDir);

    expect(meta.bridgeSize).toBeUndefined();
    expect(meta.bridgeMtimeMs).toBeUndefined();
    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(true);
  });

  it('accepts an unstamped meta written after the database it sits beside', async () => {
    await seedUnstamped();
    await setMtimes(WRITTEN_AT, TEN_SECONDS_LATER);
    const meta = await readBridgeMeta(groupDir);

    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(true);
  });

  it('rejects an unstamped meta when the database was replaced underneath it', async () => {
    // The window this branch exists for. A sync that swapped the database and
    // stopped before writing metadata leaves the PREVIOUS sync's completeness
    // beside a database it never measured — and `runGroupImpact` spends that as
    // fact. With no stamp to check, the inverted write order is the only thing
    // that says so, and it says so unambiguously.
    await seedUnstamped();
    await setMtimes(TEN_SECONDS_LATER, WRITTEN_AT);
    const meta = await readBridgeMeta(groupDir);

    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(false);
  });

  it('rejects an unstamped meta when there is no database beside it at all', async () => {
    // Metadata describing a file that is not there describes nothing. The
    // stamped path already answers `false` here; the unstamped path must not
    // answer `true` just because it had no stamp to compare.
    await seedUnstamped();
    await fsp.rm(path.join(groupDir, 'bridge.lbug'), { force: true });
    const meta = await readBridgeMeta(groupDir);

    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(false);
  });

  it('keeps following the stamp when a stamped pair has its file times skewed against it', async () => {
    // The ordering guard, acceptance direction. A stamped meta whose FILE is
    // older than the database still matches, because the stamp inside it says
    // so and the stamp is the stronger evidence. Only the metadata file's time
    // is moved — touching the database would invalidate the stamp itself and
    // make this measure the wrong thing.
    await writeBridge(groupDir, input([]));
    const dbStat = await fsp.stat(path.join(groupDir, 'bridge.lbug'));
    await setMtimes(null, new Date(dbStat.mtimeMs - 10_000));
    const meta = await readBridgeMeta(groupDir);

    expect(meta.bridgeSize).toBeTypeOf('number');
    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(true);
  });

  it('keeps following the stamp when a stale stamped meta has the newer file time', async () => {
    // The ordering guard, rejection direction. The mtime heuristic must not be
    // reachable as a second chance for a stamp that already failed: this pair
    // has the write order a paired write produces and a stamp that says the
    // database is not the one it describes.
    await writeBridge(groupDir, input([]));
    const dbPath = path.join(groupDir, 'bridge.lbug');
    const bytes = await fsp.readFile(dbPath);
    await fsp.writeFile(dbPath, Buffer.concat([bytes, Buffer.from([0])]));
    const dbStat = await fsp.stat(dbPath);
    await setMtimes(null, new Date(dbStat.mtimeMs + 10_000));
    const meta = await readBridgeMeta(groupDir);

    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(false);
  });
});

describe('bridgeMetaMatchesFile reads an explicit provenance marker first', () => {
  /**
   * The strongest evidence a metadata file can carry about which database it
   * describes is a statement from the writer that it does NOT describe the one
   * beside it. `bridgeMetaMatchesFile` orders its checks by evidence strength,
   * and this one outranks both of the others — its doc has said so since the
   * stamp landed; these cases make it true.
   *
   * The marker exists because the preserve path in `syncGroup` refreshes
   * `meta.json` without touching `bridge.lbug`. That rewrite is atomic, so the
   * metadata's mtime becomes now while the database's stays old — the write
   * order a paired write produces, and the shape the unstamped rule ACCEPTS.
   * Writing "no stamp" instead of a marker would therefore let a preserve sync
   * convert a pair the rule had been rejecting into one it waves through.
   */
  let groupDir: string;

  beforeEach(async () => {
    renameMock.mode = 'none';
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bridge-marker-'));
  });

  afterEach(async () => {
    renameMock.mode = 'none';
    await closeAllCachedBridges();
    await fsp.rm(groupDir, { recursive: true, force: true });
  });

  it('rejects a marked pair whose stamp matches the database beside it', async () => {
    await writeBridge(groupDir, input([]));
    const meta = await readBridgeMeta(groupDir);

    // The control: this exact pair is otherwise verified by the stamp.
    await expect(bridgeMetaMatchesFile(groupDir, meta)).resolves.toBe(true);

    await expect(
      bridgeMetaMatchesFile(groupDir, { ...meta, provenanceUnknown: true }),
    ).resolves.toBe(false);
  });

  it('rejects a marked pair whose write order says it is paired', async () => {
    // The unstamped branch, and the one the preserve path actually reaches: an
    // atomic metadata rewrite always leaves `meta.mtime >= db.mtime`, so the
    // heuristic has nothing left to object to and the marker is the only
    // surviving record of the verdict.
    await writeBridge(groupDir, input([]));
    const meta = await readBridgeMeta(groupDir);
    const legacy = { ...meta };
    delete legacy.bridgeSize;
    delete legacy.bridgeMtimeMs;

    await expect(bridgeMetaMatchesFile(groupDir, legacy)).resolves.toBe(true);

    await expect(
      bridgeMetaMatchesFile(groupDir, { ...legacy, provenanceUnknown: true }),
    ).resolves.toBe(false);
  });

  it('rejects a marked metadata file even when the database is gone', async () => {
    // Nothing about the files can overturn the marker, including the absence of
    // the file the stamp branch would have stat'd.
    await writeBridge(groupDir, input([]));
    const meta = await readBridgeMeta(groupDir);
    await fsp.rm(path.join(groupDir, 'bridge.lbug'), { force: true });

    await expect(
      bridgeMetaMatchesFile(groupDir, { ...meta, provenanceUnknown: true }),
    ).resolves.toBe(false);
  });
});

describe('readBridgeMeta normalizes a version that is not a version', () => {
  let groupDir: string;

  beforeEach(async () => {
    renameMock.mode = 'none';
    groupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-bridge-version-'));
  });

  afterEach(async () => {
    renameMock.mode = 'none';
    await fsp.rm(groupDir, { recursive: true, force: true });
  });

  /**
   * `0` is this file's word for "no provenance", and every gate is written
   * against it. A parseable but impossible version — negative, fractional,
   * NaN-adjacent — is not a schema version, and if it survives the read it
   * splits the gates apart: the two openers compare `> 0 && !== CURRENT` and
   * let it through, `bridgeExists` compares `=== 0 || === CURRENT` and says the
   * bridge is not there, and the provenance check compares `=== 0` and calls
   * the answer complete. Four gates, four verdicts, one file.
   *
   * Normalizing at the reader is what keeps them agreeing, rather than teaching
   * each gate the same new case.
   */
  const seedVersion = async (version: unknown): Promise<void> => {
    await fsp.writeFile(path.join(groupDir, 'bridge.lbug'), 'db');
    await fsp.writeFile(
      path.join(groupDir, 'meta.json'),
      JSON.stringify({ version, generatedAt: '', missingRepos: [] }),
    );
  };

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    // JSON cannot carry Infinity — it serializes to `null`, so this one is
    // caught by the pre-existing type check rather than by the range check.
    // Kept because it is a shape a hand-edited file can still present.
    ['infinite', Number.POSITIVE_INFINITY],
  ])('reads a %s version as no provenance rather than as a schema version', async (_label, v) => {
    await seedVersion(v);
    const meta = await readBridgeMeta(groupDir);
    expect(meta.version).toBe(0);
  });

  it('control: the current schema version is preserved exactly', async () => {
    await seedVersion(BRIDGE_SCHEMA_VERSION);
    const meta = await readBridgeMeta(groupDir);
    expect(meta.version).toBe(BRIDGE_SCHEMA_VERSION);
  });
});
