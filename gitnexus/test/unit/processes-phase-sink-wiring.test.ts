/**
 * The processes phase's SINK WIRING, exercised on its success path (#2896).
 *
 * `processesPhase` reads `allFetchCalls` / `allORMQueries` off the parse output
 * to build the R3-6 sink set, wrapped in a `try/catch` that falls open to "no
 * sinks". Every other phase-level test omits `parse` from its deps map, so all
 * of them take the CATCH branch — the success path had no coverage at all.
 *
 * That matters because `getPhaseOutput` is a raw `as T` cast. If the field names
 * on `ParseOutput` ever drift, the phase reads nothing, detects zero sinks, and
 * every existing test still passes, because zero sinks is exactly what they
 * already assert. The wiring could break silently and in complete silence.
 *
 * So this asserts the thing only the success path can produce: a flow that ENDS
 * at the sink, while a longer chain continues past it. Without the sink set that
 * prefix is subsumed and only the long chain survives.
 */
import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';
import { processesPhase } from '../../src/core/ingestion/pipeline-phases/processes.js';
import type { ProcessesOutput } from '../../src/core/ingestion/pipeline-phases/processes.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';

function makeCtx(graph: KnowledgeGraph): PipelineContext {
  return { repoPath: '/tmp/repo', graph, onProgress: () => {}, pipelineStart: 0 };
}

function phaseResult<T>(phaseName: string, output: T): PhaseResult<T> {
  return { phaseName, output, durationMs: 0 };
}

const FILE = 'src/orders.ts';

function addNode(graph: KnowledgeGraph, id: string, label: NodeLabel, name: string, line: number) {
  graph.addNode({
    id,
    label,
    properties: {
      name,
      filePath: FILE,
      startLine: line,
      endLine: line + 4,
      isExported: true,
      content: '',
    },
  } satisfies GraphNode);
}

function addCall(graph: KnowledgeGraph, from: string, to: string): void {
  graph.addRelationship({
    id: `rel:${from}->${to}`,
    sourceId: from,
    targetId: to,
    type: 'CALLS',
    confidence: 1,
    reason: 'test',
  });
}

/**
 * `scan -> score -> placeOrder -> formatDate`, where `placeOrder` performs the
 * outward call. The business flow ends at `placeOrder`; the chain runs on into a
 * helper. Both must exist as processes — that is the whole point of R3-6.
 */
function buildGraph(): KnowledgeGraph {
  const graph = createKnowledgeGraph();
  addNode(graph, 'File:' + FILE, 'File', 'orders.ts', 1);
  addNode(graph, 'Function:scan', 'Function', 'scan', 1);
  addNode(graph, 'Function:score', 'Function', 'score', 10);
  addNode(graph, 'Function:placeOrder', 'Function', 'placeOrder', 20);
  addNode(graph, 'Function:formatDate', 'Function', 'formatDate', 30);
  addCall(graph, 'Function:scan', 'Function:score');
  addCall(graph, 'Function:score', 'Function:placeOrder');
  addCall(graph, 'Function:placeOrder', 'Function:formatDate');
  return graph;
}

const baseDeps = (): Map<string, PhaseResult<unknown>> =>
  new Map<string, PhaseResult<unknown>>([
    ['structure', phaseResult('structure', { totalFiles: 1 })],
    ['communities', phaseResult('communities', { communityResult: { memberships: [] } })],
    ['routes', phaseResult('routes', { routeRegistry: new Map() })],
    ['tools', phaseResult('tools', { toolDefs: [] })],
  ]);

/** A fetch site INSIDE `placeOrder`, which is what makes it a sink. */
const parseWithSinks = (): PhaseResult<unknown> =>
  phaseResult('parse', {
    allFetchCalls: [{ filePath: FILE, lineNumber: 22 }],
    allORMQueries: [],
  });

const terminalsOf = (graph: KnowledgeGraph): string[] => {
  const out: string[] = [];
  for (const node of graph.iterNodes()) {
    if (node.label === 'Process') out.push(String(node.properties.terminalId));
  }
  return out;
};

