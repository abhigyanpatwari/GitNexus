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

const { runGroupImpact, MAX_NEIGHBOR_FANOUT } =
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

describe('group impact fan-out is bounded by a count, not by the clock (#2787)', () => {
  let home: string;
  const REPO_COUNT = MAX_NEIGHBOR_FANOUT + 2;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-fanout-cap-'));
    const groupDir = path.join(home, 'groups', 'waveful');
    await fsp.mkdir(groupDir, { recursive: true });
    const repoLines = ['  backend: backend-registry']
      .concat(
        Array.from({ length: REPO_COUNT }, (_, i) => `  ${repoKey(i)}: ${repoKey(i)}-registry`),
      )
      .join('\n');
    await fsp.writeFile(
      path.join(groupDir, 'group.yaml'),
      `version: 1
name: waveful
description: ""
repos:
${repoLines}
links: []
packages: {}
detect:
  http: false
  grpc: false
  thrift: false
  topics: false
  shared_libs: false
  embedding_fallback: false
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
      'utf8',
    );
    await fsp.writeFile(path.join(groupDir, 'bridge.lbug'), '');
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makePort(overrides: Partial<GroupToolPort> = {}): GroupToolPort {
    return {
      resolveRepo: vi.fn(async (name: string) => ({
        id: name,
        name,
        repoPath: name,
        storagePath: path.join(home, name),
      })),
      impact: vi.fn(async () => ({
        target: { id: 'Function:src/api.ts:publish', filePath: 'src/api.ts' },
        byDepth: {},
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        risk: 'LOW',
      })),
      impactByUid: vi.fn(async () => ({
        byDepth: {},
        summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
        risk: 'LOW',
      })),
      query: vi.fn(),
      context: vi.fn(),
      ...overrides,
    } as GroupToolPort;
  }

  const run = (port: GroupToolPort) =>
    runGroupImpact(
      { port, gitnexusDir: home },
      { name: 'waveful', repo: 'backend', target: 'publish', direction: 'upstream' },
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
});
