import { describe, it, expect } from 'vitest';
import { knowledgeGraphToTreeGraphology } from './graph-adapter';
import type { KnowledgeGraph } from '../core/graph/types';
import type { GraphNode } from 'gitnexus-shared';
import { EDGE_INFO } from './constants';

function makeNode(id: string, label: string, name: string): GraphNode {
  return {
    id,
    label: label as any,
    properties: { name, filePath: '', startLine: 1, endLine: 1 },
  };
}

describe('knowledgeGraphToTreeGraphology', () => {
  it('should create a graph with tree layout', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('root', 'Project', 'MyProject'),
        makeNode('folder', 'Folder', 'src'),
        makeNode('file', 'File', 'main.ts'),
      ],
      relationships: [
        { id: 'r1', type: 'CONTAINS', sourceId: 'root', targetId: 'folder' },
        { id: 'r2', type: 'CONTAINS', sourceId: 'folder', targetId: 'file' },
        { id: 'r3', type: 'CALLS', sourceId: 'file', targetId: 'root' },
      ],
    };

    const sigmaGraph = knowledgeGraphToTreeGraphology(graph);

    expect(sigmaGraph.hasNode('root')).toBe(true);
    expect(sigmaGraph.hasNode('folder')).toBe(true);
    expect(sigmaGraph.hasNode('file')).toBe(true);

    const rootAttrs = sigmaGraph.getNodeAttributes('root');
    const folderAttrs = sigmaGraph.getNodeAttributes('folder');
    const fileAttrs = sigmaGraph.getNodeAttributes('file');

    // Tree view is inverted vertically, so files sit above containers.
    expect(fileAttrs.y).toBeLessThan(rootAttrs.y);
    expect(fileAttrs.y).toBeLessThan(folderAttrs.y);

    // Nodes should have reasonable sizes
    expect(rootAttrs.size).toBeGreaterThan(2);
    expect(folderAttrs.size).toBeGreaterThan(2);
    expect(fileAttrs.size).toBeGreaterThan(2);

    expect(rootAttrs.treeAnchorX).toBe(rootAttrs.x);
    expect(rootAttrs.treeAnchorY).toBe(rootAttrs.y);
    expect(rootAttrs.treeLayer).toBe(0);
    expect(fileAttrs.treeLayer).toBe(1);
  });

  it('should style hierarchy edges differently from cross-cutting edges', () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNode('a', 'Function', 'fnA'), makeNode('b', 'Function', 'fnB')],
      relationships: [
        { id: 'r1', type: 'CONTAINS', sourceId: 'a', targetId: 'b' },
        { id: 'r2', type: 'CALLS', sourceId: 'a', targetId: 'b' },
      ],
    };

    const sigmaGraph = knowledgeGraphToTreeGraphology(graph);

    // Find edges and check their attributes
    sigmaGraph.forEachEdge((edge, attrs) => {
      if (attrs.relationType === 'CONTAINS') {
        expect(attrs.isHierarchyEdge).toBe(true);
        expect(attrs.color).toBe(EDGE_INFO.CONTAINS.color);
      } else if (attrs.relationType === 'CALLS') {
        expect(attrs.isHierarchyEdge).toBe(false);
        expect(attrs.color).toBe(EDGE_INFO.CALLS.color);
      }
    });
  });

  it('should treat imports as cross-cutting edges in tree view', () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNode('a', 'File', 'a.ts'), makeNode('b', 'File', 'b.ts')],
      relationships: [{ id: 'r1', type: 'IMPORTS', sourceId: 'a', targetId: 'b' }],
    };

    const sigmaGraph = knowledgeGraphToTreeGraphology(graph);

    sigmaGraph.forEachEdge((edge, attrs) => {
      if (attrs.relationType === 'IMPORTS') {
        expect(attrs.isHierarchyEdge).toBe(false);
        expect(attrs.color).toBe(EDGE_INFO.IMPORTS.color);
      }
    });
  });
});
