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

// Mirror what `routes.ts` puts on the graph: a Route node carries
// `handlerSymbolId` in its properties when `routeHandlerSymbols` could
// resolve the handler. processes.ts now reads that field off the graph
// node (#2289 review P2), so multi-verb tests must seed it here.
function addRouteNode(
  graph: KnowledgeGraph,
  routeKey: string,
  url: string,
  filePath: string,
  method: string,
  handlerSymbolId: string,
) {
  graph.addNode({
    id: generateId('Route', routeKey),
    label: 'Route',
    properties: { name: url, filePath, method, handlerSymbolId },
  } as GraphNode);
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

  // Regression for #2289 review P2 (weak form): pre-fix the linker built
  // `routesByFile` and fanned every same-file Route to every same-file
  // process, so a same-file `GET /items` + `POST /items` pair where ONLY
  // `listItems` has a detected process would still attach BOTH Route nodes
  // to that single process. Post-fix `routesByHandlerId` keys by the Route
  // node's `handlerSymbolId` (read from graph properties) and only the
  // verb whose handler is the process's entryPoint links — the other verb
  // (with no detected process for its handler) links to nothing.
  it('does not cross-wire same-file sibling verbs when only one handler has a detected process', async () => {
    const graph = createKnowledgeGraph();
    const filePath = 'ItemController.java';
    const listItems = 'Function:ItemController.listItems';
    const createItem = 'Function:ItemController.createItem';
    const helper = 'Function:ItemController.helper';
    const leaf = 'Function:ItemController.leaf';

    addNode(graph, generateId('File', filePath), 'File', 'ItemController.java', filePath);
    addNode(graph, listItems, 'Function', 'listItems', filePath);
    addNode(graph, createItem, 'Function', 'createItem', filePath);
    addNode(graph, helper, 'Function', 'helper', filePath);
    addNode(graph, leaf, 'Function', 'leaf', filePath);
    // Only `listItems` has a 3-step chain → forms a process whose entryPoint
    // is `listItems`. `createItem` has no calls, so no process is rooted there.
    addCall(graph, listItems, helper);
    addCall(graph, helper, leaf);

    // Both routes share /items, distinct verbs. The registry carries
    // url + method only; `handlerSymbolId` lives on the Route graph node
    // (mirrors what routes.ts does — see addRouteNode below).
    const routeRegistry = new Map([
      [
        routeNodeKey('GET', '/items'),
        { filePath, source: 'decorator-GetMapping', url: '/items', method: 'GET' },
      ],
      [
        routeNodeKey('POST', '/items'),
        { filePath, source: 'decorator-PostMapping', url: '/items', method: 'POST' },
      ],
    ]);
    addRouteNode(graph, routeNodeKey('GET', '/items'), '/items', filePath, 'GET', listItems);
    addRouteNode(graph, routeNodeKey('POST', '/items'), '/items', filePath, 'POST', createItem);

    await processesPhase.execute(
      makeCtx(graph),
      new Map([
        ['structure', phaseResult('structure', { totalFiles: 1 })],
        ['communities', phaseResult('communities', { communityResult: { memberships: [] } })],
        ['routes', phaseResult('routes', { routeRegistry })],
        ['tools', phaseResult('tools', { toolDefs: [] })],
      ]),
    );

    const routeEntryEdges = graph.relationships.filter(
      (r) => r.type === 'ENTRY_POINT_OF' && graph.getNode(r.targetId)?.label === 'Process',
    );
    const sources = new Set(routeEntryEdges.map((r) => r.sourceId));
    const getNodeId = generateId('Route', routeNodeKey('GET', '/items'));
    const postNodeId = generateId('Route', routeNodeKey('POST', '/items'));

    // GET → listItems process: the only handler-matched link that should fire.
    expect(sources.has(getNodeId)).toBe(true);
    // POST's handlerSymbolId (createItem on the POST Route node) has no
    // matching process, so POST must link to NOTHING. Pre-fix this would
    // have wrongly attached POST to the listItems process via filePath
    // fan-out.
    expect(sources.has(postNodeId)).toBe(false);
  });

  // Regression for #2289 review P2 (strong form, mirrors reviewer's exact
  // trigger): "one controller file with `GET /items -> listItems()` and
  // `POST /items -> createItem()`, each with its own detected process."
  // Pre-fix `routesByFile` collapses both routes under `ItemController.java`
  // and links every routeKey to every process whose entry is in that file —
  // producing the 4-edge cross-wire (GET→listItemsProc, GET→createItemProc,
  // POST→listItemsProc, POST→createItemProc). Post-fix only the 2 matched
  // edges fire (GET→listItemsProc, POST→createItemProc), and route_map /
  // impact can no longer attribute the POST flow to GET or vice versa.
  it('links each verb to ONLY its own per-handler process when both handlers form distinct processes', async () => {
    const graph = createKnowledgeGraph();
    const filePath = 'ItemController.java';
    const listItems = 'Function:ItemController.listItems';
    const createItem = 'Function:ItemController.createItem';
    const listHelper = 'Function:ItemController.listHelper';
    const listLeaf = 'Function:ItemController.listLeaf';
    const createHelper = 'Function:ItemController.createHelper';
    const createLeaf = 'Function:ItemController.createLeaf';

    addNode(graph, generateId('File', filePath), 'File', 'ItemController.java', filePath);
    addNode(graph, listItems, 'Function', 'listItems', filePath);
    addNode(graph, createItem, 'Function', 'createItem', filePath);
    addNode(graph, listHelper, 'Function', 'listHelper', filePath);
    addNode(graph, listLeaf, 'Function', 'listLeaf', filePath);
    addNode(graph, createHelper, 'Function', 'createHelper', filePath);
    addNode(graph, createLeaf, 'Function', 'createLeaf', filePath);
    // Two independent 3-step chains → two processes, one per verb's handler.
    addCall(graph, listItems, listHelper);
    addCall(graph, listHelper, listLeaf);
    addCall(graph, createItem, createHelper);
    addCall(graph, createHelper, createLeaf);

    const routeRegistry = new Map([
      [
        routeNodeKey('GET', '/items'),
        { filePath, source: 'decorator-GetMapping', url: '/items', method: 'GET' },
      ],
      [
        routeNodeKey('POST', '/items'),
        { filePath, source: 'decorator-PostMapping', url: '/items', method: 'POST' },
      ],
    ]);
    addRouteNode(graph, routeNodeKey('GET', '/items'), '/items', filePath, 'GET', listItems);
    addRouteNode(graph, routeNodeKey('POST', '/items'), '/items', filePath, 'POST', createItem);

    await processesPhase.execute(
      makeCtx(graph),
      new Map([
        ['structure', phaseResult('structure', { totalFiles: 1 })],
        ['communities', phaseResult('communities', { communityResult: { memberships: [] } })],
        ['routes', phaseResult('routes', { routeRegistry })],
        ['tools', phaseResult('tools', { toolDefs: [] })],
      ]),
    );

    const getNodeId = generateId('Route', routeNodeKey('GET', '/items'));
    const postNodeId = generateId('Route', routeNodeKey('POST', '/items'));

    // Resolve each Route → its linked processes' entryPointIds (not the
    // synthetic Process ids), so verb-precision can be asserted without
    // test-level conditionals: filter on edge shape, then map to the
    // target Process node's entryPointId, then bucket by sourceId.
    const routeProcessEdges = graph.relationships.filter(
      (r) =>
        r.type === 'ENTRY_POINT_OF' &&
        (r.sourceId === getNodeId || r.sourceId === postNodeId) &&
        graph.getNode(r.targetId)?.label === 'Process',
    );
    const entriesByRoute = new Map<string, Set<string>>(
      routeProcessEdges.map((r) => [
        r.sourceId,
        new Set([String(graph.getNode(r.targetId)?.properties.entryPointId ?? '')]),
      ]),
    );
    // (Each route here has exactly one matched process, so the Map's
    // last-writer-wins is fine; if the count grows, switch to a reducer.)

    // GET Route links to EXACTLY the listItems-rooted process — not createItem's.
    expect(entriesByRoute.get(getNodeId)).toEqual(new Set([listItems]));
    // POST Route links to EXACTLY the createItem-rooted process — not listItems's.
    expect(entriesByRoute.get(postNodeId)).toEqual(new Set([createItem]));
    // Total route→process edges: 2 (one per verb), not the pre-fix 4-edge cross-wire.
    expect(routeProcessEdges.length).toBe(2);
  });
});
