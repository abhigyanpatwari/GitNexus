/**
 * #2915 — the wiki's graph queries must not scale their text with the module.
 *
 * `getIntraModuleCallEdges`, `getInterModuleCallEdges` and `getProcessesForFiles`
 * each interpolated one `IN [...]` literal holding every file of the module —
 * caller-sized, and for a parent page that is most of the repo. That is the
 * same unbounded-expression shape that overflowed LadybugDB's recursive
 * evaluator copy in `detect_changes`.
 *
 * The queries now run once per batch of file paths, which is only safe if the
 * merge in JS reproduces the single query exactly. These tests answer the
 * queries with a fake engine over a fixed edge fixture and compare the batched
 * result against the pre-#2915 single-query text answered by the same engine,
 * so an oracle — not a restated expectation — decides what "unchanged" means.
 *
 * The dangerous case has its own tests: the inter-module queries mix membership
 * with NON-membership, and a naive per-batch split would report a call from
 * batch 0 to batch 2 — squarely inside the module — as leaving it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeQueryMock } = vi.hoisted(() => ({ executeQueryMock: vi.fn() }));

vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  touchRepo: vi.fn(),
  pinRepo: vi.fn(() => () => {}),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));

import {
  getIntraModuleCallEdges,
  getInterModuleCallEdges,
  getProcessesForFiles,
  type CallEdge,
} from '../../src/core/wiki/graph-queries.js';
import { LBUG_QUERY_BATCH_SIZE } from '../../src/core/lbug/query-batch.js';

// ─── Fixture ──────────────────────────────────────────────────────────────

/** Two full batches plus a partial one, so batch boundaries are exercised. */
const FILE_COUNT = LBUG_QUERY_BATCH_SIZE * 2 + 50;
const EXPECTED_BATCHES = 3;
const MODULE_FILES = Array.from(
  { length: FILE_COUNT },
  (_, i) => `src/mod/f${String(i).padStart(3, '0')}.ts`,
);
const OUTSIDE_A = 'src/other/a.ts';
const OUTSIDE_B = 'src/other/b.ts';

/** A callee with no `filePath` — the row a `NOT x IN [...]` null drops. */
type Edge = { fromFile: string; fromName: string; toFile?: string; toName: string };

const CROSS_BATCH_CALLER = MODULE_FILES[0];
const CROSS_BATCH_CALLEE = MODULE_FILES[LBUG_QUERY_BATCH_SIZE * 2 + 10];

const EDGES: Edge[] = [
  // Inside the module, but the two ends land in different batches.
  { fromFile: CROSS_BATCH_CALLER, fromName: 'aFn', toFile: CROSS_BATCH_CALLEE, toName: 'zFn' },
  { fromFile: CROSS_BATCH_CALLEE, fromName: 'zFn', toFile: MODULE_FILES[5], toName: 'eFn' },
  // Inside the module and inside one batch.
  { fromFile: MODULE_FILES[1], fromName: 'bFn', toFile: MODULE_FILES[2], toName: 'cFn' },
  // A call whose callee has no filePath at all.
  { fromFile: MODULE_FILES[3], fromName: 'dFn', toFile: undefined, toName: 'unresolved' },
  // Genuinely leaving / entering the module.
  { fromFile: MODULE_FILES[4], fromName: 'inbound', toFile: OUTSIDE_A, toName: 'extFn' },
  { fromFile: OUTSIDE_B, fromName: 'extCaller', toFile: MODULE_FILES[6], toName: 'entryFn' },
  // Enough outgoing edges to make the 30-row window a global choice: the
  // multiplier interleaves the sort order across all three batches.
  ...MODULE_FILES.map((file, i) => ({
    fromFile: file,
    fromName: `call${String((i * 7) % FILE_COUNT).padStart(3, '0')}`,
    toFile: OUTSIDE_A,
    toName: `sink${String(i % 3)}`,
  })),
];

type ProcessFixture = {
  id: string;
  label: string;
  type: string;
  stepCount: number;
  files: string[];
};

/** `top` is only reachable from the last batch; `shared` from two batches. */
const PROCESSES: ProcessFixture[] = [
  { id: 'p-top', label: 'Top', type: 'flow', stepCount: 99, files: [MODULE_FILES[FILE_COUNT - 1]] },
  {
    id: 'p-shared',
    label: 'Shared',
    type: 'flow',
    stepCount: 42,
    files: [MODULE_FILES[0], MODULE_FILES[LBUG_QUERY_BATCH_SIZE * 2 + 1]],
  },
  ...Array.from({ length: 12 }, (_, i) => ({
    id: `p-${String(i).padStart(2, '0')}`,
    label: `Flow ${i}`,
    type: 'flow',
    stepCount: i,
    files: [MODULE_FILES[i]],
  })),
];