describe('processes phase — parse-output sink wiring (#2896)', () => {
  it('declares `parse` as a dependency', () => {
    // The read and the declaration must not diverge: dropping the dep would
    // make `getPhaseOutput` throw into the fail-open catch on every run, and
    // every other test would still pass.
    expect(processesPhase.deps).toContain('parse');
  });

  it('reads the parse output and produces a SINK-TERMINATED flow', async () => {
    const graph = buildGraph();
    const deps = baseDeps();
    deps.set('parse', parseWithSinks());

    await processesPhase.execute(makeCtx(graph), deps);

    // `placeOrder` is a terminal even though the chain continues into
    // `formatDate` — only the sink set can produce that.
    expect(terminalsOf(graph)).toContain('Function:placeOrder');
  });

  it('the same graph WITHOUT parse yields no sink-terminated flow', async () => {
    // The control. Without it the assertion above could pass for an unrelated
    // reason — this is the fail-open branch every other phase test takes, and it
    // is what makes the difference attributable to the wiring.
    const graph = buildGraph();

    await processesPhase.execute(makeCtx(graph), baseDeps());

    expect(terminalsOf(graph)).not.toContain('Function:placeOrder');
  });

  it('survives a parse output whose sink fields are absent', async () => {
    // Fail-open is deliberate: a pipeline composed without those outputs should
    // detect no sinks rather than lose every process.
    const graph = buildGraph();
    const deps = baseDeps();
    deps.set('parse', phaseResult('parse', {}));

    await processesPhase.execute(makeCtx(graph), deps);

    expect(terminalsOf(graph).length).toBeGreaterThan(0);
  });
});

/**
 * WHICH ceilings are loud (#2899 follow-up).
 *
 * The truncation disclosure landed as an ungated `logger.warn` on
 * `truncation.truncated`, and this phase overrides only `maxProcesses` — so at
 * the shipped defaults (`maxBranching: 4`, `maxTraceDepth: 10`, per-entry trace
 * budget 12) it fired for any function with five callees and any chain deeper
 * than ten, i.e. on every non-trivial repository, every run. A warning that
 * always fires is a warning nobody reads.
 *
 * The split asserted here is the one `ProcessTruncationStats` already writes
 * down: a ceiling that removes WHOLE FLOWS from the report warns; a ceiling that
 * only makes a reported flow shorter than the code path it describes goes to
 * debug. Both fixtures are truncated — what differs is which kind.
 */
