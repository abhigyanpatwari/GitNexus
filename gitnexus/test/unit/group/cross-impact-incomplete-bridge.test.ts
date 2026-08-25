/**
 * A bridge built by a sync that could not account for every configured repo is
 * MISSING crossings, not free of them. Those repos' contracts — and every
 * cross-link touching them — never made it into `bridge.lbug`, and nothing in
 * the impact walk can notice: the only incompleteness channel on a
 * `GroupImpactResult` is `truncationFields(...)`, and that is driven purely by
 * fan-out state.
 *
 * The failure this file pins: `group impact` on a symbol whose one downstream
 * consumer lives in an unreadable repo returned `{ cross: [], truncated: false }`
 * — "complete: nothing depends on this". That is a wrong answer, not an empty
 * one, for the tool an agent uses to license a delete or a rename.
 *
 * `readBridgeMeta` is deliberately NOT stubbed here: the `meta.json` each case
 * writes is the input under test, so it has to travel the real read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeHandle, BridgeMeta } from '../../../src/core/group/types.js';
import type { GroupToolPort } from '../../../src/core/group/service.js';
import { BRIDGE_SCHEMA_VERSION } from '../../../src/core/group/bridge-schema.js';
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
    getCachedBridgeReadOnly: vi.fn(async () => bridgeHandle),
    queryBridge: vi.fn(async () => bridgeRows.value),
    closeBridgeDb: vi.fn(async () => undefined),
  };
});

const { runGroupImpact } = await import('../../../src/core/group/cross-impact.js');
const { writeBridgeMeta, closeBridgeDb } = await import('../../../src/core/group/bridge-db.js');

const UNREADABLE_REPO = 'svc/users';
const MISSING_REPO = 'svc/billing';

/** A crossing the fan-out will try to traverse. */
const crossingRow = {
  neighborRepo: 'svc/orders',
  neighborUid: 'Function:src/handler.ts:handle',
  neighborFilePath: 'src/handler.ts',
  matchType: 'exact',
  confidence: 1,
  contractId: 'custom::c000',
  contractType: 'custom',
};

type ImpactShape = {
  truncated: boolean;
  truncationReason?: string;
  riskEpistemic?: string;
  truncatedRepos: string[];
  cross: unknown[];
};

/** No `?? []` fallback on purpose: an `{ error }` result must blow up here. */
const shapeOf = (result: unknown): ImpactShape => result as ImpactShape;

const sortedRepos = (result: unknown): string[] => [...shapeOf(result).truncatedRepos].sort();

/** A port whose only defect is that one neighbour repo fails to resolve. */
const portWithUnresolvableNeighbour = (home: string, neighbourRepo: string): GroupToolPort =>
  makeGroupToolPort(home, {
    resolveRepo: vi.fn(async (name: string) => {
      if (name === `${neighbourRepo}-registry`) throw new Error('repo not registered');
      return { id: name, name, repoPath: name, storagePath: path.join(home, name) };
    }) as GroupToolPort['resolveRepo'],
  });

