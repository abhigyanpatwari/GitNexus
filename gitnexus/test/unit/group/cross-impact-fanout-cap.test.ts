/**
 * #2787 — the cross-repo fan-out used to be bounded by a WALL CLOCK, so how far
 * it got was a function of machine load. `mergeRisk` is monotone increasing in
 * the traversed-crossing count (CRITICAL at 3, HIGH on any >=0.85-confidence
 * crossing), which meant an idle host reported CRITICAL and a loaded host
 * reported HIGH or lower for the same graph and the same arguments — and the
 * direction of that error is the unsafe one, because truncation can only
 * under-report a blast radius.
 *
 * The bound is now a count (MAX_NEIGHBOR_FANOUT) over a totally-ordered
 * neighbour list, and any truncation marks `risk` as a floor. No clock is
 * involved in any assertion below.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeHandle } from '../../../src/core/group/types.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';
import { makeGroupToolPort, writeGroupYaml } from './fixtures.js';

const bridgeHandle = {
  _db: {},
  _conn: {},
  groupDir: '',
  _readOnly: true,
} as BridgeHandle;

const bridgeRows = vi.hoisted(() => ({
  value: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../../src/core/group/bridge-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/group/bridge-db.js')>();
  return {
    ...actual,
    readBridgeMeta: vi.fn(async () => ({ version: 1, generatedAt: '', missingRepos: [] })),
    getCachedBridgeReadOnly: vi.fn(async () => bridgeHandle),
    queryBridge: vi.fn(async () => bridgeRows.value),
    closeBridgeDb: vi.fn(async () => undefined),
  };
});

const { runGroupImpact, MAX_NEIGHBOR_FANOUT, compareCodeUnits } =
  await import('../../../src/core/group/cross-impact.js');

/** Neighbour repo keys, zero-padded so lexicographic order is numeric order. */
const repoKey = (i: number) => `svc${String(i).padStart(3, '0')}`;

const crossingRow = (i: number, confidence = 1) => ({
  neighborRepo: repoKey(i),
  neighborUid: `Function:src/handler.ts:handle${String(i).padStart(3, '0')}`,
  neighborFilePath: 'src/handler.ts',
  matchType: 'exact',
  confidence,
  contractId: `custom::c${String(i).padStart(3, '0')}`,
  contractType: 'custom',
});

/** Contract ids, zero-padded so lexicographic order is numeric order. */
const contractKey = (i: number) => `custom::k${String(i).padStart(3, '0')}`;

/**
 * A crossing that shares confidence, repo AND uid with every other one — the
 * only thing separating these rows is `contractId`, which is part of the
 * fan-out's dedup key, so all of them survive dedup and reach the cap.
 */
const contractVariantRow = (i: number) => ({
  neighborRepo: repoKey(0),
  neighborUid: 'Function:src/handler.ts:handle',
  neighborFilePath: 'src/handler.ts',
  matchType: 'exact',
  confidence: 1,
  contractId: contractKey(i),
  contractType: 'custom',
});

/**
 * A boundary-only crossing: the far endpoint has no graph symbol, so its UID is
 * the synthetic `manifest::` form and no `impactByUid` is ever issued for it
 * (#2722 / #2784).
 */
const manifestRow = (i: number) => ({
  neighborRepo: repoKey(i),
  neighborUid: `manifest::${repoKey(i)}::custom::m${String(i).padStart(3, '0')}`,
  neighborFilePath: '',
  matchType: 'manifest',
  confidence: 1,
  contractId: `custom::m${String(i).padStart(3, '0')}`,
  contractType: 'custom',
});

type CrossEntry = {
  repo_path: string;
  contract: { id: string; match_type?: string };
  fanout_status?: string;
};

/** No `?? []` fallback on purpose: an `{ error }` result must blow up here. */
const crossOf = (result: unknown): CrossEntry[] => (result as { cross: CrossEntry[] }).cross;

const fanoutUids = (port: GroupToolPort): string[] =>
  vi.mocked(port.impactByUid).mock.calls.map((call) => String(call[1]));

