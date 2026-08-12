/**
 * The wiki's graph queries, executed by a REAL LadybugDB.
 *
 * `test/unit/wiki-graph-queries-list-binding.test.ts` mocks the pool adapter and
 * answers from a hand-written JS reimplementation dispatched on
 * `query.includes(...)`. That is the right instrument for query SHAPE — that a
 * module's file list is bound rather than spliced into the text — and the wrong
 * one for everything the ENGINE decides. Two bugs shipped through that blind
 * spot on this branch:
 *
 *  - a `--` comment inside a Cypher string (Cypher comments are `//`), which
 *    LadybugDB rejects at PREPARE and `detect_changes` swallowed into "No
 *    changes detected."; every mocked test passed.
 *  - `ORDER BY pid, r.step` next to `WHERE p.id IN $ids`, which drops the second
 *    sort key once the scan is large enough and hands back partially sorted
 *    runs. `formatProcesses` (prompts.ts) prints `${s.step}. ${s.name}`, so
 *    every module and overview page carried a scrambled execution trace. The
 *    fake returned rows pre-ordered per pid, so it could not see it.
 *
 * So: mock for shape, engine for semantics. Everything below drives the real
 * exported functions through the real pool adapter.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import {
  closeWikiDb,
  getAllFiles,
  getAllProcesses,
  getFilesWithExports,
  getInterFileCallEdges,
  getInterModuleCallEdges,
  getIntraModuleCallEdges,
  getProcessesForFiles,
  initWikiDb,
} from '../../src/core/wiki/graph-queries.js';
import { CALL_EDGE_LIMIT } from '../../src/core/wiki/prompts.js';
import { compareCodeUnits } from '../../src/lib/utils.js';

// ─── Fixture ──────────────────────────────────────────────────────────────

const ALPHA = 'src/mod/alpha.ts';
const BETA = 'src/mod/beta.ts';
const GAMMA = 'src/other/gamma.ts';
/** A tracked file with no exported symbol — `getAllFiles` sees it, the other doesn't. */
const EMPTY = 'src/empty/void.ts';

/** The module every module-scoped query below is asked about. */
const MODULE_FILES = [ALPHA, BETA];

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * 40 bulk callers plus the two hand-written intra-module edges put 42 rows in
 * front of `CALL_EDGE_LIMIT` (imported above from prompts.ts, the one place
 * that number lives), so the LIMIT has to cut — and `bulkNN` sorts after both
 * hand-written names, which makes the kept set an exactly predictable ordered
 * prefix.
 */
const BULK_CALLERS = Array.from({ length: 40 }, (_, i) => `bulk${pad(i)}`);

/**
 * Twenty processes with DISTINCT step counts, 45 down to 26 — 710 step edges.
 *
 * Distinct on purpose: the header query is `ORDER BY stepCount DESC, id`, and a
 * fixture that needed the tie-breaker would rest the whole suite on the same
 * second-sort-key behavior these tests exist to distrust. Here the leading key
 * is already a total order, and `getAllProcesses()`'s default LIMIT 20 lands
 * exactly on this set.
 *
 * The SIZE is load-bearing. The dropped-second-key defect belongs to the plan
 * the engine picks and does NOT appear on a toy scan — measured on this
 * fixture's shape, `ORDER BY pid, r.step` returns perfectly sorted rows at 100
 * step edges, is intermittent around 400, and scrambled in 6 of 6 runs here.
 * A smaller fixture would leave the ordering assertion below unable to fail
 * against the bug it names, which is the whole reason this file exists.
 */
const TRACE_PROCESSES = Array.from({ length: 20 }, (_, i) => ({
  id: `proc-${pad(i)}`,
  stepCount: 45 - i,
}));

const MAX_STEPS = TRACE_PROCESSES[0].stepCount;
/** Reused across processes, so 710 step edges need only 45 symbols. */
const STEP_SYMBOLS = Array.from({ length: MAX_STEPS }, (_, i) => ({
  name: `step-${pad(i + 1)}`,
  file: i % 2 === 0 ? ALPHA : BETA,
}));
const GAMMA_STEP_SYMBOLS = Array.from({ length: 3 }, (_, i) => ({
  name: `gstep-${pad(i + 1)}`,
  file: GAMMA,
}));

