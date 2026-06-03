import { describe, it, expect } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { mapLinesToNodes, aggregateSymbolCoverage } from '../../src/core/coverage/line-mapper.js';

describe('mapLinesToNodes', () => {
  it('maps a line to a function node', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
    });

    const lineHits = new Map([['src/a.ts', new Map([[15, 5]])]]);
    const results = mapLinesToNodes(lineHits, graph);

    expect(results).toHaveLength(1);
    expect(results[0].matchedNodes[0]).toBe('Function:foo');
    expect(results[0].hitCount).toBe(5);
  });

  it('selects the most specific node (tightest range)', () => {
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

    const lineHits = new Map([['src/a.ts', new Map([[15, 5]])]]);
    const results = mapLinesToNodes(lineHits, graph);

    expect(results[0].matchedNodes[0]).toBe('Method:bar');
    expect(results[0].matchedNodes[1]).toBe('Class:Baz');
  });

  it('skips lines outside any node range', () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'Function:foo',
      label: 'Function',
      properties: { name: 'foo', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
    });

    const lineHits = new Map([['src/a.ts', new Map([[5, 3]])]]);
    const results = mapLinesToNodes(lineHits, graph);
    expect(results).toHaveLength(0);
  });
});

describe('aggregateSymbolCoverage', () => {
  it('computes per-symbol coverage ratio', () => {
    const mappings = [
      { lineNumber: 10, filePath: 'src/a.ts', hitCount: 5, matchedNodes: ['Function:foo'] },
      { lineNumber: 11, filePath: 'src/a.ts', hitCount: 0, matchedNodes: ['Function:foo'] },
      { lineNumber: 12, filePath: 'src/a.ts', hitCount: 3, matchedNodes: ['Function:foo'] },
    ];

    const result = aggregateSymbolCoverage(mappings);
    expect(result.get('Function:foo')!.totalLines).toBe(3);
    expect(result.get('Function:foo')!.coveredLines).toBe(2);
  });
});
