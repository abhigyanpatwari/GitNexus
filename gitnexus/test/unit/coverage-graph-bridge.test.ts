import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { writeCoverageToGraph, removeCoverageFromGraph, type BranchMappingResult } from '../../src/core/coverage/graph-bridge.js';

describe('writeCoverageToGraph', () => {
  it('creates a CoverageRun node with correct metadata', () => {
    const graph = createKnowledgeGraph();
    const runMeta = { id: 'run-1', timestamp: '2026-01-01T00:00:00Z', label: 'test-run' };

    const symbolUpdates = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
    writeCoverageToGraph({ runMeta, symbolUpdates }, graph);

    const runNode = graph.getNode('CoverageRun:run-1');
    expect(runNode).toBeDefined();
    expect(runNode!.label).toBe('CoverageRun');
    expect(runNode!.properties.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(runNode!.properties.label).toBe('test-run');
  });

  it('creates COVERED_BY edges for covered symbols', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const runMeta = { id: 'run-1', timestamp: '2026-01-01T00:00:00Z' };
    const symbolUpdates = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
    symbolUpdates.set('Function:foo', { totalLines: 10, coveredLines: 5, ratio: 0.5 });

    writeCoverageToGraph({ runMeta, symbolUpdates }, graph);

    const rel = graph.relationships.find(r => r.type === 'COVERED_BY' && r.sourceId === 'Function:foo');
    expect(rel).toBeDefined();
    expect(rel!.targetId).toBe('CoverageRun:run-1');
  });

  it('sets coverageRatio and lastCoveredAt on covered nodes', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const runMeta = { id: 'run-1', timestamp: '2026-01-01T00:00:00Z' };
    const symbolUpdates = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
    symbolUpdates.set('Function:foo', { totalLines: 10, coveredLines: 5, ratio: 0.5 });

    writeCoverageToGraph({ runMeta, symbolUpdates }, graph);

    const node = graph.getNode('Function:foo');
    expect(node!.properties.coverageRatio).toBe(0.5);
    expect(node!.properties.lastCoveredAt).toBe('2026-01-01T00:00:00Z');
  });

  it('aggregates branch coverage on nodes', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const runMeta = { id: 'run-1', timestamp: '2026-01-01T00:00:00Z' };
    const symbolUpdates = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
    const branchResults: BranchMappingResult[] = [
      { nodeId: 'Function:foo', branchId: '5:0', hitCount: 3, relatedEdges: [] },
      { nodeId: 'Function:foo', branchId: '5:1', hitCount: 0, relatedEdges: [] },
      { nodeId: 'Function:foo', branchId: '7:0', hitCount: 1, relatedEdges: [] },
    ];

    writeCoverageToGraph({ runMeta, symbolUpdates, branchResults }, graph);

    const node = graph.getNode('Function:foo');
    expect(node!.properties.branchCoverage).toEqual({ total: 3, covered: 2 });
  });

  it('computes aggregate totals on CoverageRun node', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 1, endLine: 20 },
    });

    const runMeta = { id: 'run-1', timestamp: '2026-01-01T00:00:00Z' };
    const symbolUpdates = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
    symbolUpdates.set('Function:foo', { totalLines: 10, coveredLines: 5, ratio: 0.5 });
    symbolUpdates.set('Function:bar', { totalLines: 20, coveredLines: 15, ratio: 0.75 });

    writeCoverageToGraph({ runMeta, symbolUpdates }, graph);

    const runNode = graph.getNode('CoverageRun:run-1');
    expect(runNode!.properties.totalLines).toBe(30);
    expect(runNode!.properties.coveredLines).toBe(20);
    expect(runNode!.properties.coverageRatio).toBeCloseTo(20 / 30);
  });
});

describe('removeCoverageFromGraph', () => {
  it('removes CoverageRun node and COVERED_BY edges', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const runMeta = { id: 'run-1', timestamp: '2026-01-01T00:00:00Z' };
    const symbolUpdates = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
    symbolUpdates.set('Function:foo', { totalLines: 10, coveredLines: 5, ratio: 0.5 });

    writeCoverageToGraph({ runMeta, symbolUpdates }, graph);
    expect(graph.getNode('CoverageRun:run-1')).toBeDefined();
    expect(graph.relationships.some(r => r.type === 'COVERED_BY')).toBe(true);

    removeCoverageFromGraph('run-1', graph);

    expect(graph.getNode('CoverageRun:run-1')).toBeUndefined();
    expect(graph.relationships.some(r => r.type === 'COVERED_BY')).toBe(false);
  });

  it('clears coverage properties from symbol nodes', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 1, endLine: 10 },
    });

    const runMeta = { id: 'run-1', timestamp: '2026-01-01T00:00:00Z' };
    const symbolUpdates = new Map<string, { totalLines: number; coveredLines: number; ratio: number }>();
    symbolUpdates.set('Function:foo', { totalLines: 10, coveredLines: 5, ratio: 0.5 });
    const branchResults: BranchMappingResult[] = [
      { nodeId: 'Function:foo', branchId: '5:0', hitCount: 3, relatedEdges: [] },
    ];

    writeCoverageToGraph({ runMeta, symbolUpdates, branchResults }, graph);
    const nodeBefore = graph.getNode('Function:foo');
    expect(nodeBefore!.properties.coverageRatio).toBe(0.5);
    expect(nodeBefore!.properties.branchCoverage).toEqual({ total: 1, covered: 1 });

    removeCoverageFromGraph('run-1', graph);

    const nodeAfter = graph.getNode('Function:foo');
    expect(nodeAfter!.properties.coverageRatio).toBeUndefined();
    expect(nodeAfter!.properties.lastCoveredAt).toBeUndefined();
    expect(nodeAfter!.properties.branchCoverage).toBeUndefined();
  });
});
