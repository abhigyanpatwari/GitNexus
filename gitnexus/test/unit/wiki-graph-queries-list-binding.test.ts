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
 *
 * SCOPE — mock for shape, engine for semantics. A fake that answers on
 * `query.includes(...)` can pin what the query ASKS FOR; it cannot pin what
 * LadybugDB does with it, and pretending otherwise is how two bugs shipped past
 * a green suite on this branch (a `--` comment the engine rejects at PREPARE,
 * and an `ORDER BY` whose second key the engine drops). Anything that depends
 * on the engine's behavior is asserted in
 * `test/integration/wiki-graph-queries-engine.test.ts` instead. What stays here
 * is the query text, the parameter binding, and the row→object mapping.
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
import { CALL_EDGE_LIMIT } from '../../src/core/wiki/prompts.js';

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

/**
 * More intra-module edges than `CALL_EDGE_LIMIT` (30, imported from prompts.ts
 * — the one place that number lives), so the LIMIT the query carries actually
 * has something to cut. With the two hand-written edges below the intra arm
 * matches 42 rows; before these existed it matched 2, and no test could tell a
 * query that limits from one that doesn't.
 */
const BULK_EDGES: Edge[] = Array.from({ length: 40 }, (_, i) => ({
  fromFile: MODULE_FILES[i % 5],
  fromName: `bulk${String(i).padStart(2, '0')}`,
  toFile: MODULE_FILES[(i % 5) + 5],
  toName: 'sink',
}));

const EDGES: Edge[] = [
  // Inside the module, with the two ends far apart in the file list.
  { fromFile: DISTANT_CALLER, fromName: 'aFn', toFile: DISTANT_CALLEE, toName: 'zFn' },
  { fromFile: MODULE_FILES[1], fromName: 'bFn', toFile: MODULE_FILES[2], toName: 'cFn' },
  // A call whose callee has no filePath at all.
  { fromFile: MODULE_FILES[3], fromName: 'dFn', toFile: undefined, toName: 'unresolved' },
  // Genuinely leaving / entering the module.
  { fromFile: MODULE_FILES[4], fromName: 'outbound', toFile: OUTSIDE_A, toName: 'extFn' },
  { fromFile: OUTSIDE_B, fromName: 'extCaller', toFile: MODULE_FILES[6], toName: 'entryFn' },
  ...BULK_EDGES,
];

/**
 * `label`/`type` are nullable here because the columns are: a Process row can
 * carry a NULL `heuristicLabel` or an EMPTY one, and the two take different
 * paths through `toProcessHeader`. `??` falls back only for the NULL; the `||`
 * it replaced also swallowed the empty string and reported the process id in
 * its place.
 */
type ProcessFixture = {
  id: string;
  label: string | null;
  type: string | null;
  stepCount: number;
  files: string[];
};

const PROCESSES: ProcessFixture[] = [
  { id: 'p-top', label: 'Top', type: 'flow', stepCount: 99, files: [MODULE_FILES[FILE_COUNT - 1]] },
  { id: 'p-mid', label: 'Mid', type: 'flow', stepCount: 42, files: [MODULE_FILES[0]] },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `p-${String(i).padStart(2, '0')}`,
    label: `Flow ${i}`,
    type: 'flow',
    stepCount: i,
    files: [MODULE_FILES[i]],
  })),
  // Parked outside the module so the assertions above keep their exact
  // expectations; reached through `getProcessesForFiles([OUTSIDE_A])`.
  { id: 'p-null', label: null, type: null, stepCount: 2, files: [OUTSIDE_A] },
  { id: 'p-empty', label: '', type: '', stepCount: 1, files: [OUTSIDE_A] },
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
    .map((p) => ({ id: p.id, label: p.label, type: p.type, stepCount: p.stepCount }))
    .sort((a, b) => b.stepCount - a.stepCount || ordinal(a.id, b.id))
    .slice(0, limit);
}

/**
 * The seeded arrival order of each process's steps: 2, then 0, then 1.
 *
 * Deliberately NOT ascending, and deliberately including 0. The fake used to
 * hand back rows already sorted per pid, which is why this suite could see
 * neither the `ORDER BY pid, r.step` regression nor its fix — an assertion that
 * passes whatever the query says is worth nothing. The engine's actual sort is
 * pinned in test/integration/wiki-graph-queries-engine.test.ts; what a scrambled
 * fake pins HERE is that `withSteps` groups the rows without reordering them,
 * so the trace a wiki page prints is exactly the one the engine returned.
 */
const SEEDED_STEP_ORDER = [2, 0, 1];

