import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { mapCoveredEdges, updateEdgeTraversalCounts } from '../../src/core/coverage/edge-mapper.js';

describe('mapCoveredEdges', () => {
  it('maps a CALLS edge when both source and target are covered', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 10 },
    });
    graph.addRelationship({
      id: 'CALLS:foo->bar',
      sourceId: 'Function:foo',
      targetId: 'Function:bar',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    const coveredNodeIds = new Set(['Function:foo', 'Function:bar']);
    const results = mapCoveredEdges(coveredNodeIds, graph, 'run-1');

    expect(results).toHaveLength(1);
    expect(results[0].edgeId).toBe('CALLS:foo->bar');
    expect(results[0].sourceNodeId).toBe('Function:foo');
    expect(results[0].targetNodeId).toBe('Function:bar');
    expect(results[0].runId).toBe('run-1');
  });

  it('skips edges where source is not covered', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 10 },
    });
    graph.addRelationship({
      id: 'CALLS:foo->bar',
      sourceId: 'Function:foo',
      targetId: 'Function:bar',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    // Only target is covered, source is not
    const coveredNodeIds = new Set(['Function:bar']);
    const results = mapCoveredEdges(coveredNodeIds, graph, 'run-1');

    expect(results).toHaveLength(0);
  });

  it('skips edges where target is not covered', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 10 },
    });
    graph.addRelationship({
      id: 'CALLS:foo->bar',
      sourceId: 'Function:foo',
      targetId: 'Function:bar',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    // Only source is covered, target is not
    const coveredNodeIds = new Set(['Function:foo']);
    const results = mapCoveredEdges(coveredNodeIds, graph, 'run-1');

    expect(results).toHaveLength(0);
  });

  it('skips non-CALLS relationships', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:A',
      label: 'Class',
      properties: { name: 'A', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Class:B',
      label: 'Class',
      properties: { name: 'B', filePath: 'src/b.ts', startLine: 1, endLine: 10 },
    });
    graph.addRelationship({
      id: 'EXTENDS:A->B',
      sourceId: 'Class:A',
      targetId: 'Class:B',
      type: 'EXTENDS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    const coveredNodeIds = new Set(['Class:A', 'Class:B']);
    const results = mapCoveredEdges(coveredNodeIds, graph, 'run-1');

    expect(results).toHaveLength(0);
  });
});

describe('updateEdgeTraversalCounts', () => {
  it('increments traverseCount and records runId', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 10 },
    });
    graph.addRelationship({
      id: 'CALLS:foo->bar',
      sourceId: 'Function:foo',
      targetId: 'Function:bar',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    const edgeTraversals = [
      { runId: 'run-1', edgeId: 'CALLS:foo->bar', sourceNodeId: 'Function:foo', targetNodeId: 'Function:bar', hitCount: 1 },
    ];
    updateEdgeTraversalCounts(edgeTraversals, graph, 'run-1');

    const rel = graph.relationships.find(r => r.id === 'CALLS:foo->bar')!;
    expect((rel as any).traverseCount).toBe(1);
    expect((rel as any).traversedInRuns).toEqual(['run-1']);
  });

  it('accumulates traverseCount across multiple runs', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 10 },
    });
    graph.addRelationship({
      id: 'CALLS:foo->bar',
      sourceId: 'Function:foo',
      targetId: 'Function:bar',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    // First run
    const edgeTraversals1 = [
      { runId: 'run-1', edgeId: 'CALLS:foo->bar', sourceNodeId: 'Function:foo', targetNodeId: 'Function:bar', hitCount: 1 },
    ];
    updateEdgeTraversalCounts(edgeTraversals1, graph, 'run-1');

    // Second run
    const edgeTraversals2 = [
      { runId: 'run-2', edgeId: 'CALLS:foo->bar', sourceNodeId: 'Function:foo', targetNodeId: 'Function:bar', hitCount: 1 },
    ];
    updateEdgeTraversalCounts(edgeTraversals2, graph, 'run-2');

    const rel = graph.relationships.find(r => r.id === 'CALLS:foo->bar')!;
    expect((rel as any).traverseCount).toBe(2);
    expect((rel as any).traversedInRuns).toEqual(['run-1', 'run-2']);
  });

  it('does not duplicate runId in traversedInRuns', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 10 },
    });
    graph.addRelationship({
      id: 'CALLS:foo->bar',
      sourceId: 'Function:foo',
      targetId: 'Function:bar',
      type: 'CALLS',
      confidence: 1.0,
      reason: 'test',
      step: 0,
    });

    // Same run twice
    const edgeTraversals = [
      { runId: 'run-1', edgeId: 'CALLS:foo->bar', sourceNodeId: 'Function:foo', targetNodeId: 'Function:bar', hitCount: 1 },
    ];
    updateEdgeTraversalCounts(edgeTraversals, graph, 'run-1');
    updateEdgeTraversalCounts(edgeTraversals, graph, 'run-1');

    const rel = graph.relationships.find(r => r.id === 'CALLS:foo->bar')!;
    expect((rel as any).traverseCount).toBe(2);
    expect((rel as any).traversedInRuns).toEqual(['run-1']);
  });
});
