/**
 * #2915 — the wiki's graph queries must not scale their TEXT with the module.
 *
 * `getIntraModuleCallEdges`, `getInterModuleCallEdges` and `getProcessesForFiles`
 * each interpolated one `IN [...]` literal holding every file of the module —
 * caller-sized, and for a parent page that is most of the repo. That is the
 * unbounded-expression shape that overflowed LadybugDB's recursive evaluator
 * copy (see `coalesceHunks` in src/storage/git.ts).
 *
 * They now bind the list as a parameter, so the text is identical for 1 file and
 * for 250, and every predicate stays in Cypher where the engine can evaluate it
 * — including the `NOT ... IN` arms, whose null handling (`NOT null IN [...]` is
 * null, so a callee with no filePath is dropped) a JS membership test would get
 * wrong.
 *
 * The fake engine below answers from the bound parameters, so these tests fail
 * if a list ever goes back into the query text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeQueryMock, executeParameterizedMock } = vi.hoisted(() => ({
  executeQueryMock: vi.fn(),
  executeParameterizedMock: vi.fn(),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  touchRepo: vi.fn(),
  pinRepo: vi.fn(() => () => {}),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
  executeParameterized: (...args: unknown[]) => executeParameterizedMock(...args),
}));

import {
  getIntraModuleCallEdges,
  getInterModuleCallEdges,
  getProcessesForFiles,
} from '../../src/core/wiki/graph-queries.js';

// ─── Fixture ──────────────────────────────────────────────────────────────

/** Far more files than any batch size the old code used. */
const FILE_COUNT = 250;
const MODULE_FILES = Array.from(
  { length: FILE_COUNT },
  (_, i) => `src/mod/f${String(i).padStart(3, '0')}.ts`,
);
const OUTSIDE_A = 'src/other/a.ts';
const OUTSIDE_B = 'src/other/b.ts';

/** A callee with no `filePath` — the row a `NOT x IN [...]` null drops. */
type Edge = { fromFile: string; fromName: string; toFile?: string; toName: string };

const DISTANT_CALLER = MODULE_FILES[0];
const DISTANT_CALLEE = MODULE_FILES[FILE_COUNT - 10];

const EDGES: Edge[] = [
  // Inside the module, with the two ends far apart in the file list.
  { fromFile: DISTANT_CALLER, fromName: 'aFn', toFile: DISTANT_CALLEE, toName: 'zFn' },
  { fromFile: MODULE_FILES[1], fromName: 'bFn', toFile: MODULE_FILES[2], toName: 'cFn' },
  // A call whose callee has no filePath at all.
  { fromFile: MODULE_FILES[3], fromName: 'dFn', toFile: undefined, toName: 'unresolved' },
  // Genuinely leaving / entering the module.
  { fromFile: MODULE_FILES[4], fromName: 'outbound', toFile: OUTSIDE_A, toName: 'extFn' },
  { fromFile: OUTSIDE_B, fromName: 'extCaller', toFile: MODULE_FILES[6], toName: 'entryFn' },
];

type ProcessFixture = { id: string; label: string; stepCount: number; files: string[] };

const PROCESSES: ProcessFixture[] = [
  { id: 'p-top', label: 'Top', stepCount: 99, files: [MODULE_FILES[FILE_COUNT - 1]] },
  { id: 'p-mid', label: 'Mid', stepCount: 42, files: [MODULE_FILES[0]] },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `p-${String(i).padStart(2, '0')}`,
    label: `Flow ${i}`,
    stepCount: i,
    files: [MODULE_FILES[i]],
  })),
];

// ─── Fake engine, answering from the BOUND parameters ─────────────────────

type QueryRow = Record<string, unknown>;
type SeenQuery = { query: string; params: Record<string, unknown> };

const seen: SeenQuery[] = [];

/** Codepoint order, matching the queries' collation without ICU's help. */
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const inList = (value: string | undefined, list: string[]): boolean =>
  value !== undefined && list.includes(value);

/** `NOT null IN [...]` is null, and a null WHERE never keeps its row. */
const notInList = (value: string | undefined, list: string[]): boolean =>
  value !== undefined && !list.includes(value);

function answerCallEdges(query: string, paths: string[]): QueryRow[] {
  const matched = query.includes('WHERE NOT a.filePath IN $paths')
    ? EDGES.filter((e) => notInList(e.fromFile, paths) && inList(e.toFile, paths))
    : query.includes('AND NOT b.filePath IN $paths')
      ? EDGES.filter((e) => inList(e.fromFile, paths) && notInList(e.toFile, paths))
      : EDGES.filter((e) => inList(e.fromFile, paths) && inList(e.toFile, paths));

  const ordered = query.includes('ORDER BY fromName')
    ? [...matched].sort(
        (a, b) =>
          ordinal(a.fromName, b.fromName) ||
          ordinal(a.toName, b.toName) ||
          ordinal(a.fromFile, b.fromFile) ||
          ordinal(a.toFile ?? '', b.toFile ?? ''),
      )
    : matched;
  const limit = Number(/LIMIT (\d+)/.exec(query)?.[1] ?? ordered.length);
  return ordered.slice(0, limit).map((e) => ({ ...e }));
}

