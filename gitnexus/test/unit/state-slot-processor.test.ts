/**
 * Unit tests for state-slot-processor.ts
 *
 * Tests Task 17 (route-to-cache chaining) and Task 18 (wrapper hook resolution).
 */
import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processStateSlots } from '../../src/core/ingestion/state-slot-processor.js';
import { generateId } from '../../src/lib/utils.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../../src/core/graph/types.js';
import type { ExtractedStateSlot } from '../../src/core/ingestion/state-slot-detectors/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addFunctionNode(graph: KnowledgeGraph, filePath: string, name: string): string {
  const id = generateId('Function', `${filePath}:${name}`);
  graph.addNode({ id, label: 'Function', properties: { name, filePath, startLine: 1 } });
  return id;
}

function addRouteNode(graph: KnowledgeGraph, name: string, responseKeys: string[]): string {
  const id = generateId('Route', name);
  graph.addNode({ id, label: 'Route', properties: { name, filePath: 'src/api/route.ts', responseKeys } });
  return id;
}

function addFetchesEdge(graph: KnowledgeGraph, sourceId: string, targetId: string): void {
  graph.addRelationship({
    id: generateId('FETCHES', `${sourceId}->${targetId}`),
    sourceId,
    targetId,
    type: 'FETCHES',
    confidence: 0.8,
    reason: 'ast-literal',
  });
}

function addCallsEdge(graph: KnowledgeGraph, sourceId: string, targetId: string): void {
  graph.addRelationship({
    id: generateId('CALLS', `${sourceId}->${targetId}`),
    sourceId,
    targetId,
    type: 'CALLS',
    confidence: 1.0,
    reason: 'direct',
  });
}

function makeSlot(overrides: Partial<ExtractedStateSlot> = {}): ExtractedStateSlot {
  return {
    name: "['vendors', id]",
    slotKind: 'react-query',
    cacheKey: "['vendors', id]",
    filePath: 'src/hooks/useVendors.ts',
    lineNumber: 5,
    producers: [{
      functionName: 'useVendors',
      filePath: 'src/hooks/useVendors.ts',
      lineNumber: 5,
      keys: [],
      confidence: 'heuristic',
    }],
    consumers: [],
    ...overrides,
  };
}

