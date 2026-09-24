/**
 * A CALLS edge whose target was GUESSED from a unique name must never seed or
 * extend a process trace, and must never join two nodes into a community on a
 * large graph.
 *
 * The reason this needs its own test rather than resting on the confidence
 * floor: guessed edges are emitted at exactly 0.5, which is the value of both
 * `process-processor`'s `MIN_TRACE_CONFIDENCE` and `community-processor`'s
 * `MIN_CONFIDENCE_LARGE`. Those gates were written as `confidence < THRESHOLD`,
 * so 0.5 passes them. Anything relying on "low confidence is filtered out"
 * would silently admit every guess, which is how a name collision turns into a
 * confident-looking execution flow through code that never calls itself.
 *
 * The control arm is what makes each assertion mean something: the SAME topology
 * with a resolved reason must still produce the flow, so a passing test cannot
 * be explained by the graph being unusable.
 */

import { describe, it, expect } from 'vitest';
import { processProcesses } from '../../src/core/ingestion/process-processor.js';
import { buildCommunityProjection } from '../../src/core/ingestion/community-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { GLOBAL_NAME_FALLBACK_REASON } from '../../src/core/graph/edge-reasons.js';

const addFunction = (graph: KnowledgeGraph, name: string, filePath: string): string => {
  const id = `func:${name}`;
  graph.addNode({
    id,
    label: 'Function',
    properties: { name, filePath, startLine: 1, endLine: 10, isExported: true },
  });
  return id;
};

const addCall = (
  graph: KnowledgeGraph,
  sourceId: string,
  targetId: string,
  reason: string,
): void => {
  graph.addRelationship({
    id: `rel:CALLS:${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type: 'CALLS',
    // The exact value guessed edges are emitted at, on purpose: a test using
    // 0.3 would pass against a pure confidence gate and prove nothing.
    confidence: 0.5,
    reason,
  });
};

/** A 3-node chain whose every CALLS edge carries `reason`. */
const chainGraph = (reason: string): KnowledgeGraph => {
  const graph = createKnowledgeGraph();
  const handle = addFunction(graph, 'handleRequest', 'src/handler.ts');
  const validate = addFunction(graph, 'validateInput', 'src/validate.ts');
  const persist = addFunction(graph, 'persistRecord', 'src/store.ts');
  addCall(graph, handle, validate, reason);
  addCall(graph, validate, persist, reason);
  return graph;
};

describe('process tracing excludes name-guessed CALLS edges', () => {
  it('traces a flow when the chain is resolved (control)', async () => {
    const result = await processProcesses(chainGraph('import-resolved'), []);
    expect(result.processes.length).toBeGreaterThan(0);
  });

  it('traces NO flow when the identical chain is a unique-name guess', async () => {
    const result = await processProcesses(chainGraph(GLOBAL_NAME_FALLBACK_REASON), []);
    expect(result.processes).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
  });

  it('keeps a resolved chain intact when a guessed edge branches off it', async () => {
    // The guess must be dropped without taking the real flow with it.
    const graph = chainGraph('import-resolved');
    const stray = addFunction(graph, 'unrelatedHelper', 'vendor/other.ts');
    addCall(graph, 'func:validateInput', stray, GLOBAL_NAME_FALLBACK_REASON);

    const result = await processProcesses(graph, []);
    expect(result.processes.length).toBeGreaterThan(0);
    const tracedNames = new Set(result.steps.map((step) => step.toName));
    expect(tracedNames.has('unrelatedHelper')).toBe(false);
  });
});

describe('large-graph community projection excludes name-guessed CALLS edges', () => {
  /**
   * Build a graph over the 10,000-symbol line that makes a projection "large",
   * with one CALLS edge of `reason` joining `filler0` to `filler1`.
   *
   * Both endpoints are anchored to two shared hubs by RESOLVED edges. That is
   * load-bearing rather than scaffolding: a large projection drops degree-1
   * nodes, so anchoring only once would make the guessed edge's removal prune
   * its endpoints too and the edge count would collapse for a second reason.
   * With the anchors, the eligible node set is identical in both arms and the
   * only difference in the projection is the edge under test.
   */
  const largeGraphWithOneCall = (reason: string): KnowledgeGraph => {
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 10_001; i++) addFunction(graph, `filler${i}`, `src/f${i}.ts`);
    const hubA = addFunction(graph, 'hubA', 'src/hubA.ts');
    const hubB = addFunction(graph, 'hubB', 'src/hubB.ts');
    for (const endpoint of ['func:filler0', 'func:filler1']) {
      addCall(graph, endpoint, hubA, 'import-resolved');
      addCall(graph, endpoint, hubB, 'import-resolved');
    }
    addCall(graph, 'func:filler0', 'func:filler1', reason);
    return graph;
  };

  it('projects the joining edge when it is resolved (control)', () => {
    const projection = buildCommunityProjection(largeGraphWithOneCall('import-resolved'));
    expect(projection.edges).toHaveLength(5);
  });

  it('omits the joining edge when it is a unique-name guess', () => {
    const projection = buildCommunityProjection(largeGraphWithOneCall(GLOBAL_NAME_FALLBACK_REASON));
    expect(projection.edges).toHaveLength(4);
    // Same node set in both arms — the difference really is the one edge.
    expect(projection.nodes).toHaveLength(4);
  });
});

describe('SMALL-graph community projection excludes name-guessed CALLS edges too', () => {
  // The exclusion is about what the edge claims, not about graph size: a
  // 3-symbol repository must not cluster two functions on a name guess either.
  const smallGraphWithOneCall = (reason: string): KnowledgeGraph => {
    const graph = createKnowledgeGraph();
    const a = addFunction(graph, 'alpha', 'src/a.ts');
    const b = addFunction(graph, 'beta', 'src/b.ts');
    const c = addFunction(graph, 'gamma', 'src/c.ts');
    addCall(graph, a, b, 'import-resolved');
    addCall(graph, b, c, reason);
    return graph;
  };

  it('projects the edge when it is resolved (control)', () => {
    const projection = buildCommunityProjection(smallGraphWithOneCall('import-resolved'));
    expect(projection.isLarge).toBe(false);
    expect(projection.edges).toHaveLength(2);
    expect(projection.nodes).toHaveLength(3);
  });

  it('omits the edge when it is a unique-name guess', () => {
    const projection = buildCommunityProjection(smallGraphWithOneCall(GLOBAL_NAME_FALLBACK_REASON));
    expect(projection.isLarge).toBe(false);
    expect(projection.edges).toHaveLength(1);
    // The guessed edge's far endpoint no longer touches any clustering edge, so
    // it is not projected — a small graph keeps degree-1 nodes, but not
    // degree-0 ones.
    expect(projection.nodes).toHaveLength(2);
  });
});
