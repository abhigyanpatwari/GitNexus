/**
 * A cross-repo TRACE reads the same bridge `group impact` reads, and inherits
 * the same failure: a bridge built by a sync that could not account for every
 * configured repo is MISSING crossings, not free of them. `stitchCrossRepo`
 * answered `status: 'not_found'` — "no ContractLink connects these endpoints" —
 * for a bridge that never held the endpoint repo's contracts at all, and the
 * only difference between that answer and an authoritative one was prose in
 * `notes`.
 *
 * What this file pins is the MACHINE-readable difference: the same structured
 * triple `truncated` / `truncationReason` / `riskEpistemic` that
 * `GroupImpactResult` carries, computed for the trace by the SAME helper
 * (`crossRepoCompleteness`), so an agent reading either surface learns
 * "complete" vs "floor" from one vocabulary instead of from two note strings.
 *
 * The other half is scope: the incomplete-repo set is filtered by what the
 * QUERY declared, not by what the walk happened to touch. A trace between two
 * healthy repos is not a lower bound because some third repo in the group was
 * unreadable — but a DESTINATION trace, which declares no `to` at all, has
 * every repo in scope by construction.
 *
 * `readBridgeMeta` is deliberately NOT stubbed: the `meta.json` each case
 * writes is the input under test, so it has to travel the real read. Only the
 * bridge DATABASE is mocked, which is what keeps every case here running
 * identically on every platform — nothing reopens an lbug file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeHandle, BridgeMeta } from '../../../src/core/group/types.js';
import type { GroupSymbolResolution, GroupToolPort } from '../../../src/core/group/service.js';
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

const { runGroupTrace } = await import('../../../src/core/group/cross-trace.js');
const { writeBridgeMeta } = await import('../../../src/core/group/bridge-db.js');

const FROM_REPO = 'app/frontend';
const TO_REPO = 'app/backend';
/** A third member, on no traced path — the scope filter's whole subject. */
const OFF_PATH_REPO = 'svc/users';

const FROM_UID = 'fe::callUsers';
const TO_UID = 'be::getUsers';

const okSym = (id: string, name: string, filePath: string): GroupSymbolResolution => ({
  kind: 'ok',
  symbol: { id, name, type: 'Function', filePath, startLine: 10, endLine: 14 },
});

/** Keyed on `<registryName>:<queried name>` — if-free dispatch, no branching. */
const SYMBOLS: Record<string, GroupSymbolResolution> = {
  [`${FROM_REPO}-registry:callUsers`]: okSym(FROM_UID, 'callUsers', 'src/api.ts'),
  [`${TO_REPO}-registry:getUsers`]: okSym(TO_UID, 'getUsers', 'src/routes.ts'),
};

const okTrace = (name: string, filePath: string): unknown => ({
  status: 'ok',
  from: { name, filePath, startLine: 10 },
  to: { name, filePath, startLine: 10 },
  hopCount: 1,
  hops: [{ name, filePath, startLine: 10 }],
  edges: [{ relType: 'CALLS', confidence: 1 }],
});

/** Both segments of the one crossing connect — the successful-trace cases. */
const CONNECTING_SEGMENTS: Record<string, unknown> = {
  [`${FROM_REPO}-registry:${FROM_UID}->consumer-uid`]: okTrace('callUsers', 'src/api.ts'),
  [`${TO_REPO}-registry:provider-uid->${TO_UID}`]: okTrace('getUsers', 'src/routes.ts'),
};

const crossingRow = (contractId: string): Record<string, unknown> => ({
  consumerUid: 'consumer-uid',
  providerUid: 'provider-uid',
  consumerFile: 'src/api.ts',
  providerFile: 'src/routes.ts',
  providerRepo: TO_REPO,
  providerName: 'getUsers',
  matchType: 'exact',
  confidence: 0.9,
  contractId,
  contractType: 'http',
});

type TraceShape = {
  status: string;
  notes: string[];
  truncated?: boolean;
  truncationReason?: string;
  riskEpistemic?: string;
  truncatedRepos?: string[];
};

/** No `?? {}` fallback on purpose: an unexpected result must blow up here. */
const shapeOf = (result: unknown): TraceShape => result as TraceShape;

