import { describe, it, expect, vi } from 'vitest';
import {
  knowledgeGraphToGraphology,
  knowledgeGraphToTreeGraphology,
  knowledgeGraphToCirclesGraphology,
} from './graph-adapter';
import type { KnowledgeGraph } from '../core/graph/types';
import type { GraphNode } from 'gitnexus-shared';
import { COMMUNITY_COLORS, EDGE_INFO, NODE_COLORS } from './constants';

function makeNode(id: string, label: string, name: string): GraphNode {
  return {
    id,
    label: label as any,
    properties: { name, filePath: '', startLine: 1, endLine: 1 },
  };
}

describe('opaque community identities', () => {
  const communityGraph = (ids: string[]): KnowledgeGraph => ({
    nodes: ids.flatMap((id) => [
      makeNode(id, 'Community', id),
      makeNode(`member:${id}`, 'Function', `member:${id}`),
    ]),
    relationships: ids.map((id) => ({
      id: `membership:${id}`,
      type: 'MEMBER_OF',
      sourceId: `member:${id}`,
      targetId: id,
    })),
  });

  it('keeps hashed and suffixed communities distinct when deriving memberships', () => {
    const ids = ['comm_abcdef123456', 'comm_abcdef123456_2', 'comm_123456789012'];
    const result = knowledgeGraphToGraphology(communityGraph(ids));
    for (const id of ids) {
      const attributes = result.getNodeAttributes(`member:${id}`);
      expect(attributes.community).toBe(id);
      expect(attributes.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(Number.isFinite(attributes.x)).toBe(true);
      expect(Number.isFinite(attributes.y)).toBe(true);
    }
  });

  it('preserves existing colors after an unrelated community is added or reordered', () => {
    const ids = ['comm_abcd01234567', 'comm_bcde01234567'];
    const before = knowledgeGraphToGraphology(communityGraph(ids));
    const after = knowledgeGraphToGraphology(
      communityGraph(['comm_aaaa01234567', ...ids.toReversed()]),
    );
    for (const id of ids) {
      const member = `member:${id}`;
      expect(after.getNodeAttribute(member, 'community')).toBe(id);
      expect(after.getNodeAttribute(member, 'color')).toBe(
        before.getNodeAttribute(member, 'color'),
      );
    }
  });

  it('ignores missing and non-Community membership targets', () => {
    const graph = communityGraph(['comm_abcdef123456']);
    graph.nodes.push(
      makeNode('orphan', 'Function', 'orphan'),
      makeNode('wrong', 'Function', 'wrong'),
    );
    graph.relationships.push(
      { id: 'missing', type: 'MEMBER_OF', sourceId: 'orphan', targetId: 'comm_missing' },
      { id: 'non-community', type: 'MEMBER_OF', sourceId: 'wrong', targetId: 'orphan' },
    );
    const result = knowledgeGraphToGraphology(graph);
    expect(result.getNodeAttribute('orphan', 'community')).toBeUndefined();
    expect(result.getNodeAttribute('wrong', 'community')).toBeUndefined();
  });

  it('preserves legacy colors and explicit numeric membership maps', () => {
    const graph = communityGraph(['comm_1']);
    const legacy = knowledgeGraphToGraphology(graph);
    const explicit = knowledgeGraphToGraphology(graph, new Map([['member:comm_1', 1]]));
    expect(legacy.getNodeAttribute('member:comm_1', 'color')).toBe(COMMUNITY_COLORS[1]);
    expect(explicit.getNodeAttribute('member:comm_1', 'community')).toBe(1);
    expect(explicit.getNodeAttribute('member:comm_1', 'color')).toBe(COMMUNITY_COLORS[1]);
  });

  it('keeps type coloring for a non-symbol community member', () => {
    const graph = communityGraph(['comm_1']);
    graph.nodes[1].label = 'File';
    const result = knowledgeGraphToGraphology(graph);
    expect(result.getNodeAttributes('member:comm_1')).toMatchObject({
      community: 'comm_1',
      communityColor: COMMUNITY_COLORS[1],
      color: NODE_COLORS.File,
    });
  });
});

it('seeds descendants breadth-first even when input nodes put children first', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.75);
  try {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('leaf', 'Function', 'leaf'),
        makeNode('child', 'Class', 'child'),
        makeNode('sibling', 'File', 'sibling'),
        makeNode('parent', 'File', 'parent'),
        makeNode('root', 'Folder', 'root'),
      ],
      relationships: [
        { id: 'r1', type: 'CONTAINS', sourceId: 'root', targetId: 'parent' },
        { id: 'r2', type: 'CONTAINS', sourceId: 'root', targetId: 'sibling' },
        { id: 'r3', type: 'DEFINES', sourceId: 'parent', targetId: 'child' },
        { id: 'r4', type: 'DEFINES', sourceId: 'child', targetId: 'leaf' },
      ],
    };
    const result = knowledgeGraphToGraphology(graph);
    expect(result.nodes()).toEqual(['root', 'parent', 'sibling', 'child', 'leaf']);
    const offset = Math.sqrt(graph.nodes.length) * 3 * 0.25;
    for (const [child, parent] of [
      ['parent', 'root'],
      ['sibling', 'root'],
      ['child', 'parent'],
      ['leaf', 'child'],
    ]) {
      for (const axis of ['x', 'y']) {
        expect(result.getNodeAttribute(child, axis)).toBeCloseTo(
          result.getNodeAttribute(parent, axis) + offset,
        );
      }
    }
  } finally {
    random.mockRestore();
  }
});

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

    // MultiGraph allows multiple edges per pair — both CONTAINS and CALLS must survive.
    expect(sigmaGraph.size).toBe(2);

    const attrsByType = new Map<string, { isHierarchyEdge?: boolean; color: string }>();
    sigmaGraph.forEachEdge((_edge, attrs) => {
      attrsByType.set(attrs.relationType, attrs);
    });

    const containsAttrs = attrsByType.get('CONTAINS');
    expect(containsAttrs).toBeDefined();
    expect(containsAttrs!.isHierarchyEdge).toBe(true);
    expect(containsAttrs!.color).toBe(EDGE_INFO.CONTAINS.color);

    const callsAttrs = attrsByType.get('CALLS');
    expect(callsAttrs).toBeDefined();
    expect(callsAttrs!.isHierarchyEdge).toBe(false);
    expect(callsAttrs!.color).toBe(EDGE_INFO.CALLS.color);
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

  it('should handle a medium-sized graph without dropping nodes or edges', () => {
    // 2000 nodes + 4000 edges — exercises the adaptive spring iteration path (14 iters).
    // Structural assertion only: wall-clock timing is too variable across CI machines.
    const nodes: GraphNode[] = Array.from({ length: 2000 }, (_, i) =>
      makeNode(`n${i}`, i % 4 === 0 ? 'Folder' : i % 4 === 1 ? 'File' : 'Function', `node${i}`),
    );
    const relationships = Array.from({ length: 4000 }, (_, i) => ({
      id: `r${i}`,
      type: i % 3 === 0 ? 'CONTAINS' : 'CALLS',
      sourceId: `n${i % 2000}`,
      targetId: `n${(i + 7) % 2000}`,
    }));
    const graph: KnowledgeGraph = { nodes, relationships };

    const sigmaGraph = knowledgeGraphToTreeGraphology(graph);

    // All nodes that have a tree-layout position must be present in the output.
    expect(sigmaGraph.order).toBe(2000);
    // Every relationship whose source and target both exist should produce an edge.
    // Self-loops (sourceId === targetId) are excluded — the adapter skips them.
    const selfLoops = relationships.filter((r) => r.sourceId === r.targetId).length;
    expect(sigmaGraph.size).toBe(relationships.length - selfLoops);
  });
});

