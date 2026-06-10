/**
 * #2112 boundary audit — the analyze-worker → parent IPC projection.
 *
 * The forked analyze worker reports completion over default-JSON child_process
 * IPC. `AnalyzeResult.pipelineResult` carries the live `KnowledgeGraph` (closure
 * methods, getter-materialized arrays) and can transitively hold a BigInt or a
 * circular reference — all of which break `JSON.stringify` (the IPC serializer):
 * methods drop silently, BigInt/circular THROW. `projectAnalyzeResultForIpc`
 * strips `pipelineResult` to an explicit JSON-safe allowlist so the boundary is
 * safe by construction. These tests pin that contract.
 */
import { describe, it, expect } from 'vitest';

import { projectAnalyzeResultForIpc } from '../../src/server/analyze-worker-ipc.js';
import type { AnalyzeResult } from '../../src/core/run-analyze.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';

/**
 * An `AnalyzeResult` whose `pipelineResult` is hostile to JSON in all three
 * ways the real `KnowledgeGraph` can be: a method (dropped), a circular ref
 * (throws), and a BigInt (throws).
 */
function hostileResult(): AnalyzeResult {
  const graph: Record<string, unknown> = {
    nodes: [{ id: 'a', label: 'Function', properties: { name: 'a' } }],
    relationships: [],
    forEachNode: () => {}, // own function property — JSON drops it silently
    bigCount: 10n, // BigInt — JSON.stringify throws
  };
  graph.self = graph; // circular — JSON.stringify throws
  return {
    repoName: 'demo',
    repoPath: '/repos/demo',
    stats: { files: 3, nodes: 1, edges: 0 },
    alreadyUpToDate: false,
    ftsSkipped: true,
    pipelineResult: { graph, repoPath: '/repos/demo', totalFileCount: 3 },
  };
}

describe('#2112: analyze-worker IPC projection', () => {
  it('drops pipelineResult and preserves the scalar fields the parent consumes', () => {
    const projected = projectAnalyzeResultForIpc(hostileResult());
    expect(projected).toEqual({
      repoName: 'demo',
      repoPath: '/repos/demo',
      stats: { files: 3, nodes: 1, edges: 0 },
      alreadyUpToDate: false,
      ftsRepairedOnly: undefined,
      ftsSkipped: true,
    });
    expect('pipelineResult' in projected).toBe(false);
  });

  it('the projection is JSON-serializable (survives the default child_process IPC channel)', () => {
    const projected = projectAnalyzeResultForIpc(hostileResult());
    // The real failure mode: process.send runs JSON.stringify under the hood.
    expect(() => JSON.stringify(projected)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(projected));
    expect(roundTripped.repoName).toBe('demo');
    expect(roundTripped.stats.nodes).toBe(1);
  });

  it('anchors the hazard: serializing the RAW result throws (the bug the projection prevents)', () => {
    // Without the projection, `send({type:'complete', result})` would throw a
    // TypeError in the worker, get caught, and mis-report this success as a
    // failure. This assertion documents why the projection exists.
    expect(() => JSON.stringify(hostileResult())).toThrow(TypeError);
  });

  it('drops a REAL KnowledgeGraph from pipelineResult — the payload stays tiny (graph not materialized)', () => {
    // The synthetic cases above use a hand-built hostile object; this uses the
    // real createKnowledgeGraph the server path actually puts in pipelineResult,
    // whose nodes/relationships getters would materialize the whole graph into
    // arrays under JSON.stringify. The projection must drop it entirely.
    const graph = createKnowledgeGraph();
    for (let i = 0; i < 50; i++) {
      graph.addNode({
        id: `n${i}`,
        label: 'Function',
        properties: { name: `n${i}`, filePath: 'x.ts' },
      });
    }
    graph.addRelationship({ id: 'n0->n1', source: 'n0', target: 'n1', type: 'CALLS' });
    const result: AnalyzeResult = {
      repoName: 'demo',
      repoPath: '/r',
      stats: { nodes: 50, edges: 1 },
      pipelineResult: {
        graph,
        repoPath: '/r',
        totalFileCount: 50,
        resolutionOutcomes: [],
        usedWorkerPool: true,
      },
    };
    const projected = projectAnalyzeResultForIpc(result);
    expect('pipelineResult' in projected).toBe(false);
    const json = JSON.stringify(projected);
    // A materialized 50-node graph would be thousands of bytes; the projection
    // is just the scalar fields, so this stays small.
    expect(json.length).toBeLessThan(300);
    const rt = JSON.parse(json);
    expect(rt.repoName).toBe('demo');
    expect(rt.stats.nodes).toBe(50);
  });
});