describe('processes phase — truncation is disclosed proportionately (#2899)', () => {
  const addFn = (graph: KnowledgeGraph, id: string): void => {
    graph.addNode({
      id,
      label: 'Function',
      properties: { name: id.split(':')[1], filePath: 'src/a.ts', startLine: 1, endLine: 2 },
    });
  };
  const addCallEdge = (graph: KnowledgeGraph, from: string, to: string): void => {
    graph.addRelationship({
      id: `rel:${from}->${to}`,
      sourceId: from,
      targetId: to,
      type: 'CALLS',
      confidence: 1,
      reason: 'test',
    });
  };

  /**
   * Trips ONLY the shape ceilings: a 13-long chain (traces cut at
   * `maxTraceDepth`) and a five-way fan-out (a callee skipped at
   * `maxBranching`). Every flow found is still in the report — none of the four
   * surviving traces was dropped, and the phase's own `maxProcesses` floor of 20
   * is well clear of them.
   */
  const shortenedOnly = (): KnowledgeGraph => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 13; i++) addFn(graph, `func:c${i}`);
    for (let i = 0; i < 12; i++) addCallEdge(graph, `func:c${i}`, `func:c${i + 1}`);
    addFn(graph, 'func:fanout');
    for (let i = 0; i < 5; i++) {
      addFn(graph, `func:leaf${i}`);
      addCallEdge(graph, 'func:fanout', `func:leaf${i}`);
    }
    return graph;
  };

  /**
   * Trips ONLY the whole-flow ceilings: 40 independent three-step chains against
   * a `maxProcesses` of 20 (the floor `computeDynamicMaxProcesses` gives 120
   * symbols), so half the deduplicated flows are dropped outright and the trace
   * quota stops the loop with entry points still unvisited. Nothing here is
   * deep enough or wide enough to hit `maxTraceDepth` or `maxBranching`.
   */
  const flowsMissing = (): KnowledgeGraph => {
    const graph = createKnowledgeGraph();
    for (let c = 0; c < 40; c++) {
      for (let i = 0; i < 3; i++) addFn(graph, `func:p${c}_${i}`);
      for (let i = 0; i < 2; i++) addCallEdge(graph, `func:p${c}_${i}`, `func:p${c}_${i + 1}`);
    }
    return graph;
  };

  const runCaptured = async (
    graph: KnowledgeGraph,
  ): Promise<{ output: ProcessesOutput; records: ReturnType<LoggerCapture['records']> }> => {
    // Captured at `debug` so an ABSENT warn can be distinguished from a silent
    // phase: the debug line has to be there instead.
    const capture = _captureLogger('debug');
    try {
      const output = (await processesPhase.execute(makeCtx(graph), baseDeps())) as ProcessesOutput;
      return { output, records: capture.records() };
    } finally {
      capture.restore();
    }
  };

  const PROCESS_LINES = /^\[processes\] /;

  it('does NOT warn when the caps only made flows shorter', async () => {
    const { output, records } = await runCaptured(shortenedOnly());
    const { truncation } = output.processResult.stats;

    // The fixture is genuinely truncated — this is not a "nothing happened" pass.
    expect(truncation.truncated).toBe(true);
    expect(truncation.tracesDepthCapped).toBeGreaterThan(0);
    expect(truncation.calleesDropped).toBeGreaterThan(0);
    // ...and truncated in NO other way, so the assertions below are attributable.
    expect(truncation.entryPointCandidatesDropped).toBe(0);
    expect(truncation.entryPointsUnexplored).toBe(0);
    expect(truncation.processesDropped).toBe(0);

    const lines = records.filter((r) => PROCESS_LINES.test(String(r.msg)));
    expect(lines.map((r) => r.level)).toEqual([20]); // debug, not warn
    expect(String(lines[0]?.msg)).toContain('shorter than the code path');
  });

  it('DOES warn when whole flows are missing from the report', async () => {
    const { output, records } = await runCaptured(flowsMissing());
    const { truncation } = output.processResult.stats;

    expect(truncation.processesDropped).toBeGreaterThan(0);
    expect(truncation.entryPointsUnexplored).toBeGreaterThan(0);
    // Neither shape ceiling fired here, so the warn is attributable to the
    // whole-flow counters and not to a chain that merely ran long.
    expect(truncation.tracesDepthCapped).toBe(0);
    expect(truncation.calleesDropped).toBe(0);

    const lines = records.filter((r) => PROCESS_LINES.test(String(r.msg)));
    expect(lines.map((r) => r.level)).toEqual([40]); // warn
    expect(String(lines[0]?.msg)).toContain('whole flows are MISSING');
  });

  it('says nothing at all when no ceiling fired', async () => {
    // The control for both: the phase must not narrate an untruncated run.
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 3; i++) addFn(graph, `func:q${i}`);
    for (let i = 0; i < 2; i++) addCallEdge(graph, `func:q${i}`, `func:q${i + 1}`);

    const { output, records } = await runCaptured(graph);

    expect(output.processResult.processes.length).toBeGreaterThan(0);
    expect(output.processResult.stats.truncation.truncated).toBe(false);
    expect(records.filter((r) => PROCESS_LINES.test(String(r.msg)))).toEqual([]);
  });

  it('reports the entry-point candidate cap in the warn payload', async () => {
    // The dominant ceiling on any real repository, and the one that stays in the
    // loud set precisely because it is the only counter that grows with repo
    // size — `entryPointsUnexplored` and `processesDropped` can only fire while
    // `maxProcesses` is small enough to bind.
    const graph = createKnowledgeGraph();
    for (let c = 0; c < 205; c++) {
      for (let i = 0; i < 3; i++) addFn(graph, `func:m${c}_${i}`);
      for (let i = 0; i < 2; i++) addCallEdge(graph, `func:m${c}_${i}`, `func:m${c}_${i + 1}`);
    }

    const { output, records } = await runCaptured(graph);

    expect(output.processResult.stats.truncation.entryPointCandidatesDropped).toBe(210);
    const lines = records.filter((r) => PROCESS_LINES.test(String(r.msg)));
    expect(lines.map((r) => r.level)).toEqual([40]);
    expect(String(lines[0]?.msg)).toContain('210 of 410 candidate entry point(s) never ranked in');
  });
});