describe('knowledgeGraphToCirclesGraphology', () => {
  it('should place nodes into ring positions based on their type', () => {
    const graph: KnowledgeGraph = {
      nodes: [
        makeNode('folder', 'Folder', 'src'),
        makeNode('file', 'File', 'main.ts'),
        makeNode('fn', 'Function', 'doSomething'),
      ],
      relationships: [
        { id: 'r1', type: 'CONTAINS', sourceId: 'folder', targetId: 'file' },
        { id: 'r2', type: 'CALLS', sourceId: 'file', targetId: 'fn' },
      ],
    };

    const sigmaGraph = knowledgeGraphToCirclesGraphology(graph);

    expect(sigmaGraph.hasNode('folder')).toBe(true);
    expect(sigmaGraph.hasNode('file')).toBe(true);
    expect(sigmaGraph.hasNode('fn')).toBe(true);

    // Each node carries its ring index and anchor coordinates
    const folderAttrs = sigmaGraph.getNodeAttributes('folder');
    const fileAttrs = sigmaGraph.getNodeAttributes('file');
    const fnAttrs = sigmaGraph.getNodeAttributes('fn');

    expect(typeof folderAttrs.circlesRing).toBe('number');
    expect(typeof folderAttrs.circlesAnchorX).toBe('number');
    expect(typeof folderAttrs.circlesAnchorY).toBe('number');

    // Folders/Packages live in ring 0 (innermost); Files in ring 1; Functions in ring 3.
    expect(folderAttrs.circlesRing).toBe(0);
    expect(fileAttrs.circlesRing).toBe(1);
    expect(fnAttrs.circlesRing).toBe(3);

    // Tree anchor attributes must NOT be set in circles mode
    expect(folderAttrs.treeAnchorX).toBeUndefined();
    expect(folderAttrs.treeAnchorY).toBeUndefined();
  });

  it('should style hierarchy edges differently from cross-cutting edges', () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNode('a', 'File', 'a.ts'), makeNode('b', 'Function', 'fn')],
      relationships: [
        { id: 'r1', type: 'CONTAINS', sourceId: 'a', targetId: 'b' },
        { id: 'r2', type: 'CALLS', sourceId: 'a', targetId: 'b' },
      ],
    };

    // MultiGraph allows multiple edges per pair — both CONTAINS and CALLS must survive.
    const sigmaGraph = knowledgeGraphToCirclesGraphology(graph);

    expect(sigmaGraph.size).toBe(2);

    const attrsByType = new Map<string, { isHierarchyEdge?: boolean; color: string }>();
    sigmaGraph.forEachEdge((_, attrs) => {
      attrsByType.set(attrs.relationType, attrs);
    });

    const containsAttrs = attrsByType.get('CONTAINS');
    expect(containsAttrs).toBeDefined();
    expect(containsAttrs!.isHierarchyEdge).toBe(true);
    expect(containsAttrs!.color).toBe(EDGE_INFO.CONTAINS.color);

    const callsAttrs = attrsByType.get('CALLS');
    expect(callsAttrs).toBeDefined();
    expect(callsAttrs!.isHierarchyEdge).toBe(false);
    expect(callsAttrs!.color).toBe(EDGE_INFO.CALLS.color);
  });

  it('should treat CALLS as a cross-cutting edge in circles view', () => {
    const graph: KnowledgeGraph = {
      nodes: [makeNode('a', 'Function', 'fnA'), makeNode('b', 'Function', 'fnB')],
      relationships: [{ id: 'r1', type: 'CALLS', sourceId: 'a', targetId: 'b' }],
    };

    const sigmaGraph = knowledgeGraphToCirclesGraphology(graph);

    sigmaGraph.forEachEdge((_, attrs) => {
      expect(attrs.isHierarchyEdge).toBe(false);
      expect(attrs.color).toBe(EDGE_INFO.CALLS.color);
    });
  });
});