// ─── Fake engine ──────────────────────────────────────────────────────────

type QueryRow = Record<string, unknown>;

/** Codepoint order, matching the queries' collation without ICU's help. */
const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The quoted paths of every `IN [...]` literal in a query, in order. */
function listLiterals(query: string): string[][] {
  return [...query.matchAll(/IN \[([^\]]*)\]/g)].map((match) =>
    match[1].length === 0 ? [] : match[1].split(', ').map((token) => token.slice(1, -1)),
  );
}

const inList = (value: string | undefined, list: string[]): boolean =>
  value !== undefined && list.includes(value);

/** `NOT null IN [...]` is null, and a null WHERE never keeps its row. */
const notInList = (value: string | undefined, list: string[]): boolean =>
  value !== undefined && !list.includes(value);

/** Answers all four CALLS shapes — the three batched ones and the legacy one. */
function answerCallEdgeQuery(query: string): QueryRow[] {
  const [first, second = []] = listLiterals(query);
  const matched = query.includes('WHERE NOT a.filePath IN')
    ? EDGES.filter((e) => notInList(e.fromFile, first) && inList(e.toFile, second))
    : query.includes('AND NOT b.filePath IN')
      ? EDGES.filter((e) => inList(e.fromFile, first) && notInList(e.toFile, second))
      : query.includes('AND b.filePath IN')
        ? EDGES.filter((e) => inList(e.fromFile, first) && inList(e.toFile, second))
        : EDGES.filter((e) => inList(e.fromFile, first));
  // The fixture holds no duplicate edges, so RETURN DISTINCT is the identity.
  return matched.map((e) => ({ ...e }));
}

function answerProcessHeaderQuery(query: string): QueryRow[] {
  const [files] = listLiterals(query);
  const limit = Number(/LIMIT (\d+)/.exec(query)?.[1]);
  return PROCESSES.filter((p) => p.files.some((f) => files.includes(f)))
    .map((p) => ({ id: p.id, label: p.label, type: p.type, stepCount: p.stepCount }))
    .sort((a, b) => b.stepCount - a.stepCount || ordinal(a.id, b.id))
    .slice(0, limit);
}

function answerProcessStepQuery(query: string): QueryRow[] {
  const id = /p:Process \{id: '([^']*)'\}/.exec(query)?.[1] ?? '';
  return [{ name: `${id}-step1`, filePath: MODULE_FILES[0], type: 'Function', step: 1 }];
}

const isProcessHeaderQuery = (q: string): boolean =>
  q.includes('STEP_IN_PROCESS') && q.includes('s.filePath IN');
const isProcessStepQuery = (q: string): boolean =>
  q.includes('STEP_IN_PROCESS') && q.includes('p:Process {id:');

/** Every query the mock saw, in call order. */
const seen: string[] = [];

function respond(query: string): QueryRow[] {
  seen.push(query);
  return isProcessStepQuery(query)
    ? answerProcessStepQuery(query)
    : isProcessHeaderQuery(query)
      ? answerProcessHeaderQuery(query)
      : answerCallEdgeQuery(query);
}

const callEdgeQueries = (): string[] => seen.filter((q) => q.includes("type: 'CALLS'"));
const pathsIn = (query: string): string[] => listLiterals(query)[0] ?? [];

/** The `ORDER BY fromName, toName, fromFile, toFile` the queries used to carry. */
const compare = (a: CallEdge, b: CallEdge): number =>
  ordinal(a.fromName, b.fromName) ||
  ordinal(a.toName, b.toName) ||
  ordinal(a.fromFile, b.fromFile) ||
  ordinal(a.toFile, b.toFile);

/** What the pre-#2915 single query returned, from the same engine. */
function legacyRows(where: string): CallEdge[] {
  const list = MODULE_FILES.map((f) => `'${f}'`).join(', ');
  return answerCallEdgeQuery(
    `MATCH (a)-[:CodeRelation {type: 'CALLS'}]->(b) WHERE ${where.replaceAll('$LIST', list)}`,
  ) as unknown as CallEdge[];
}