/**
 * One row per (process, step), the shape the grouped step query returns.
 *
 * `type` is a plain label: what LadybugDB actually answers for a `labels(s)`
 * projection is the engine's business, and is pinned against a real engine in
 * test/integration/wiki-graph-queries-engine.test.ts. What is left here is the
 * row→object mapping.
 */
function answerProcessSteps(ids: string[]): QueryRow[] {
  return SEEDED_STEP_ORDER.flatMap((step) =>
    ids.map((pid) => ({
      pid,
      name: `${pid}-step${step}`,
      filePath: MODULE_FILES[step],
      type: 'Function',
      step,
    })),
  );
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

  it('asks the engine for the intra-module window too, not a JS sort', async () => {
    // This used to assert that the returned edges were sorted — which the JS
    // `.sort()` this replaced did, and which the 2-edge fixture satisfied either
    // way. The ordering now lives in Cypher, so the property worth pinning is
    // that the query carries it, exactly as for the inter-module sibling below.
    await getIntraModuleCallEdges(MODULE_FILES);

    const [call] = callEdgeQueries();
    expect(call.query).toContain('ORDER BY fromName, toName, fromFile, toFile');
    expect(call.query).toContain(`LIMIT ${CALL_EDGE_LIMIT}`);
  });

  it('returns the engine-cut window, without re-expanding it in JS', async () => {
    const edges = await getIntraModuleCallEdges(MODULE_FILES);

    // 42 edges match the intra arm; the query's LIMIT is the only reason 30
    // come back. `aFn` and `bFn` sort ahead of every `bulkNN`.
    expect(edges).toHaveLength(CALL_EDGE_LIMIT);
    expect(edges.map((e) => e.fromName)).toEqual([
      'aFn',
      'bFn',
      ...BULK_EDGES.slice(0, CALL_EDGE_LIMIT - 2).map((e) => e.fromName),
    ]);
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
      expect(call.query).toContain(`LIMIT ${CALL_EDGE_LIMIT}`);
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
    // Rows arrive interleaved across the three processes; each trace still goes
    // back to its OWN process — that is the grouping, and it is separate from
    // the ordering asserted below.
    expect(processes.map((p) => p.steps.map((s) => s.name))).toEqual([
      ['p-top-step2', 'p-top-step0', 'p-top-step1'],
      ['p-mid-step2', 'p-mid-step0', 'p-mid-step1'],
      ['p-11-step2', 'p-11-step0', 'p-11-step1'],
    ]);
  });

  it('delegates the step order to Cypher and reorders nothing in JS', async () => {
    const processes = await getProcessesForFiles(MODULE_FILES, 1);

    // The engine is asked to sort by `step` ALONE. Leading the sort with `pid` —
    // the same property the `IN` list matches on — makes LadybugDB drop the
    // second key and return insertion order; that shipped once, and every mocked
    // test passed. The real sort is exercised in
    // test/integration/wiki-graph-queries-engine.test.ts.
    const [stepQuery] = seen.filter((q) => q.query.includes('p.id IN $ids'));
    expect(stepQuery.query).toContain('ORDER BY step');
    expect(stepQuery.query).not.toContain('ORDER BY pid');

    // And the rows come out exactly as the engine handed them over: the fake
    // emits 2, 0, 1, so any JS re-sort added here would break this.
    expect(processes[0].steps.map((s) => s.step)).toEqual(SEEDED_STEP_ORDER);
  });

  it('reads the step number off its named column, including a genuine 0', async () => {
    const processes = await getProcessesForFiles(MODULE_FILES, 1);

    // A step genuinely numbered 0 keeps its own number — a falsy check on the
    // column would substitute an index or drop the step entirely. (What the
    // engine answers for the step's LABEL is asserted in
    // test/integration/wiki-graph-queries-engine.test.ts.)
    expect(processes[0].steps.map((s) => s.step)).toContain(0);
  });

  it('falls back for a null label but keeps an empty one', async () => {
    const processes = await getProcessesForFiles([OUTSIDE_A], 2);

    // `??`, not `||`. The NULL columns fall back to the id and 'unknown'; the
    // EMPTY ones are the process's own values and `||` silently replaced them.
    expect(processes.map((p) => ({ id: p.id, label: p.label, type: p.type }))).toEqual([
      { id: 'p-null', label: 'p-null', type: 'unknown' },
      { id: 'p-empty', label: '', type: '' },
    ]);
  });

  it('does not query at all for an empty file set', async () => {
    expect(await getIntraModuleCallEdges([])).toEqual([]);
    expect(await getInterModuleCallEdges([])).toEqual({ outgoing: [], incoming: [] });
    expect(await getProcessesForFiles([])).toEqual([]);
    expect(seen).toHaveLength(0);
  });
});