/**
 * Step edges, seeded DESCENDING within each process and interleaved across
 * them: slot `j` writes step `stepCount - j` for every process still that long.
 *
 * So insertion order is the exact REVERSE of the order every assertion below
 * demands, for all 20 processes at once, and no grouping of the rows can make
 * it look sorted by accident. That is what gives the ordering test teeth: with
 * `ORDER BY pid, r.step` the engine leaks this seeded order back out.
 */
const STEP_EDGES: Array<{ proc: string; symbol: string; step: number }> = Array.from(
  { length: MAX_STEPS },
  (_, slot) => slot,
).flatMap((slot) =>
  TRACE_PROCESSES.map((proc) => ({ proc: proc.id, step: proc.stepCount - slot }))
    .filter((e) => e.step >= 1)
    .map((e) => ({ ...e, symbol: STEP_SYMBOLS[e.step - 1].name })),
);

const symbolFile = new Map(
  [...STEP_SYMBOLS, ...GAMMA_STEP_SYMBOLS].map((s) => [s.name, s.file] as const),
);

const fn = (
  file: string,
  name: string,
  isExported: boolean,
  line: number,
): string => `{id: 'Function:${file}:${name}', name: '${name}', filePath: '${file}',
     startLine: ${line}, endLine: ${line}, isExported: ${isExported}, content: '', description: ''}`;

/** `step` is interpolated raw, so a caller may pass a Cypher expression. */
const rel = (type: string, step: number | string = 0): string =>
  `[:CodeRelation {type: '${type}', confidence: 1.0, reason: 'seed', step: ${step}}]`;

/** Every STEP_IN_PROCESS edge this fixture needs, seeded together below. */
const ALL_STEP_EDGES = [
  ...STEP_EDGES,
  ...GAMMA_STEP_SYMBOLS.map((s, i) => ({ proc: 'proc-gamma', symbol: s.name, step: i + 1 })),
  { proc: 'proc-blank', symbol: STEP_SYMBOLS[0].name, step: 1 },
];

/**
 * All 714 step edges in ONE statement.
 *
 * `withTestLbugDB` runs each seed string as its own query, so one
 * `MATCH … CREATE` per edge is 714 round trips — measured at 6.91s wall for
 * this file against 0.19s for its mocked sibling, on a pool whose bare read
 * round trip is 0.53ms. The edges themselves are unchanged: the list keeps its
 * seeded order (see STEP_EDGES) and every row still resolves both endpoints by
 * id, so nothing about what the ordering tests below can observe moves.
 */
const stepEdges = (edges: typeof ALL_STEP_EDGES): string =>
  `UNWIND [${edges
    .map(
      (e) =>
        `{sid: 'Function:${symbolFile.get(e.symbol)}:${e.symbol}', pid: '${e.proc}', step: ${e.step}}`,
    )
    .join(', ')}] AS e
   MATCH (s:Function), (p:Process) WHERE s.id = e.sid AND p.id = e.pid
   CREATE (s)-${rel('STEP_IN_PROCESS', 'e.step')}->(p)`;

