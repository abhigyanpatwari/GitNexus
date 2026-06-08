import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { mapBranches } from '../../src/core/coverage/branch-mapper.js';
import type { BranchHitRecord } from '../../src/core/coverage/types.js';

describe('mapBranches', () => {
  it('maps a branch hit to a containing node', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
    });

    const branchHits: BranchHitRecord[] = [
      { runId: 'run-1', filePath: 'src/a.ts', lineNumber: 15, branchId: '15:0', hitCount: 5 },
    ];
    const results = mapBranches(branchHits, graph);

    expect(results).toHaveLength(1);
    expect(results[0].nodeId).toBe('Function:foo');
    expect(results[0].branchId).toBe('15:0');
    expect(results[0].hitCount).toBe(5);
  });

  it('skips branches in files with no matching nodes', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
    });

    const branchHits: BranchHitRecord[] = [
      { runId: 'run-1', filePath: 'src/other.ts', lineNumber: 15, branchId: '15:0', hitCount: 5 },
    ];
    const results = mapBranches(branchHits, graph);

    expect(results).toHaveLength(0);
  });

  it('associates CALLS edges with the branch', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
    });
    graph.addNode({
      id: 'Function:bar',
      label: 'Function',
      properties: { name: 'bar', filePath: 'src/b.ts', startLine: 5, endLine: 15 },
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

    const branchHits: BranchHitRecord[] = [
      { runId: 'run-1', filePath: 'src/a.ts', lineNumber: 15, branchId: '15:0', hitCount: 5 },
    ];
    const results = mapBranches(branchHits, graph);

    expect(results).toHaveLength(1);
    expect(results[0].relatedEdges).toContain('CALLS:foo->bar');
  });

  it('selects the most specific (innermost) node for nested ranges', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Class:Baz',
      label: 'Class',
      properties: { name: 'Baz', filePath: 'src/a.ts', startLine: 5, endLine: 100 },
    });
    graph.addNode({
      id: 'Method:bar',
      label: 'Method',
      properties: { name: 'bar', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
    });

    const branchHits: BranchHitRecord[] = [
      { runId: 'run-1', filePath: 'src/a.ts', lineNumber: 15, branchId: '15:0', hitCount: 5 },
    ];
    const results = mapBranches(branchHits, graph);

    expect(results).toHaveLength(1);
    // Method:bar (range 10-20) is more specific than Class:Baz (range 5-100)
    expect(results[0].nodeId).toBe('Method:bar');
  });
});