function answerProcessHeaders(query: string, paths: string[]): QueryRow[] {
  const limit = Number(/LIMIT (\d+)/.exec(query)?.[1]);
  return PROCESSES.filter((p) => p.files.some((f) => paths.includes(f)))
    .map((p) => ({ id: p.id, label: p.label, type: 'flow', stepCount: p.stepCount }))
    .sort((a, b) => b.stepCount - a.stepCount || ordinal(a.id, b.id))
    .slice(0, limit);
}

/** One row per (process, step), the shape the grouped step query returns. */
function answerProcessSteps(ids: string[]): QueryRow[] {
  return ids.flatMap((pid) => [
    { pid, name: `${pid}-step1`, filePath: MODULE_FILES[0], type: 'Function', step: 1 },
    { pid, name: `${pid}-step2`, filePath: MODULE_FILES[1], type: 'Function', step: 2 },
  ]);
}

beforeEach(() => {
  seen.length = 0;
  executeParameterizedMock.mockReset();
  executeParameterizedMock.mockImplementation(
    async (_repo: string, query: string, params: Record<string, unknown>) => {
      seen.push({ query, params });
      if (query.includes('p.id IN $ids')) return answerProcessSteps(params.ids as string[]);
      const paths = (params.paths ?? []) as string[];
      if (query.includes('STEP_IN_PROCESS')) return answerProcessHeaders(query, paths);
      return answerCallEdges(query, paths);
    },
  );
});

const callEdgeQueries = (): SeenQuery[] => seen.filter((q) => q.query.includes("type: 'CALLS'"));

describe('#2915 wiki graph queries bind their file list', () => {
  it('sends one query whose text does not carry the file list', async () => {
    await getIntraModuleCallEdges(MODULE_FILES);

    const calls = callEdgeQueries();
    expect(calls).toHaveLength(1);
    // The crash shape: every path spliced into the query text.
    expect(calls[0].query).not.toContain(MODULE_FILES[0]);
    expect(calls[0].query).toContain('IN $paths');
    expect(calls[0].params.paths).toEqual(MODULE_FILES);
  });

  it('sends the same query text for 250 files as for 1', async () => {
    await getIntraModuleCallEdges(MODULE_FILES);
    const wide = callEdgeQueries()[0].query;

    seen.length = 0;
    await getIntraModuleCallEdges([MODULE_FILES[0]]);

    expect(callEdgeQueries()[0].query).toBe(wide);
  });

  it('keeps both membership arms in Cypher, so a distant intra-module call is kept', async () => {
    const edges = await getIntraModuleCallEdges(MODULE_FILES);

    expect(edges).toContainEqual({
      fromFile: DISTANT_CALLER,
      fromName: 'aFn',
      toFile: DISTANT_CALLEE,
      toName: 'zFn',
    });
    // Leaves the module — the callee arm must exclude it.
    expect(edges.map((e) => e.toFile)).not.toContain(OUTSIDE_A);
  });

  it('returns intra-module edges in a host-independent order', async () => {
    const edges = await getIntraModuleCallEdges(MODULE_FILES);

    expect(edges.map((e) => e.fromName)).toEqual([...edges.map((e) => e.fromName)].sort());
  });

  it('drops a callee with no filePath from the outgoing arm, as `NOT null IN` does', async () => {
    const { outgoing } = await getInterModuleCallEdges(MODULE_FILES);

    expect(outgoing.map((e) => e.toName)).not.toContain('unresolved');
    expect(outgoing.map((e) => e.toName)).toContain('extFn');
  });

  it('asks the engine for the ordered window instead of re-deriving it in JS', async () => {
    await getInterModuleCallEdges(MODULE_FILES);

    const calls = callEdgeQueries();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.query).toContain('ORDER BY fromName, toName, fromFile, toFile');
      expect(call.query).toContain('LIMIT 30');
      expect(call.params.paths).toEqual(MODULE_FILES);
    }
  });

  it('separates incoming from outgoing by which arm is negated', async () => {
    const { incoming } = await getInterModuleCallEdges(MODULE_FILES);

    expect(incoming).toEqual([
      { fromFile: OUTSIDE_B, fromName: 'extCaller', toFile: MODULE_FILES[6], toName: 'entryFn' },
    ]);
  });

  it('applies the process LIMIT once, over the whole file set', async () => {
    const processes = await getProcessesForFiles(MODULE_FILES, 3);

    const headerQueries = seen.filter((q) => q.query.includes('s.filePath IN $paths'));
    expect(headerQueries).toHaveLength(1);
    expect(processes.map((p) => p.id)).toEqual(['p-top', 'p-mid', 'p-11']);
  });

  it('fetches every process trace in one grouped query', async () => {
    const processes = await getProcessesForFiles(MODULE_FILES, 3);

    const stepQueries = seen.filter((q) => q.query.includes('p.id IN $ids'));
    expect(stepQueries).toHaveLength(1);
    expect(stepQueries[0].params.ids).toEqual(['p-top', 'p-mid', 'p-11']);
    // Each trace goes back to its own process, in step order.
    expect(processes.map((p) => p.steps.map((s) => s.name))).toEqual([
      ['p-top-step1', 'p-top-step2'],
      ['p-mid-step1', 'p-mid-step2'],
      ['p-11-step1', 'p-11-step2'],
    ]);
  });

  it('does not query at all for an empty file set', async () => {
    expect(await getIntraModuleCallEdges([])).toEqual([]);
    expect(await getInterModuleCallEdges([])).toEqual({ outgoing: [], incoming: [] });
    expect(await getProcessesForFiles([])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});
