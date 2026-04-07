import { describe, it, expect, vi } from 'vitest';
import { resolveDocImplementations } from '../../src/core/ingestion/doc-resolver.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { ResolutionContext } from '../../src/core/ingestion/resolution-context.js';
import type { PendingResolution } from '../../src/core/ingestion/markdown-processor.js';

/**
 * Create a minimal mock ResolutionContext with controllable lookupFuzzyCallable behavior.
 */
const createMockContext = (
  callableMap: Record<string, Array<{ nodeId: string; label: string; filePath: string }>>
): ResolutionContext => {
  return {
    symbols: {
      lookupFuzzyCallable: (name: string) => callableMap[name] || [],
      // Stub other SymbolTable methods as needed
      register: vi.fn(),
      lookup: vi.fn().mockReturnValue([]),
      lookupByFile: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
      size: 0,
    },
  } as unknown as ResolutionContext;
};

describe('resolveDocImplementations', () => {
  it('should create IMPLEMENTS edge when pseudocode function name matches real function', () => {
    const graph = createKnowledgeGraph();
    const ctx = createMockContext({
      buildNamespaceMap: [{ nodeId: 'Function:src/detector.ts:buildNamespaceMap', label: 'Function', filePath: 'src/detector.ts' }],
    });
    const pending: PendingResolution[] = [
      { source: 'CodeElement:plan.md:10-20', name: 'buildNamespaceMap', step: 1, sourceContext: 'plan.md' },
    ];

    const resolved = resolveDocImplementations(graph, ctx, pending);

    expect(resolved).toBe(1);
    const implEdges = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
    expect(implEdges).toHaveLength(1);
    expect(implEdges[0].sourceId).toBe('CodeElement:plan.md:10-20');
    expect(implEdges[0].targetId).toBe('Function:src/detector.ts:buildNamespaceMap');
    expect(implEdges[0].confidence).toBe(0.95);
    expect(implEdges[0].reason).toBe('pseudocode-to-real-code');
  });

  it('should NOT create edge when no matching real function exists', () => {
    const graph = createKnowledgeGraph();
    const ctx = createMockContext({}); // Empty — nothing matches
    const pending: PendingResolution[] = [
      { source: 'CodeElement:plan.md:1-5', name: 'nonExistentFunc', step: 1, sourceContext: 'plan.md' },
    ];

    const resolved = resolveDocImplementations(graph, ctx, pending);

    expect(resolved).toBe(0);
    expect(graph.relationships).toHaveLength(0);
  });

  it('should handle multiple pseudocode symbols matching multiple functions', () => {
    const graph = createKnowledgeGraph();
    const ctx = createMockContext({
      funcA: [{ nodeId: 'Function:src/a.ts:funcA', label: 'Function', filePath: 'src/a.ts' }],
      funcB: [{ nodeId: 'Method:src/b.ts:funcB', label: 'Method', filePath: 'src/b.ts' }],
    });
    const pending: PendingResolution[] = [
      { source: 'CodeElement:design.md:10-20', name: 'funcA', step: 1, sourceContext: 'design.md' },
      { source: 'CodeElement:design.md:30-40', name: 'funcB', step: 2, sourceContext: 'design.md' },
    ];

    const resolved = resolveDocImplementations(graph, ctx, pending);

    expect(resolved).toBe(2);
    const implEdges = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
    expect(implEdges).toHaveLength(2);
  });

  it('should set lower confidence when multiple candidates match same name', () => {
    const graph = createKnowledgeGraph();
    const ctx = createMockContext({
      processData: [
        { nodeId: 'Function:src/a.ts:processData', label: 'Function', filePath: 'src/a.ts' },
        { nodeId: 'Method:src/b.ts:processData', label: 'Method', filePath: 'src/b.ts' },
      ],
    });
    const pending: PendingResolution[] = [
      { source: 'CodeElement:spec.md:5-15', name: 'processData', step: 1, sourceContext: 'spec.md' },
    ];

    const resolved = resolveDocImplementations(graph, ctx, pending);

    expect(resolved).toBe(2); // 2 edges for 2 candidates
    const implEdges = graph.relationships.filter(r => r.type === 'IMPLEMENTS');
    expect(implEdges).toHaveLength(2);
    // Ambiguous = 0.85 confidence
    for (const edge of implEdges) {
      expect(edge.confidence).toBe(0.85);
    }
  });

  it('should return 0 when pendingResolutions is empty', () => {
    const graph = createKnowledgeGraph();
    const ctx = createMockContext({});

    const resolved = resolveDocImplementations(graph, ctx, []);

    expect(resolved).toBe(0);
    expect(graph.relationships).toHaveLength(0);
  });

  it('should set step from pending resolution', () => {
    const graph = createKnowledgeGraph();
    const ctx = createMockContext({
      myFunc: [{ nodeId: 'Function:src/f.ts:myFunc', label: 'Function', filePath: 'src/f.ts' }],
    });
    const pending: PendingResolution[] = [
      { source: 'CodeElement:doc.md:1-5', name: 'myFunc', step: 7, sourceContext: 'doc.md' },
    ];

    resolveDocImplementations(graph, ctx, pending);

    const edge = graph.relationships[0];
    expect(edge.step).toBe(7);
  });
});
