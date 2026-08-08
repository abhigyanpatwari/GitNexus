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
import { processesPhase } from '../../src/core/ingestion/pipeline-phases/processes.js';
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