describe('cross-repo trace over a bridge built from an incomplete sync', () => {
  let home: string;
  let groupDir: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitnexus-trace-incomplete-'));
    groupDir = path.join(home, 'groups', 'waveful');
    await writeGroupYaml(groupDir, [FROM_REPO, TO_REPO, OFF_PATH_REPO]);
    // Written BEFORE meta.json so the unstamped pair reads as paired by write
    // order — otherwise every case here would be "provenance unknown" and the
    // scope cases could not be told apart from the control.
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

  const soundMeta = (): Promise<void> => writeMeta({ missingRepos: [], unreadableRepos: [] });

  const port = (segments: Record<string, unknown> = {}): GroupToolPort =>
    makeGroupToolPort(home, {
      resolveSymbol: vi.fn(
        async (repo, q) =>
          SYMBOLS[`${repo.name}:${q.name ?? q.uid ?? ''}`] ?? { kind: 'not_found' },
      ) as GroupToolPort['resolveSymbol'],
      trace: vi.fn(
        async (repo, params) =>
          segments[`${repo.name}:${params.from_uid}->${params.to_uid}`] ?? { status: 'no_path' },
      ) as GroupToolPort['trace'],
    });

  const run = (p: GroupToolPort, extraParams: Record<string, unknown> = {}): Promise<unknown> =>
    runGroupTrace(
      { port: p, gitnexusDir: home },
      { name: 'waveful', from: 'callUsers', to: 'getUsers', ...extraParams },
    );

  it('reports a not_found trace as a lower bound when an endpoint repo was never read', async () => {
    // The headline case. Every other signal says "complete": both endpoints
    // resolved, the bridge answered, no cap fired. `unreadableRepos` naming the
    // `to` repo is the ONLY evidence that "no ContractLink connects these
    // endpoints" is a floor — that repo's contracts are absent from this
    // bridge, so the link could not have been found even if it exists.
    await writeMeta({ missingRepos: [], unreadableRepos: [TO_REPO] });

    const result = shapeOf(await run(port()));

    expect(result).toMatchObject({
      status: 'not_found',
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
      truncatedRepos: [TO_REPO],
    });
  });

  it('reports a trace over a bridge with no provenance as a lower bound too', async () => {
    // `writeBridge` swaps the database and writes meta.json as two steps, so an
    // interrupted sync leaves a NEW bridge with NO metadata. `readBridgeMeta`
    // answers `version: 0`, which carries no repo lists at all — so nothing can
    // be named, and the reason field is the entire signal.
    await fsp.rm(path.join(groupDir, 'meta.json'), { force: true });

    const result = shapeOf(await run(port()));

    expect(result).toMatchObject({
      status: 'not_found',
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
    // Nothing was measured, so nothing is named — inventing repo names out of
    // an unreadable value would not be a measurement.
    expect(result).not.toHaveProperty('truncatedRepos');
  });

  it('marks a SUCCESSFUL trace over a bridge with no provenance', async () => {
    // A found path is still an answer from a bridge that may not describe the
    // database beside it: other crossings may be missing and this one may be
    // stale. The fields ride on `status: 'ok'` for exactly that reason — an
    // incompleteness channel that only fires on the empty answer teaches an
    // agent that a non-empty answer is always complete.
    await fsp.rm(path.join(groupDir, 'meta.json'), { force: true });
    bridgeRows.value = [crossingRow('http::GET::/api/users')];

    const result = shapeOf(await run(port(CONNECTING_SEGMENTS)));

    expect(result).toMatchObject({
      status: 'ok',
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
    });
  });

  it('does not mark a trace whose endpoints exclude the unreadable repo', async () => {
    // R7: the incomplete set is filtered by the query's DECLARED scope. A
    // third member being unreadable says nothing about whether frontend
    // reaches backend — marking it would make every answer in a group with one
    // sick repo a lower bound, which is how a floor marker stops meaning
    // anything.
    await writeMeta({ missingRepos: [], unreadableRepos: [OFF_PATH_REPO] });

    const result = shapeOf(await run(port()));

    expect(result.status).toBe('not_found');
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('truncationReason');
    expect(result).not.toHaveProperty('riskEpistemic');
    expect(result).not.toHaveProperty('truncatedRepos');
  });

  it('claims no floor when the bridge is sound', async () => {
    // The control that gives the cases above their meaning.
    await soundMeta();

    const result = shapeOf(await run(port()));

    expect(result.status).toBe('not_found');
    expect(result).not.toHaveProperty('truncated');
    expect(result).not.toHaveProperty('truncationReason');
    expect(result).not.toHaveProperty('riskEpistemic');
  });

  it('distinguishes the two not_found answers without string-matching a note', async () => {
    // The verification this unit exists for. Both runs produce the SAME prose;
    // the structured field is the only thing that separates "no path exists"
    // from "we could not have seen the path".
    await writeMeta({ missingRepos: [], unreadableRepos: [TO_REPO] });
    const overIncomplete = shapeOf(await run(port()));
    await soundMeta();
    const overSound = shapeOf(await run(port()));

    expect(overIncomplete.notes).toEqual(overSound.notes);
    expect(overIncomplete.truncationReason).toBe('incomplete-sync');
    expect(overSound.truncationReason).toBeUndefined();
  });

  it('has every repo in scope for a destination trace, which declares no `to`', async () => {
    // A destination trace asks "where does this call land?" — the answer may be
    // in ANY member, so no repo can be filtered out of the incomplete set. An
    // unreadable provider repo is precisely how "no outgoing ContractLink
    // leaves this repo" becomes a wrong answer rather than an empty one.
    await writeMeta({ missingRepos: [], unreadableRepos: [OFF_PATH_REPO] });

    const result = shapeOf(await run(port(), { to: undefined }));

    expect(result).toMatchObject({
      status: 'not_found',
      truncated: true,
      truncationReason: 'incomplete-sync',
      riskEpistemic: 'lower-bound',
      truncatedRepos: [OFF_PATH_REPO],
    });
  });

  it('keeps reporting the crossing cap when the bridge is also incomplete', async () => {
    // Precedence mirrors `runGroupImpact`: the runtime limit is the one the
    // caller can act on (narrow the query), while 'incomplete-sync' needs a
    // different remedy (`gitnexus group sync`). The unreadable repo is still
    // named.
    await writeMeta({ missingRepos: [], unreadableRepos: [TO_REPO] });
    bridgeRows.value = Array.from({ length: 51 }, (_, i) =>
      crossingRow(`http::GET::/api/users/${i}`),
    );

    const result = shapeOf(await run(port()));

    expect(result).toMatchObject({
      status: 'not_found',
      truncated: true,
      truncationReason: 'partial',
      riskEpistemic: 'lower-bound',
      truncatedRepos: [TO_REPO],
    });
  });
});