const SEED: string[] = [
  // Files
  `CREATE (f:File {id: 'File:${ALPHA}', name: 'alpha.ts', filePath: '${ALPHA}', content: ''})`,
  `CREATE (f:File {id: 'File:${BETA}', name: 'beta.ts', filePath: '${BETA}', content: ''})`,
  `CREATE (f:File {id: 'File:${GAMMA}', name: 'gamma.ts', filePath: '${GAMMA}', content: ''})`,
  `CREATE (f:File {id: 'File:${EMPTY}', name: 'void.ts', filePath: '${EMPTY}', content: ''})`,

  // Exported top-level symbols — UNION arm 1 of getFilesWithExports
  `CREATE (n:Function ${fn(ALPHA, 'alphaFn', true, 1)})`,
  `CREATE (n:Function ${fn(BETA, 'betaFn', true, 1)})`,
  `CREATE (n:Function ${fn(GAMMA, 'gammaFn', true, 1)})`,
  `CREATE (n:Class {id: 'Class:${BETA}:BetaService', name: 'BetaService', filePath: '${BETA}',
     startLine: 10, endLine: 20, isExported: true, content: '', description: '',
     frameworkAnnotations: []})`,
  // Exported class member — reachable only through UNION arm 2
  `CREATE (n:Method {id: 'Method:${BETA}:serve', name: 'serve', filePath: '${BETA}',
     startLine: 12, endLine: 14, isExported: true, content: '', description: '',
     parameterCount: 0, returnType: 'void'})`,

  // Unexported call fodder and step symbols
  `CREATE (n:Function ${fn(BETA, 'sink', false, 30)})`,
  `CREATE ${BULK_CALLERS.map((name, i) => `(:Function ${fn(ALPHA, name, false, 100 + i)})`).join(', ')}`,
  `CREATE ${[...STEP_SYMBOLS, ...GAMMA_STEP_SYMBOLS]
    .map((s, i) => `(:Function ${fn(s.file, s.name, false, 200 + i)})`)
    .join(', ')}`,

  // File → symbol DEFINES. The label is named on both ends: LadybugDB refuses to
  // CREATE a relationship whose endpoint is bound to several node labels.
  ...[
    [ALPHA, 'Function', `Function:${ALPHA}:alphaFn`],
    [BETA, 'Function', `Function:${BETA}:betaFn`],
    [BETA, 'Class', `Class:${BETA}:BetaService`],
    [GAMMA, 'Function', `Function:${GAMMA}:gammaFn`],
  ].map(
    ([file, label, id]) =>
      `MATCH (f:File), (n:${label}) WHERE f.id = 'File:${file}' AND n.id = '${id}'
       CREATE (f)-${rel('DEFINES')}->(n)`,
  ),
  `MATCH (c:Class), (m:Method)
   WHERE c.id = 'Class:${BETA}:BetaService' AND m.id = 'Method:${BETA}:serve'
   CREATE (c)-${rel('HAS_METHOD')}->(m)`,

  // Call edges: two inside the module, one out, one in, 40 bulk inside.
  ...[
    [`Function:${ALPHA}:alphaFn`, `Function:${BETA}:betaFn`],
    [`Function:${BETA}:betaFn`, `Function:${ALPHA}:alphaFn`],
    [`Function:${ALPHA}:alphaFn`, `Function:${GAMMA}:gammaFn`],
    [`Function:${GAMMA}:gammaFn`, `Function:${BETA}:betaFn`],
  ].map(
    ([from, to]) =>
      `MATCH (a:Function), (b:Function) WHERE a.id = '${from}' AND b.id = '${to}'
       CREATE (a)-${rel('CALLS')}->(b)`,
  ),
  `MATCH (a:Function), (b:Function)
   WHERE a.name STARTS WITH 'bulk' AND b.id = 'Function:${BETA}:sink'
   CREATE (a)-${rel('CALLS')}->(b)`,

  // Processes.
  ...TRACE_PROCESSES.map(
    (p) =>
      `CREATE (p:Process {id: '${p.id}', label: 'L${p.id}', heuristicLabel: 'Flow ${p.id}',
         processType: 'intra_community', stepCount: ${p.stepCount}, communities: [],
         entryPointId: '', terminalId: ''})`,
  ),
  // Steps entirely outside the module — visible to getAllProcesses, invisible to
  // getProcessesForFiles(MODULE_FILES).
  `CREATE (p:Process {id: 'proc-gamma', label: 'LGamma', heuristicLabel: 'Gamma Flow',
     processType: 'cross_community', stepCount: 3, communities: [], entryPointId: '', terminalId: ''})`,
  // An EMPTY label and type: `??` keeps them, where the `||` this replaced
  // substituted the id and 'unknown'.
  `CREATE (p:Process {id: 'proc-blank', label: 'LBlank', heuristicLabel: '',
     processType: '', stepCount: 1, communities: [], entryPointId: '', terminalId: ''})`,
  // No heuristicLabel/processType column at all — the genuine NULL, which must
  // still fall back to the id and 'unknown'. No steps either.
  `CREATE (p:Process {id: 'proc-null', label: 'LNull', stepCount: 0, communities: []})`,

  stepEdges(ALL_STEP_EDGES),
];