function findProducesEdges(graph: KnowledgeGraph): GraphRelationship[] {
  const edges: GraphRelationship[] = [];
  for (const rel of graph.iterRelationships()) {
    if (rel.type === 'PRODUCES') edges.push(rel);
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Task 17: Route-to-Cache Chaining
// ---------------------------------------------------------------------------

describe('chainRoutesToSlots (Task 17)', () => {
  it('copies Route responseKeys to PRODUCES edge with empty keys', () => {
    const graph = createKnowledgeGraph();

    // Set up: Function --FETCHES--> Route (with responseKeys)
    const fnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    const routeId = addRouteNode(graph, '/api/vendors', ['items', 'total', 'page']);
    addFetchesEdge(graph, fnId, routeId);

    // Process a slot whose producer has empty keys
    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    expect(result.routeChainsApplied).toBe(1);

    // The PRODUCES edge should now have keys from the Route
    const produces = findProducesEdges(graph);
    expect(produces.length).toBeGreaterThanOrEqual(1);
    const mainEdge = produces.find(e => e.sourceId === fnId);
    expect(mainEdge).toBeDefined();
    expect(mainEdge!.reason).toContain('keys:items,total,page');
    expect(mainEdge!.reason).toContain('shape-ast-literal');
    expect(mainEdge!.confidence).toBe(0.8); // ast-literal confidence
  });

  it('does not overwrite PRODUCES edge that already has keys', () => {
    const graph = createKnowledgeGraph();

    const fnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    const routeId = addRouteNode(graph, '/api/vendors', ['items', 'total']);
    addFetchesEdge(graph, fnId, routeId);

    // Producer already has keys
    const slot = makeSlot({
      producers: [{
        functionName: 'useVendors',
        filePath: 'src/hooks/useVendors.ts',
        lineNumber: 5,
        keys: ['existingKey'],
        confidence: 'ast-literal',
      }],
    });
    const result = processStateSlots([slot], graph);

    expect(result.routeChainsApplied).toBe(0);

    const produces = findProducesEdges(graph);
    const mainEdge = produces.find(e => e.sourceId === fnId);
    expect(mainEdge!.reason).toContain('keys:existingKey');
  });

  it('returns 0 when no FETCHES edges exist', () => {
    const graph = createKnowledgeGraph();
    addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    expect(result.routeChainsApplied).toBe(0);
  });

  it('skips FETCHES edges to non-Route nodes', () => {
    const graph = createKnowledgeGraph();

    const fnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    // Create a non-Route node with a FETCHES edge
    const otherId = generateId('Function', 'src/api/route.ts:handler');
    graph.addNode({ id: otherId, label: 'Function', properties: { name: 'handler', filePath: 'src/api/route.ts', responseKeys: ['x'] } });
    addFetchesEdge(graph, fnId, otherId);

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    expect(result.routeChainsApplied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 18: Wrapper Hook Resolution
// ---------------------------------------------------------------------------

describe('resolveWrapperHooks (Task 18)', () => {
  it('creates indirect PRODUCES edge for wrapper hook (depth 1)', () => {
    const graph = createKnowledgeGraph();

    const innerFnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    const wrapperFnId = addFunctionNode(graph, 'src/hooks/useWrappedVendors.ts', 'useWrappedVendors');

    // Wrapper calls inner hook
    addCallsEdge(graph, wrapperFnId, innerFnId);

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    expect(result.wrapperHooksResolved).toBe(1);

    const produces = findProducesEdges(graph);
    const wrapperEdge = produces.find(e => e.sourceId === wrapperFnId);
    expect(wrapperEdge).toBeDefined();
    expect(wrapperEdge!.reason).toContain('via:useWrappedVendors');
  });

  it('follows wrapper chains up to depth 2', () => {
    const graph = createKnowledgeGraph();

    const innerFnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    const midFnId = addFunctionNode(graph, 'src/hooks/useMidVendors.ts', 'useMidVendors');
    const outerFnId = addFunctionNode(graph, 'src/hooks/useOuterVendors.ts', 'useOuterVendors');

    addCallsEdge(graph, midFnId, innerFnId);
    addCallsEdge(graph, outerFnId, midFnId);

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    expect(result.wrapperHooksResolved).toBe(2);

    const produces = findProducesEdges(graph);
    expect(produces.find(e => e.sourceId === midFnId)).toBeDefined();
    expect(produces.find(e => e.sourceId === outerFnId)).toBeDefined();
  });

  it('does not follow depth > 2', () => {
    const graph = createKnowledgeGraph();

    const innerFnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    const d1Id = addFunctionNode(graph, 'src/hooks/useD1.ts', 'useD1');
    const d2Id = addFunctionNode(graph, 'src/hooks/useD2.ts', 'useD2');
    const d3Id = addFunctionNode(graph, 'src/hooks/useD3.ts', 'useD3');

    addCallsEdge(graph, d1Id, innerFnId);
    addCallsEdge(graph, d2Id, d1Id);
    addCallsEdge(graph, d3Id, d2Id);

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    // d1 and d2 are within 2 levels, d3 is at level 3 — should not be included
    expect(result.wrapperHooksResolved).toBe(2);

    const produces = findProducesEdges(graph);
    expect(produces.find(e => e.sourceId === d3Id)).toBeUndefined();
  });

  it('only follows callers whose name starts with "use"', () => {
    const graph = createKnowledgeGraph();

    const innerFnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    const hookCaller = addFunctionNode(graph, 'src/hooks/useHookCaller.ts', 'useHookCaller');
    const componentCaller = addFunctionNode(graph, 'src/components/VendorList.tsx', 'VendorList');

    addCallsEdge(graph, hookCaller, innerFnId);
    addCallsEdge(graph, componentCaller, innerFnId);

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    // Only the hook caller should be resolved, not the component
    expect(result.wrapperHooksResolved).toBe(1);

    const produces = findProducesEdges(graph);
    expect(produces.find(e => e.sourceId === hookCaller)).toBeDefined();
    expect(produces.find(e => e.sourceId === componentCaller)).toBeUndefined();
  });

  it('propagates keys from the original PRODUCES edge reason', () => {
    const graph = createKnowledgeGraph();

    const fnId = addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');
    const routeId = addRouteNode(graph, '/api/vendors', ['items', 'total']);
    addFetchesEdge(graph, fnId, routeId);

    const wrapperId = addFunctionNode(graph, 'src/hooks/useWrapped.ts', 'useWrapped');
    addCallsEdge(graph, wrapperId, fnId);

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    // Route chaining should have applied first, then wrapper resolution
    expect(result.routeChainsApplied).toBe(1);
    expect(result.wrapperHooksResolved).toBe(1);

    const produces = findProducesEdges(graph);
    const wrapperEdge = produces.find(e => e.sourceId === wrapperId);
    expect(wrapperEdge).toBeDefined();
    // The wrapper edge should carry the route-chained keys
    expect(wrapperEdge!.reason).toContain('keys:items,total');
  });

  it('returns 0 when no CALLS edges exist', () => {
    const graph = createKnowledgeGraph();
    addFunctionNode(graph, 'src/hooks/useVendors.ts', 'useVendors');

    const slot = makeSlot();
    const result = processStateSlots([slot], graph);

    expect(result.wrapperHooksResolved).toBe(0);
  });
});
