/**
 * Unit coverage for ENTRY_POINT_OF re-keying (#2289).
 *
 * The processes phase links a Route node to the execution flow rooted at its
 * handler file. After the multi-verb identity change the edge must target the
 * `(method, url)` node id (`routeNodeKey`), not the bare URL — so a same-URL
 * GET/POST pair produces TWO distinct ENTRY_POINT_OF edges, one per verb node.
 */
import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processesPhase } from '../../src/core/ingestion/pipeline-phases/processes.js';
import { generateId } from '../../src/lib/utils.js';
import { routeNodeKey } from '../../src/core/ingestion/route-extractors/route-path.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { GraphNode, GraphRelationship, NodeLabel } from 'gitnexus-shared';

function makeCtx(graph: KnowledgeGraph, repoPath = 'D:/tmp/repo'): PipelineContext {
  return { repoPath, graph, onProgress: () => {}, pipelineStart: 0 };
}

function phaseResult<T>(phaseName: string, output: T): PhaseResult<T> {
  return { phaseName, output, durationMs: 0 };
}

function addNode(
  graph: KnowledgeGraph,
  id: string,
  label: NodeLabel,
  name: string,
  filePath: string,
) {
  graph.addNode({
    id,
    label,
    properties: { name, filePath, startLine: 1, endLine: 1, isExported: true, content: '' },
  } satisfies GraphNode);
}

function addCall(graph: KnowledgeGraph, sourceId: string, targetId: string) {
  graph.addRelationship({
    id: `${sourceId}->${targetId}`,
    sourceId,
    targetId,
    type: 'CALLS',
    confidence: 1,
    reason: 'direct',
  } satisfies GraphRelationship);
}

describe('Route → process linking (ENTRY_POINT_OF) re-keying', () => {
  it('emits one ENTRY_POINT_OF edge per verb node for a same-URL GET/POST pair', async () => {
    const graph = createKnowledgeGraph();
    const filePath = 'OrderController.java';
    const entry = 'Function:OrderController.listOrders';
    const helper = 'Function:OrderController.helper';
    const leaf = 'Function:OrderController.leaf';

    addNode(graph, generateId('File', filePath), 'File', 'OrderController.java', filePath);
    addNode(graph, entry, 'Function', 'listOrders', filePath);
    addNode(graph, helper, 'Function', 'helper', filePath);
    addNode(graph, leaf, 'Function', 'leaf', filePath);
    // 3-step call chain rooted in the handler file → forms a process.
    addCall(graph, entry, helper);
    addCall(graph, helper, leaf);

    // Two routes sharing /orders, distinct verbs (mirrors the routes phase
    // registry shape: keyed by routeNodeKey, each entry carries url + method).
    const routeRegistry = new Map([
      [
        routeNodeKey('GET', '/orders'),
        { filePath, source: 'decorator-GetMapping', url: '/orders', method: 'GET' },
      ],
      [
        routeNodeKey('POST', '/orders'),
        { filePath, source: 'decorator-PostMapping', url: '/orders', method: 'POST' },
      ],
    ]);

    await processesPhase.execute(
      makeCtx(graph),
      new Map([
        ['structure', phaseResult('structure', { totalFiles: 1 })],
        ['communities', phaseResult('communities', { communityResult: { memberships: [] } })],
        ['routes', phaseResult('routes', { routeRegistry })],
        ['tools', phaseResult('tools', { toolDefs: [] })],
      ]),
    );

    // ENTRY_POINT_OF edges whose target is a Process. The processes phase emits
    // these by Route node id (it does not require the Route node to pre-exist);
    // toolDefs is empty here, so every such edge is a route→process link.
    const routeEntryEdges = graph.relationships.filter(
      (r) => r.type === 'ENTRY_POINT_OF' && graph.getNode(r.targetId)?.label === 'Process',
    );
    const sources = new Set(routeEntryEdges.map((r) => r.sourceId));

    // Both composite-keyed Route nodes anchor the flow — not the bare `Route:/orders`.
    expect(sources.has(generateId('Route', routeNodeKey('GET', '/orders')))).toBe(true);
    expect(sources.has(generateId('Route', routeNodeKey('POST', '/orders')))).toBe(true);
    // The pre-#2289 URL-only id must NOT be used.
    expect(sources.has(generateId('Route', '/orders'))).toBe(false);
  });
});