/** The trace every `proc-NN` must come back with: 1..stepCount, ascending. */
const expectedTrace = (stepCount: number): number[] =>
  Array.from({ length: stepCount }, (_, i) => i + 1);

// ─── Suite ────────────────────────────────────────────────────────────────

withTestLbugDB(
  'wiki-graph-queries-engine',
  () => {
    // Nested so this afterAll is guaranteed to run BEFORE withTestLbugDB's own
    // teardown closes the Database these pooled connections were opened from.
    describe('#2915 wiki graph queries against a real engine', () => {
      afterAll(async () => {
        await closeWikiDb();
      });

      it('prepares and executes every exported query', async () => {
        // A malformed query throws at PREPARE inside `executeParameterized`, so
        // calling each function IS the prepare test — the `--`-comment class of
        // bug cannot reach a wiki page without failing here.
        await expect(
          Promise.all([
            getAllFiles(),
            getFilesWithExports(),
            getInterFileCallEdges(),
            getIntraModuleCallEdges(MODULE_FILES),
            getInterModuleCallEdges(MODULE_FILES),
            getProcessesForFiles(MODULE_FILES),
            getAllProcesses(),
          ]),
        ).resolves.toBeDefined();
      });

      it('returns every tracked file, including one with no exports', async () => {
        expect(await getAllFiles()).toEqual([EMPTY, ALPHA, BETA, GAMMA]);
      });

      it('labels each exported symbol with its real node label, not an empty string', async () => {
        // `labels(n)[0]`: the engine returns a node's label as a SCALAR string,
        // and subscripting a string is 1-based over characters, so `[0]` was ''
        // and `formatFileListForGrouping` (prompts.ts) described every exported
        // symbol to the LLM as `name ()`.
        const byFile = new Map((await getFilesWithExports()).map((f) => [f.filePath, f.symbols]));

        expect(byFile.get(ALPHA)).toEqual([{ name: 'alphaFn', type: 'Function' }]);
        // UNION arm 1 (Function, Class) and arm 2 (Method, via HAS_METHOD) each
        // carry a label — the subscript blanked both sites.
        expect(
          [...(byFile.get(BETA) ?? [])].sort((a, b) => compareCodeUnits(a.name, b.name)),
        ).toEqual([
          { name: 'BetaService', type: 'Class' },
          { name: 'betaFn', type: 'Function' },
          { name: 'serve', type: 'Method' },
        ]);
        expect(byFile.has(EMPTY)).toBe(false);
      });

      it('returns cross-file call edges only', async () => {
        const edges = await getInterFileCallEdges();

        expect(edges).toContainEqual({
          fromFile: ALPHA,
          fromName: 'alphaFn',
          toFile: GAMMA,
          toName: 'gammaFn',
        });
        expect(edges.filter((e) => e.fromFile === e.toFile)).toEqual([]);
      });

      it('cuts the intra-module edge list at the limit, keeping the ordered prefix', async () => {
        const edges = await getIntraModuleCallEdges(MODULE_FILES);

        // 42 edges match; `ORDER BY fromName, toName, fromFile, toFile / LIMIT`
        // decides which 30 survive. Drop the LIMIT and this is 42 rows; drop the
        // ORDER BY and the engine picks an arbitrary 30 (#2787).
        expect(edges).toHaveLength(CALL_EDGE_LIMIT);
        expect(edges.map((e) => e.fromName)).toEqual([
          'alphaFn',
          'betaFn',
          ...BULK_CALLERS.slice(0, CALL_EDGE_LIMIT - 2),
        ]);
        expect(edges[0]).toEqual({
          fromFile: ALPHA,
          fromName: 'alphaFn',
          toFile: BETA,
          toName: 'betaFn',
        });
      });

      it('splits inter-module edges by direction and excludes intra-module ones', async () => {
        const { outgoing, incoming } = await getInterModuleCallEdges(MODULE_FILES);

        expect(outgoing).toEqual([
          { fromFile: ALPHA, fromName: 'alphaFn', toFile: GAMMA, toName: 'gammaFn' },
        ]);
        expect(incoming).toEqual([
          { fromFile: GAMMA, fromName: 'gammaFn', toFile: BETA, toName: 'betaFn' },
        ]);
      });

      it('returns every overview trace in ascending step order', async () => {
        // The regression this file exists for, through the exact call the
        // overview page makes (`getAllProcesses()`, default limit 20).
        const processes = await getAllProcesses();

        expect(processes.map((p) => ({ id: p.id, steps: p.steps.map((s) => s.step) }))).toEqual(
          TRACE_PROCESSES.map((p) => ({ id: p.id, steps: expectedTrace(p.stepCount) })),
        );
        // Grouping and sorting are separate properties: the longest and the
        // shortest trace must each hold ITS OWN symbols, in order.
        const longest = TRACE_PROCESSES[0];
        const shortest = TRACE_PROCESSES[TRACE_PROCESSES.length - 1];
        expect(processes[0].steps.map((s) => s.name)).toEqual(
          STEP_SYMBOLS.slice(0, longest.stepCount).map((s) => s.name),
        );
        expect(processes[processes.length - 1].steps.map((s) => s.name)).toEqual(
          STEP_SYMBOLS.slice(0, shortest.stepCount).map((s) => s.name),
        );
      });

      it('scopes processes to the files asked about, still in step order', async () => {
        const [inModule, inGamma] = await Promise.all([
          getProcessesForFiles(MODULE_FILES, 20),
          getProcessesForFiles([GAMMA], 5),
        ]);

        // proc-gamma's steps live outside the module, so it is not a module process.
        expect(inModule.map((p) => p.id)).toEqual(TRACE_PROCESSES.map((p) => p.id));
        expect(inModule.map((p) => p.steps.map((s) => s.step))).toEqual(
          TRACE_PROCESSES.map((p) => expectedTrace(p.stepCount)),
        );
        expect(inGamma.map((p) => p.id)).toEqual(['proc-gamma']);
        expect(inGamma[0].steps.map((s) => s.name)).toEqual(GAMMA_STEP_SYMBOLS.map((s) => s.name));
      });

      it('labels each step with its real node label', async () => {
        // The third `labels(x)[0]` site, reached only through withSteps.
        const [first] = await getAllProcesses();

        expect([...new Set(first.steps.map((s) => s.type))]).toEqual(['Function']);
        expect([...new Set(first.steps.map((s) => s.filePath))].sort(compareCodeUnits)).toEqual([
          ALPHA,
          BETA,
        ]);
      });

      it('keeps an empty label and type, and falls back only for a null one', async () => {
        const byId = new Map((await getAllProcesses(30)).map((p) => [p.id, p]));

        // `??`, not `||`: a process genuinely labelled '' keeps ''.
        expect(byId.get('proc-blank')).toMatchObject({ label: '', type: '', stepCount: 1 });
        // A NULL column still falls back — to the id, and to 'unknown'.
        expect(byId.get('proc-null')).toMatchObject({
          label: 'proc-null',
          type: 'unknown',
          stepCount: 0,
        });
        // …and a process with no STEP_IN_PROCESS edge gets an empty trace, not a
        // borrowed one: the grouped query returns no row for it at all.
        expect(byId.get('proc-null')?.steps).toEqual([]);
      });

      it('ranks processes by step count across the whole graph', async () => {
        const processes = await getAllProcesses(30);

        expect(processes.map((p) => p.id)).toEqual([
          ...TRACE_PROCESSES.map((p) => p.id),
          'proc-gamma',
          'proc-blank',
          'proc-null',
        ]);
        expect(processes[0].label).toBe('Flow proc-00');
      });
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    // graph-queries.ts pins its own repo id (`__wiki__`) inside the module, so
    // the suite opens a second pool entry onto the SAME Database the helper
    // injected — initLbug reuses the cached handle for this dbPath rather than
    // taking a second file lock.
    afterSetup: async (handle) => {
      await initWikiDb(handle.dbPath);
    },
  },
);