describe('wiki graph queries: file-list batching (#2915)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seen.length = 0;
    executeQueryMock.mockImplementation(async (_repoId: string, query: string) => respond(query));
  });

  it('splits the intra-module query into one query per batch', async () => {
    await getIntraModuleCallEdges(MODULE_FILES);

    const queries = callEdgeQueries();
    expect(queries).toHaveLength(EXPECTED_BATCHES);
    expect(queries.map((q) => pathsIn(q).length)).toEqual([
      LBUG_QUERY_BATCH_SIZE,
      LBUG_QUERY_BATCH_SIZE,
      50,
    ]);
    expect(pathsIn(queries[0])).toContain(MODULE_FILES[0]);
    expect(pathsIn(queries[0])).not.toContain(MODULE_FILES[LBUG_QUERY_BATCH_SIZE]);
    expect(pathsIn(queries[1])).toContain(MODULE_FILES[LBUG_QUERY_BATCH_SIZE]);
  });

  it('merges intra-module batches into the rows of the single query', async () => {
    const merged = await getIntraModuleCallEdges(MODULE_FILES);

    expect(merged).toEqual(
      legacyRows('a.filePath IN [$LIST] AND b.filePath IN [$LIST]').sort(compare),
    );
  });

  it('keeps an intra-module call whose two ends land in different batches', async () => {
    const merged = await getIntraModuleCallEdges(MODULE_FILES);

    expect(merged).toContainEqual({
      fromFile: CROSS_BATCH_CALLER,
      fromName: 'aFn',
      toFile: CROSS_BATCH_CALLEE,
      toName: 'zFn',
    });
    expect(merged.map((e) => e.toName)).not.toContain('unresolved');
  });

  it('does not mistake a cross-batch call for one leaving the module', async () => {
    const { outgoing, incoming } = await getInterModuleCallEdges(MODULE_FILES);

    expect(outgoing.map((e) => e.toFile)).not.toContain(CROSS_BATCH_CALLEE);
    expect(outgoing.map((e) => e.toName)).not.toContain('unresolved');
    expect(incoming.map((e) => e.fromFile)).not.toContain(CROSS_BATCH_CALLER);
    expect(incoming.map((e) => e.fromFile)).not.toContain(CROSS_BATCH_CALLEE);
  });

  it('applies the inter-module order and 30-row limit across all batches', async () => {
    const { outgoing, incoming } = await getInterModuleCallEdges(MODULE_FILES);

    expect(outgoing).toEqual(
      legacyRows('a.filePath IN [$LIST] AND NOT b.filePath IN [$LIST]').sort(compare).slice(0, 30),
    );
    expect(incoming).toEqual(
      legacyRows('NOT a.filePath IN [$LIST] AND b.filePath IN [$LIST]').sort(compare).slice(0, 30),
    );
    // The window is a global choice, so it spans batches instead of stopping at
    // the first one's 30 rows.
    expect(new Set(outgoing.map((e) => e.fromFile)).size).toBeGreaterThan(1);
    expect(callEdgeQueries()).toHaveLength(EXPECTED_BATCHES * 2);
  });

  it('deduplicates a row a repeated path produces in two batches', async () => {
    const withRepeat = await getInterModuleCallEdges([...MODULE_FILES, MODULE_FILES[4]]);
    const lastBatch = pathsIn(callEdgeQueries()[(EXPECTED_BATCHES - 1) * 2]);
    seen.length = 0;
    const withoutRepeat = await getInterModuleCallEdges(MODULE_FILES);

    // The repeated path really is queried twice — first batch and last — so
    // both batches return its edges and only the merge can collapse them.
    expect(pathsIn(callEdgeQueries()[0])).toContain(MODULE_FILES[4]);
    expect(lastBatch.at(-1)).toBe(MODULE_FILES[4]);
    // `call028` is that file's one edge inside the 30-row window.
    expect(withRepeat.outgoing.filter((e) => e.fromFile === MODULE_FILES[4])).toHaveLength(1);
    expect(withRepeat).toEqual(withoutRepeat);
  });

  it('returns the globally top processes, not the ones from the first batch', async () => {
    const processes = await getProcessesForFiles(MODULE_FILES, 5);

    expect(processes.map((p) => p.id)).toEqual(['p-top', 'p-shared', 'p-11', 'p-10', 'p-09']);
    expect(processes[0].steps).toEqual([
      { name: 'p-top-step1', filePath: MODULE_FILES[0], type: 'Function', step: 1 },
    ]);
    expect(seen.filter(isProcessHeaderQuery)).toHaveLength(EXPECTED_BATCHES);
    expect(seen.filter(isProcessStepQuery)).toHaveLength(5);
  });

  it('keeps the process list at one row per process across batches', async () => {
    const processes = await getProcessesForFiles(MODULE_FILES, 5);

    expect(processes.filter((p) => p.id === 'p-shared')).toHaveLength(1);
    expect(new Set(processes.map((p) => p.id)).size).toBe(processes.length);
  });
});