describe('group impact fan-out is bounded by a count, not by the clock (#2787)', () => {
  let home: string;
  const REPO_COUNT = MAX_NEIGHBOR_FANOUT + 2;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-fanout-cap-'));
    const groupDir = path.join(home, 'groups', 'waveful');
    await writeGroupYaml(groupDir, [
      'backend',
      ...Array.from({ length: REPO_COUNT }, (_, i) => repoKey(i)),
    ]);
    await fsp.writeFile(path.join(groupDir, 'bridge.lbug'), '');
    // The metadata this suite's `readBridgeMeta` mock hands back has to exist on
    // disk as well as in the mock. It carries no size/mtime stamp, so
    // `bridgeMetaMatchesFile` pairs it to the database by write order — and a
    // metadata file that is not there cannot be paired to anything. Written
    // AFTER `bridge.lbug`, which is the order a real sync produces.
    await fsp.writeFile(
      path.join(groupDir, 'meta.json'),
      JSON.stringify({ version: 1, generatedAt: '', missingRepos: [] }),
    );
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** The shared benign port, bound to this suite's per-test `home`. */
  const makePort = (overrides: Partial<GroupToolPort> = {}): GroupToolPort =>
    makeGroupToolPort(home, overrides);

  const run = (port: GroupToolPort, extraParams: Record<string, unknown> = {}) =>
    runGroupImpact(
      { port, gitnexusDir: home },
      {
        name: 'waveful',
        repo: 'backend',
        target: 'publish',
        direction: 'upstream',
        ...extraParams,
      },
    );

  it('attempts at most MAX_NEIGHBOR_FANOUT crossings and names the ones it dropped', async () => {
    bridgeRows.value = Array.from({ length: REPO_COUNT }, (_, i) => crossingRow(i));
    const port = makePort();

    const result = await run(port);

    // Exactly the cap — never "however many fit in the remaining milliseconds".
    expect(vi.mocked(port.impactByUid).mock.calls).toHaveLength(MAX_NEIGHBOR_FANOUT);
    // WHICH two were dropped is the part a clock could never pin: the list is
    // confidence DESC then repo then uid, so the last two keys lose, on any host.
    expect(result).toMatchObject({
      truncated: true,
      truncatedRepos: [repoKey(REPO_COUNT - 2), repoKey(REPO_COUNT - 1)],
      truncationReason: 'partial',
      riskEpistemic: 'lower-bound',
    });
  });

  it('walks every crossing and claims no floor when the set fits under the cap', async () => {
    bridgeRows.value = Array.from({ length: 3 }, (_, i) => crossingRow(i));
    const port = makePort();

    const result = await run(port);

    expect(vi.mocked(port.impactByUid).mock.calls).toHaveLength(3);
    expect(result).toMatchObject({ truncated: false, risk: 'CRITICAL' });
    expect(result).not.toHaveProperty('riskEpistemic');
  });

  it('marks risk as a floor when a crossing is dropped, and does NOT clamp the value down', async () => {
    // Three crossings, one neighbour unresolvable. Two traverse → HIGH (the
    // >=0.85-confidence gate). Had the third traversed, `traversed.length >= 3`
    // would have made it CRITICAL — that is the threshold a load-dependent
    // cutoff used to straddle silently.
    bridgeRows.value = Array.from({ length: 3 }, (_, i) => crossingRow(i));
    const port = makePort({
      resolveRepo: vi.fn(async (name: string) => {
        if (name === `${repoKey(2)}-registry`) throw new Error('repo not registered');
        return { id: name, name, repoPath: name, storagePath: path.join(home, name) };
      }) as GroupToolPort['resolveRepo'],
    });

    const result = await run(port);

    expect(result).toMatchObject({
      risk: 'HIGH',
      riskEpistemic: 'lower-bound',
      truncated: true,
      truncatedRepos: [repoKey(2)],
    });
  });

  it('issues fan-outs in a total order, so the cap keeps the same crossings every run', async () => {
    // Equal confidence on purpose: without the repo/uid tiebreak the surviving
    // set would be whatever order the bridge happened to return.
    bridgeRows.value = [crossingRow(4), crossingRow(1), crossingRow(3), crossingRow(2)];
    const port = makePort();

    await run(port);

    expect(vi.mocked(port.impactByUid).mock.calls.map((c) => c[1])).toEqual([
      crossingRow(1).neighborUid,
      crossingRow(2).neighborUid,
      crossingRow(3).neighborUid,
      crossingRow(4).neighborUid,
    ]);
  });

  it('sorts by confidence first, so the cap keeps the strongest crossings', async () => {
    bridgeRows.value = [crossingRow(0, 0.7), crossingRow(1, 1), crossingRow(2, 0.85)];
    const port = makePort();

    await run(port);

    expect(vi.mocked(port.impactByUid).mock.calls.map((c) => c[1])).toEqual([
      crossingRow(1).neighborUid,
      crossingRow(2).neighborUid,
      crossingRow(0).neighborUid,
    ]);
  });

  it('breaks ties on contractId, so bridge row order cannot pick the survivors', async () => {
    // Every other fixture in this file gives each crossing its own repo, so the
    // repo tiebreak decides and the contract tiebreak never fires. Here the
    // rows share confidence, repo AND uid — but `contractId` is part of the
    // fan-out's dedup key (`repo\0uid\0contractId`), so all of them survive
    // dedup and compete for the same MAX_NEIGHBOR_FANOUT slots. A comparator
    // that stops at (confidence, repo, uid) returns 0 for every pair, and a
    // stable sort then keeps raw bridge row order — which is precisely the
    // process-varying cutoff #2787 exists to remove. Two fixed permutations,
    // one expected survivor set: no randomness, no repeats.
    const ascending = Array.from({ length: MAX_NEIGHBOR_FANOUT + 2 }, (_, i) =>
      contractVariantRow(i),
    );
    const expectedSurvivors = Array.from({ length: MAX_NEIGHBOR_FANOUT }, (_, i) => contractKey(i));

    bridgeRows.value = ascending;
    const forward = await run(makePort());

    bridgeRows.value = [...ascending].reverse();
    const reversed = await run(makePort());

    expect(crossOf(forward).map((entry) => entry.contract.id)).toEqual(expectedSurvivors);
    expect(crossOf(reversed).map((entry) => entry.contract.id)).toEqual(expectedSurvivors);
    expect(forward).toMatchObject({ truncated: true, truncatedRepos: [repoKey(0)] });
    expect(reversed).toMatchObject({ truncated: true, truncatedRepos: [repoKey(0)] });
  });

  it('ranks the neighbour list by code unit, so the host ICU locale cannot reorder it', () => {
    // The tiebreaks the cap depends on used `localeCompare`, which resolves
    // against the host's default ICU locale — two machines can order the same
    // two repo names differently, which is the same process-varying cutoff the
    // clock bound was. Code-unit order is a property of the strings alone.
    expect(compareCodeUnits('Billing', 'auth')).toBeLessThan(0);
    expect(compareCodeUnits('auth', 'Billing')).toBeGreaterThan(0);
    expect(compareCodeUnits('auth', 'auth')).toBe(0);
  });

  it('still reports manifest-only crossings after real ones have spent the cap', async () => {
    // #2784: a manifest link proves the repository boundary even though its far
    // endpoint has no graph symbol. It costs no `impactByUid`, so the count cap
    // must not be allowed to drop it — the crossing would vanish from the
    // report while `group sync` kept listing it.
    bridgeRows.value = [
      ...Array.from({ length: MAX_NEIGHBOR_FANOUT + 1 }, (_, i) => crossingRow(i)),
      manifestRow(REPO_COUNT - 1),
    ];
    const port = makePort();

    const result = await run(port);

    expect(fanoutUids(port)).toHaveLength(MAX_NEIGHBOR_FANOUT);
    expect(
      crossOf(result).filter((entry) => entry.fanout_status === 'not_attempted'),
    ).toMatchObject([
      {
        repo_path: repoKey(REPO_COUNT - 1),
        contract: { id: manifestRow(REPO_COUNT - 1).contractId, match_type: 'manifest' },
      },
    ]);
    expect(result).toMatchObject({
      truncated: true,
      // Only the real crossing that lost its slot is named — the manifest repo
      // is not a dropped crossing.
      truncatedRepos: [repoKey(MAX_NEIGHBOR_FANOUT)],
      summary: { cross_repo_hits: MAX_NEIGHBOR_FANOUT + 1 },
    });
  });

  it('does not spend fan-out budget on manifest-only crossings', async () => {
    // Manifest crossings sort FIRST here (confidence 1 against the real
    // crossings' 0.9), so if they consumed a slot each the ten of them would
    // starve ten real neighbours out of the cap.
    const reals = Array.from({ length: MAX_NEIGHBOR_FANOUT + 1 }, (_, i) => crossingRow(i, 0.9));
    const manifests = Array.from({ length: 10 }, (_, i) => manifestRow(i));

    bridgeRows.value = [...manifests, ...reals];
    const mixedPort = makePort();
    const mixed = await run(mixedPort);

    bridgeRows.value = reals;
    const realsOnlyPort = makePort();
    const realsOnly = await run(realsOnlyPort);

    // Same fan-outs, in the same order, with and without the manifest rows.
    expect(fanoutUids(mixedPort)).toEqual(fanoutUids(realsOnlyPort));
    expect(fanoutUids(mixedPort)).toHaveLength(MAX_NEIGHBOR_FANOUT);
    expect(mixed).toMatchObject({
      truncatedRepos: [repoKey(MAX_NEIGHBOR_FANOUT)],
      summary: { cross_repo_hits: MAX_NEIGHBOR_FANOUT + manifests.length },
    });
    expect(realsOnly).toMatchObject({
      truncatedRepos: [repoKey(MAX_NEIGHBOR_FANOUT)],
      summary: { cross_repo_hits: MAX_NEIGHBOR_FANOUT },
    });
  });

  it('reports timeout, not the generic partial, when the fan-out clock is what stopped it', async () => {
    // The fan-out leg has its own two clock exits — a neighbour call that
    // outlives the remaining budget, and the deadline check that skips every
    // neighbour after it. Both must surface as `timeout`; only the LOCAL early
    // return was ever asserted before. A never-resolving `impactByUid` makes
    // the budget timer the only thing that can settle the race, so the branch
    // is taken on every host — nothing here measures elapsed time.
    bridgeRows.value = [crossingRow(0), crossingRow(1)];
    const port = makePort({
      impactByUid: vi.fn(() => new Promise<unknown>(() => {})) as GroupToolPort['impactByUid'],
    });

    const result = await run(port, { timeoutMs: 200 });

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'timeout',
      riskEpistemic: 'lower-bound',
      truncatedRepos: [repoKey(0), repoKey(1)],
      // Nothing traversed, so the reported risk is the bare local one — the
      // marker is the only thing telling a caller it is a floor.
      risk: 'LOW',
      cross: [],
    });
    // The second neighbour is never fanned out: whichever clock exit fired, the
    // budget was gone before it.
    expect(fanoutUids(port)).not.toContain(crossingRow(1).neighborUid);
  });

  it('marks the floor when the fan-out completed and only the local walk was partial', async () => {
    // `truncated` has two independent causes. This is the one with an empty
    // `truncatedRepos`: every bridge crossing was traversed, but the local
    // impact walk itself came back partial (most often the local chunk cap).
    // The CLI has to describe this case as "the local walk did not complete",
    // not "fan-out stopped early".
    bridgeRows.value = [crossingRow(0), crossingRow(1)];
    const port = makePort({
      impact: vi.fn(async () => ({
        target: { id: 'Function:src/api.ts:publish', filePath: 'src/api.ts' },
        byDepth: {},
        partial: true,
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        risk: 'LOW',
      })) as GroupToolPort['impact'],
    });

    const result = await run(port);

    expect(fanoutUids(port)).toHaveLength(2);
    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'partial',
      riskEpistemic: 'lower-bound',
      truncatedRepos: [],
      summary: { cross_repo_hits: 2 },
    });
  });
});