describe('group impact over a bridge built from an incomplete sync', () => {
  let home: string;
  let groupDir: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-incomplete-bridge-'));
    groupDir = path.join(home, 'groups', 'waveful');
    await writeGroupYaml(groupDir, ['backend', 'svc/orders', UNREADABLE_REPO, MISSING_REPO]);
    await fsp.writeFile(path.join(groupDir, 'bridge.lbug'), '');
    bridgeRows.value = [];
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeMeta = (meta: Omit<BridgeMeta, 'version' | 'generatedAt'>): Promise<void> =>
    writeBridgeMeta(groupDir, {
      version: BRIDGE_SCHEMA_VERSION,
      generatedAt: '2026-01-01T00:00:00.000Z',
      ...meta,
    });

  /**
   * meta.json exactly as given. `writeBridgeMeta` is typed, and the values
   * these cases are about are ones `BridgeMeta` forbids — which is precisely
   * why nothing on the read path was checking for them: a truncated write, a
   * hand-edit, or a foreign writer can still leave them on disk.
   */
  const writeRawMeta = (fields: Record<string, unknown>): Promise<void> =>
    fsp.writeFile(
      path.join(groupDir, 'meta.json'),
      JSON.stringify({
        version: BRIDGE_SCHEMA_VERSION,
        generatedAt: '2026-01-01T00:00:00.000Z',
        ...fields,
      }),
    );

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

  it('reports a repo the sync could not read as truncation, not as a clean empty result', async () => {
    // The headline case. Every other signal here says "complete": the local
    // walk finished, the bridge returned no crossings, no cap and no clock
    // fired. `unreadableRepos` in meta.json is the ONLY evidence that the
    // empty `cross` is a lower bound rather than a verdict.
    await writeMeta({ missingRepos: [], unreadableRepos: [UNREADABLE_REPO] });

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({
      cross: [],
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
    expect(sortedRepos(result)).toEqual([UNREADABLE_REPO]);
  });

  it('treats a repo with no registry entry the same way', async () => {
    // A MISSING repo is equally absent from the bridge — the sync had nothing
    // to extract from it, so its contracts are gone from every query against
    // this bridge for exactly the same reason.
    await writeMeta({ missingRepos: [MISSING_REPO] });

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
    expect(sortedRepos(result)).toEqual([MISSING_REPO]);
  });

  it('names each incomplete repo once when a repo is both unreadable and missing', async () => {
    // The two lists are independent diagnostics and can overlap. A caller
    // reading `truncatedRepos` as "the repos I could not see" must not be
    // handed the same one twice.
    await writeMeta({ missingRepos: [MISSING_REPO], unreadableRepos: [MISSING_REPO] });

    const result = await run(makeGroupToolPort(home));

    expect(sortedRepos(result)).toEqual([MISSING_REPO]);
  });

  it('claims no floor when the bridge is complete and the walk finished', async () => {
    // The control that gives the cases above their meaning: a clean bridge and
    // a clean walk must still produce a result with NO truncation shape at all,
    // or `incomplete-sync` would just be the new name for every answer.
    await writeMeta({ missingRepos: [], unreadableRepos: [] });

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({ truncated: false, truncatedRepos: [] });
    expect(result).not.toHaveProperty('truncationReason');
    expect(result).not.toHaveProperty('riskEpistemic');
  });

  it('reports a bridge with no meta.json at all as a floor, not as complete', async () => {
    // `writeBridge` swaps the database file and writes meta.json as two steps,
    // so a sync interrupted between them leaves a NEW bridge with NO metadata.
    // `readBridgeMeta` answers `version: 0` for that (and for an unparseable
    // one), which carries no repo lists — so reading it as "complete" would
    // hand back a confident `{ cross: [], truncated: false }` about a bridge
    // whose provenance is unknown. That is the fail-open this channel exists
    // to close, arriving through the door the write path leaves open.
    await fsp.rm(path.join(groupDir, 'meta.json'), { force: true });

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
  });

  it('reports an unparseable meta.json as a floor too', async () => {
    await fsp.writeFile(path.join(groupDir, 'meta.json'), '{"version": ');

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({ truncated: true, truncationReason: 'incomplete-sync' });
  });

  it('answers a lower bound when the missing-repo list is an object, instead of throwing', async () => {
    // `runGroupImpact` spread both repo lists straight into a `new Set([...])`.
    // A non-iterable value there is a TypeError thrown out of the whole query —
    // an operator asking about their blast radius gets a stack trace instead of
    // the honest "this bridge's provenance is unreadable, treat the answer as a
    // floor" that the very same metadata already licenses.
    await writeRawMeta({ missingRepos: { 'svc/users': true } });

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
    // Nothing was measured, so nothing is named. The reason field carries the
    // signal; inventing repo names out of an unreadable value would not.
    expect(shapeOf(result).truncatedRepos).toEqual([]);
  });

  it('answers a lower bound when the unreadable-repo list is a number', async () => {
    // The other list, and a non-iterable of a different kind — a scalar reaches
    // the same spread. `missingRepos` here IS well formed and measured empty,
    // which is what makes this case about the second list alone.
    await writeRawMeta({ missingRepos: [], unreadableRepos: 3 });

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
    expect(shapeOf(result).truncatedRepos).toEqual([]);
  });

  it('does not report the entries of a list that is not a list of repo paths', async () => {
    // `Array.isArray` alone would pass this: it is an array, and it is even
    // partly right. But `truncatedRepos` is printed by `cli/group.ts` with
    // `.join(', ')`, so the object entry surfaces to an operator as
    // `[object Object]` — a repo name that does not exist, presented as a
    // measurement. A value we cannot read is not a value we half-report.
    await writeRawMeta({ missingRepos: [MISSING_REPO, { repo: UNREADABLE_REPO }] });

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
    expect(shapeOf(result).truncatedRepos).toEqual([]);
  });

  it('releases the bridge handle on a malformed meta.json, and answers the next query normally', async () => {
    // The throw happened AFTER the read-only bridge lease was taken and BEFORE
    // the `try` whose `finally` releases it, so every malformed-metadata query
    // burned a refcount that is never given back — the cached handle can then
    // never be closed or invalidated, and `group sync` cannot swap the database
    // underneath it on Windows. Releasing is not a detail of the fix: it is why
    // a second query on the same group still gets an answer.
    vi.mocked(closeBridgeDb).mockClear();
    await writeRawMeta({ missingRepos: {} });

    await run(makeGroupToolPort(home));

    expect(vi.mocked(closeBridgeDb).mock.calls.length).toBe(1);

    await writeMeta({ missingRepos: [], unreadableRepos: [] });
    const second = await run(makeGroupToolPort(home));

    expect(second).toMatchObject({ truncated: false, truncatedRepos: [] });
    expect(vi.mocked(closeBridgeDb).mock.calls.length).toBe(2);
  });

  it('reports a meta.json that is not an object at all as a floor, not as a crash', async () => {
    // `JSON.parse('null')` succeeds, so the parse guard never fires and the
    // cast hands `null` to a `.version` read. Same class as the two lists: a
    // successfully-parsed file whose SHAPE is not metadata.
    await fsp.writeFile(path.join(groupDir, 'meta.json'), 'null');

    const result = await run(makeGroupToolPort(home));

    expect(result).toMatchObject({ truncated: true, truncationReason: 'incomplete-sync' });
  });

  it('does not read a meta.json written before the field existed as incomplete', async () => {
    // Back-compat: `unreadableRepos` is optional, and a bridge written by an
    // older build simply does not record it. Absence must not be read as "some
    // repo was unreadable" — that would mark every pre-existing bridge as a
    // lower bound and make the marker meaningless.
    await writeMeta({ missingRepos: [] });
    const onDisk: unknown = JSON.parse(
      await fsp.readFile(path.join(groupDir, 'meta.json'), 'utf-8'),
    );

    const result = await run(makeGroupToolPort(home));

    expect(onDisk).not.toHaveProperty('unreadableRepos');
    expect(result).toMatchObject({ truncated: false, truncatedRepos: [] });
    expect(result).not.toHaveProperty('truncationReason');
  });

  it('keeps reporting timeout when the fan-out clock fired and the bridge is also incomplete', async () => {
    // Both causes at once. `timeout` is the retryable one — the same query can
    // succeed on the next run — while `incomplete-sync` needs a different
    // remedy (`gitnexus group sync`). The caller is told the cause it can act
    // on first, and the unreadable repo still shows up in `truncatedRepos`.
    // A never-resolving `impactByUid` makes the budget timer the only thing
    // that can settle the race, so this branch is taken on every host; nothing
    // here measures elapsed time.
    await writeMeta({ missingRepos: [], unreadableRepos: [UNREADABLE_REPO] });
    bridgeRows.value = [crossingRow];
    const port = makeGroupToolPort(home, {
      impactByUid: vi.fn(() => new Promise<unknown>(() => {})) as GroupToolPort['impactByUid'],
    });

    const result = await run(port, { timeoutMs: 200 });

    expect(result).toMatchObject({
      truncated: true,
      truncationReason: 'timeout',
      riskEpistemic: 'lower-bound',
    });
    expect(sortedRepos(result)).toEqual([crossingRow.neighborRepo, UNREADABLE_REPO].sort());
  });

  it('keeps reporting partial when the fan-out cut a crossing and the bridge is also incomplete', async () => {
    // Same precedence rule for the other runtime limit: a crossing that could
    // not be traversed (its repo does not resolve) is `partial`, and the
    // structural cause does not get to overwrite it.
    await writeMeta({ missingRepos: [], unreadableRepos: [UNREADABLE_REPO] });
    bridgeRows.value = [crossingRow];
    const port = portWithUnresolvableNeighbour(home, crossingRow.neighborRepo);

    const result = await run(port);

    expect(result).toMatchObject({ truncated: true, truncationReason: 'partial' });
    expect(sortedRepos(result)).toEqual([crossingRow.neighborRepo, UNREADABLE_REPO].sort());
  });
});
